/* Local, conservative contact suggestions. No message text leaves the browser. */
(function (root) {
  'use strict';
  const NAME = "[\\p{L}][\\p{L}’'-]*(?: [\\p{L}][\\p{L}’'-]*){0,3}?";
  const intro = new RegExp(`^(?:(?:hi|hello|hey)[,!]?\\s*)?(?:this is|my name is|i am|i['’]m)\\s+(${NAME})(?:\\s+(?:from|at|with)\\s+([^.!?\\n]{2,90}))?[.!?]?\\s*$`, 'iu');
  const role = /\b(?:i am|i['’]m|i work as)\s+(?:the |an? )?((?:(?:senior|junior|managing|sales|marketing|account|project|operations|product|software|creative)\s+){0,3}(?:CEO|CTO|CFO|COO|CMO|founder|co-founder|director|manager|engineer|designer|consultant|partner)|head of [\p{L} ]{2,35})(?:\s+(?:at|with|for)\s+([^.!?\n]{2,90}))?[.!?]?\s*$/iu;
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const badName = /^(?:the|a|an|from|at|with|economy|interested|looking|available|happy|sorry|sending|sharing|ready|here|there|writing|following|reaching|not)\b/i;

  function suggest(messages, ownEmail = '') {
    const candidates = new Map();
    const add = (field, value, message) => {
      value = value?.trim();
      if (!value) return;
      const key = `${field}:${value.toLowerCase()}`;
      candidates.set(key, { field, value, source: message.text.slice(0, 220), messageId: message.id });
    };
    for (const message of messages) {
      if (message.direction !== 'incoming' || message.forwarded || message.quoted || message.preview) continue;
      // Never interpret URLs, preview headlines, or long pasted articles as identity.
      const text = (message.text || '').trim();
      if (!text || text.length > 600) continue;
      const emails = [...new Set((text.match(emailPattern) || []).map(e => e.toLowerCase()))];
      if (emails.length === 1 && emails[0] !== ownEmail.toLowerCase() &&
          (/^(?:my |our )?e-?mail(?: address)?\s*(?:is|:)/i.test(text) ||
           /\b(?:my email|email me|reach me|contact me|send (?:it|this|the quotation) to)\b/i.test(text) ||
           text.replace(emailPattern, '').replace(/[\s.,;:()<>]/g, '') === '')) {
        add('email', emails[0], message);
      }
      if (/https?:\/\//i.test(text)) continue;
      for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
        const job = line.match(role);
        if (job) {
          add('jobTitle', job[1], message);
          add('company', job[2], message);
          continue;
        }
        const identity = line.match(intro);
        if (identity && !badName.test(identity[1]) && !/\b(?:CEO|manager|founder|director|consultant|engineer|designer)\b/i.test(identity[1])) {
          const parts = identity[1].split(/\s+/);
          add('firstName', parts.shift(), message);
          if (parts.length) add('lastName', parts.join(' '), message);
          add('company', identity[2], message);
        }
        const company = line.match(/^(?:my company is|i work (?:at|for)|company\s*:)\s*([^.!?\n]{2,90})[.!?]?$/i);
        if (company) add('company', company[1], message);
      }
    }
    return [...candidates.values()];
  }

  function readMessages(main) {
    if (!main) return [];
    const rows = [...main.querySelectorAll('[data-id^="false_"], [data-id^="true_"], .message-in, .message-out')];
    const seen = new Set();
    return rows.flatMap(row => {
      const outer = row.closest('[data-id]') || row;
      if (seen.has(outer)) return [];
      seen.add(outer);
      const id = outer.getAttribute('data-id') || '';
      const outgoing = id.startsWith('true_') || outer.matches('.message-out') || !!outer.querySelector('.message-out');
      const incoming = id.startsWith('false_') || outer.matches('.message-in') || !!outer.querySelector('.message-in');
      // Unknown direction is intentionally not eligible for contact suggestions.
      const copy = outer.cloneNode(true);
      const forwarded = !!copy.querySelector('[data-icon*="forwarded"], [data-testid*="forwarded"]');
      copy.querySelectorAll('blockquote, [data-testid*="quoted"], [data-testid*="preview"], [data-testid*="link-preview"], [data-icon], button, .ws-inline-log-btn').forEach(el => el.remove());
      const nodes = [...copy.querySelectorAll('.selectable-text, [data-testid="selectable-text"]')]
        .filter(el => !el.parentElement?.closest('.selectable-text, [data-testid="selectable-text"]'));
      // No full-pane fallback: if WhatsApp changes markup, show no suggestion.
      const text = nodes.map(el => el.textContent).join('\n').trim();
      return text ? [{ id, text, forwarded, direction: outgoing ? 'outgoing' : incoming ? 'incoming' : 'unknown' }] : [];
    });
  }

  function renderTemplate(content, values) {
    const missing = new Set();
    const text = String(content || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (original, key) => {
      const value = values[key.toLowerCase()];
      if (value === undefined || value === null || String(value).trim() === '') { missing.add(key); return original; }
      return String(value);
    });
    return { text, missing: [...missing] };
  }
  const api = { suggest, readMessages, renderTemplate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WhatSyncIntelligence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
