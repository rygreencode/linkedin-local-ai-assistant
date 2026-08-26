/* Context extraction: recipient metadata from the chat header + the last N
   messages in the active thread. Read-only; touches nothing LinkedIn owns. */
(function () {
  const LLA = (globalThis.LLA = globalThis.LLA || {});
  const MAX_MESSAGES = 5;
  const MAX_CHARS = 600;

  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /* "VP of Sales at Tech Corp" -> { title, company } */
  function splitHeadline(headline) {
    if (!headline) return { title: '', company: '' };
    const m = headline.split(/\s+(?:at|@)\s+/i);
    if (m.length >= 2) {
      return { title: m[0].trim(), company: m.slice(1).join(' at ').trim() };
    }
    return { title: headline.trim(), company: '' };
  }

  function isFromThem(node, recipientName) {
    const cls = node.className || '';
    if (typeof cls === 'string' && cls.includes('--other')) return true;
    const sender = text(node.querySelector('.msg-s-message-group__name, .msg-s-message-group__profile-link'));
    if (sender && recipientName) {
      return sender.toLowerCase().includes(recipientName.toLowerCase().split(' ')[0]);
    }
    return null; // unknown — caller treats as ambiguous
  }

  LLA.scrapeContext = function () {
    const nameHit = LLA.resolve('headerName');
    const subHit = LLA.resolve('headerSubtitle');
    const name = text(nameHit?.el);
    const headline = text(subHit?.el);
    const { title, company } = splitHeadline(headline);

    const threadHit = LLA.resolve('threadContainer');
    const root = threadHit?.el || document;
    const { nodes } = LLA.resolveAll('messageNode', root);

    const recent = nodes.slice(-MAX_MESSAGES).map((node) => {
      let body = text(node.querySelector('.msg-s-event-listitem__body, p'));
      if (!body) body = text(node);
      if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '…';
      const them = isFromThem(node, name);
      return { from: them === null ? 'unknown' : them ? 'them' : 'me', text: body };
    }).filter((m) => m.text);

    const ctx = {
      recipient: { name, headline, title, company },
      messages: recent,
      lastInbound: [...recent].reverse().find((m) => m.from !== 'me')?.text || ''
    };
    LLA.log('scraped context', ctx);
    return ctx;
  };
})();
