'use strict';

/*
 * Runs inside the claude.ai page itself, in the page's own world, and only while "Read Free
 * plan usage from claude.ai" is on in Settings.
 *
 * Why it has to be here: claude.ai answers /api/organizations/<id>/usage for a Free account
 * but puts nothing in it. The figures exist only in the chat stream — each reply carries a
 * `message_limit` event with a `windows` map — so the only way to read them is to watch a
 * reply arrive. No request the extension can make on its own produces them.
 *
 * It wraps window.fetch and reads a *clone* of the response, so the page consumes its own
 * stream exactly as it would have. It never changes a request, a response, or the page, and
 * it posts only usage numbers and a count of the chat requests it saw.
 */

(() => {
  if (window.__usageMeterReader) return;
  window.__usageMeterReader = true;

  const fetchOriginal = window.fetch.bind(window);

  // Deliberately loose. The path has changed shape before (and differs between the chat and
  // other surfaces), and a matcher that is too specific fails silently: no error anywhere,
  // just a meter that never fills.
  const COMPLETION = /\/api\/.*\/(completion|retry_completion)(\?|$)/i;

  // claude.ai's newer chat transport: Connect-RPC, binary protobuf, no SSE to read. Accounts
  // served by it never call /completion at all, so without noticing it here the extension
  // cannot tell "no reply yet" from "replies this cannot read".
  const TIMELINE = /\/claudeai-rpc\/[^?#]*ConversationService\/StreamTimeline(?:[?#]|$)/i;

  function urlOf(input) {
    try {
      const raw =
        typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : input && typeof input.url === 'string' ? input.url
        : '';
      return raw ? new URL(raw, window.location.href).href : '';
    } catch {
      return '';
    }
  }

  function orgOf(url) {
    const match = /\/api\/organizations\/([0-9a-f-]{36})\//i.exec(url);
    return match ? match[1] : null;
  }

  function post(payload) {
    window.postMessage({ source: 'usage-meter-reader', ...payload }, window.location.origin);
  }

  /** The `windows` map, wherever in the event it sits. */
  function findWindows(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return null;
    const windows = value.windows;
    if (windows && typeof windows === 'object' && (windows['5h'] || windows['7d'])) return windows;
    for (const child of Object.values(value)) {
      const found = findWindows(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /** Reads a copy of the reply stream, line by line, and reports any usage it carries. */
  async function readStream(response, orgId) {
    if (!response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          let event;
          try {
            event = JSON.parse(trimmed.slice(5).trim());
          } catch {
            continue;
          }
          const windows = findWindows(event);
          if (windows) post({ windows, orgId });
        }
        if (buffer.length > 1e6) buffer = buffer.slice(-1e5); // keep the tail bounded
      }
    } catch {
      // The page cancelled the reply, or the connection dropped. Nothing to report.
    } finally {
      try {
        reader.cancel();
      } catch {
        /* already closed */
      }
    }
  }

  window.fetch = function (input, init) {
    const result = fetchOriginal(input, init);
    try {
      const url = urlOf(input);
      if (TIMELINE.test(url)) {
        // Seen but unreadable: binary protobuf, which this does not decode. Reported so the
        // extension can say that plainly instead of waiting for a reply that never parses.
        post({ sawChat: 'timeline' });
      } else if (COMPLETION.test(url)) {
        post({ sawChat: 'completion' });
        const orgId = orgOf(url);
        result.then((response) => {
          try {
            readStream(response.clone(), orgId);
          } catch {
            /* body already consumed, or not cloneable */
          }
        }, () => {});
      }
    } catch {
      // Watching usage must never be able to break a request the page is making.
    }
    return result;
  };
})();
