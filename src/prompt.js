/* Prompt assembly: scraped context + local knowledge base + few-shot style
   samples -> chat messages for Ollama. */
(function () {
  const LLA = (globalThis.LLA = globalThis.LLA || {});

  LLA.buildMessages = function (ctx, extraInstruction) {
    const s = LLA.settings;
    const kb = [];
    if (s.name) kb.push(`Your name: ${s.name}`);
    if (s.company) kb.push(`Your company: ${s.company}`);
    if (s.bio) kb.push(`About you: ${s.bio}`);
    if (s.offer) kb.push(`What you offer: ${s.offer}`);
    if (s.bookingLink) kb.push(`Booking link (only include if proposing a meeting): ${s.bookingLink}`);

    const system = [
      'You are drafting a reply in the user\'s LinkedIn DMs. Write AS the user, in first person.',
      'Output ONLY the message body. No greeting labels, no subject line, no quotes around it, no commentary.',
      s.guidelines
    ];
    if (kb.length) system.push('--- What you know about the user ---\n' + kb.join('\n'));
    if (s.styleSamples?.length) {
      system.push(
        '--- The user\'s own past messages. Match this voice, length and punctuation ---\n' +
          s.styleSamples.map((x) => `- ${x}`).join('\n')
      );
    }

    const r = ctx.recipient;
    const who = [r.name && `Name: ${r.name}`, r.title && `Title: ${r.title}`, r.company && `Company: ${r.company}`]
      .filter(Boolean)
      .join(' | ') || 'Unknown recipient.';

    const transcript = ctx.messages.length
      ? ctx.messages.map((m) => `${m.from === 'me' ? 'You' : r.name || 'Them'}: ${m.text}`).join('\n')
      : '(no messages scraped from this thread)';

    const user = [
      `Recipient — ${who}`,
      '',
      'Conversation so far:',
      transcript,
      '',
      extraInstruction
        ? `Extra instruction from the user: ${extraInstruction}`
        : 'Write the reply the user should send next.'
    ].join('\n');

    return [
      { role: 'system', content: system.join('\n\n') },
      { role: 'user', content: user }
    ];
  };

  /* Model output sometimes arrives wrapped in quotes or prefixed with a label. */
  LLA.cleanDraft = function (raw) {
    let out = (raw || '').trim();
    out = out.replace(/^(reply|draft|message|response)\s*:\s*/i, '');
    out = out.replace(/^["'“”](.*)["'“”]$/s, '$1');
    return out.trim();
  };
})();
