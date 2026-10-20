'use strict';

/*
 * An estimate of how much text the conversation you are looking at holds, split into what
 * you sent and what Claude sent back.
 *
 * claude.ai does not publish a token count for a chat, and nothing in the usage endpoint
 * carries one, so this reads the conversation through the same API the page uses and sizes
 * the text itself. That makes it an estimate and it is labelled as one everywhere it is
 * shown: roughly four characters to a token, which is the usual rule of thumb for English
 * prose and drifts on code, other languages, and anything with heavy punctuation. It counts
 * text, so images and files in the chat are not in it.
 */

(() => {
  if (window.__usageMeterTokens) return;
  window.__usageMeterTokens = true;

  const CHARS_PER_TOKEN = 4;

  /** The conversation on screen, from the address bar. */
  function conversationId() {
    const match = /\/chat\/([0-9a-f-]{36})/i.exec(window.location.pathname);
    return match ? match[1] : null;
  }

  function textOf(message) {
    if (!message || typeof message !== 'object') return '';
    if (Array.isArray(message.content)) {
      return message.content
        .map((block) => {
          if (!block || typeof block !== 'object') return '';
          if (typeof block.text === 'string') return block.text;
          // Tool calls and their results are part of what the model read and wrote.
          if (typeof block.input === 'string') return block.input;
          if (block.input && typeof block.input === 'object') return JSON.stringify(block.input);
          if (typeof block.content === 'string') return block.content;
          return '';
        })
        .join('\n');
    }
    return typeof message.text === 'string' ? message.text : '';
  }

  /** { input, output } in estimated tokens for one conversation, or null if it can't be read. */
  async function measure(orgId, conversationUuid) {
    const url =
      `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationUuid)}` +
      '?tree=True&rendering_mode=messages&render_all_tools=false';
    let data;
    try {
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      data = await res.json();
    } catch {
      return null;
    }
    const messages = Array.isArray(data && data.chat_messages) ? data.chat_messages : null;
    if (!messages) return null;

    let input = 0;
    let output = 0;
    for (const message of messages) {
      const size = textOf(message).length;
      if (message && message.sender === 'assistant') output += size;
      else input += size;
    }
    return {
      input: Math.round(input / CHARS_PER_TOKEN),
      output: Math.round(output / CHARS_PER_TOKEN),
      messages: messages.length,
      at: Date.now(),
      conversation: conversationUuid,
    };
  }

  let inFlight = null;
  let cached = null;

  /**
   * The estimate for the conversation on screen. Cached until the chat changes or a reply
   * arrives, so moving around the page costs nothing.
   */
  async function current(orgId, { force = false } = {}) {
    const uuid = conversationId();
    if (!uuid || !orgId) return null;
    if (!force && cached && cached.conversation === uuid) return cached;
    if (inFlight) return inFlight;
    inFlight = measure(orgId, uuid)
      .then((result) => {
        if (result) cached = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function invalidate() {
    cached = null;
  }

  window.__usageMeterTokensApi = { current, invalidate, conversationId };
})();
