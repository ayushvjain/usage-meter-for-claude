'use strict';

/*
 * Runs inside the claude.ai page itself, in the page's own world, and only when "Read Free
 * plan usage from claude.ai" is turned on in Settings.
 *
 * Why it has to be here: claude.ai answers /api/organizations/<id>/usage for a Free account,
 * but with nothing in it. The figures exist only in the chat stream — each reply carries a
 * `message_limit` event with a `windows` map — so the only way to read them is to watch a
 * reply arrive. There is no request the extension can make on its own that produces them.
 *
 * It wraps window.fetch, and reads a *clone* of the response, so the page consumes its own
 * stream exactly as it would have. It never changes a request, a response, or the page, and
 * it posts only usage numbers to the content script beside it.
 */

(() => {
  if (window.__usageMeterReader) return;
  window.__usageMeterReader = true;

  const fetchOriginal = window.fetch.bind(window);
  const COMPLETION = /\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/[^/]+\/(completion|retry_completion)(\?|$)/i;

  /** The request URL as an absolute string, whatever shape fetch was called with. */
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

  function post(windows, orgId) {
    window.postMessage({ source: 'usage-meter-reader', windows, orgId }, window.location.origin);
  }

  /** Reads a copy of the reply stream, line by line, and reports the first usage it carries. */
  async function readStream(response, orgId) {
    const body = response.body;
    if (!body) return;
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let event;
          try {
            event = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          const windows = findWindows(event);
          if (windows) post(windows, orgId);
        }
        // Keep the tail bounded if a reply ever arrives without newlines.
        if (buffer.length > 1e6) buffer = buffer.slice(-1e5);
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
      if (COMPLETION.test(url)) {
        const orgId = orgOf(url);
        result.then((response) => {
          try {
            readStream(response.clone(), orgId);
          } catch {
            /* the body was already consumed or cannot be cloned */
          }
        }, () => {});
      }
    } catch {
      // Watching usage must never be able to break a request the page is making.
    }
    return result;
  };
})();
