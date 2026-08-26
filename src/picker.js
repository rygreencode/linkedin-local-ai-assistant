/* Stage 3 of the auto-healer: click the broken element on-screen and bind a new
   selector for it. Activated from the popup's diagnostic panel. */
(function () {
  const LLA = (globalThis.LLA = globalThis.LLA || {});
  let active = null;

  const looksGenerated = (c) => /^[a-z]?[0-9a-f]{6,}$/i.test(c) || /\d{4,}/.test(c) || c.startsWith('ember');

  function describe(el) {
    const parts = [el.tagName.toLowerCase()];
    for (const attr of ['role', 'contenteditable', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 40) parts.push(`[${attr}="${CSS.escape(v).replace(/\\/g, '')}"]`);
    }
    for (const c of Array.from(el.classList).filter((c) => !looksGenerated(c)).slice(0, 3)) {
      parts.push('.' + CSS.escape(c));
    }
    return parts.join('');
  }

  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function cssPath(el) {
    if (el.id && !looksGenerated(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    let node = el;
    let path = describe(el);
    if (unique(path)) return path;
    for (let depth = 0; depth < 5 && node.parentElement; depth++) {
      node = node.parentElement;
      path = describe(node) + ' ' + path;
      if (unique(path)) return path;
    }
    // Not unique — still usable, resolve() takes the first match.
    return path;
  }

  function highlight(el) {
    if (!active) return;
    const r = el.getBoundingClientRect();
    Object.assign(active.box.style, {
      display: 'block',
      top: r.top + 'px',
      left: r.left + 'px',
      width: r.width + 'px',
      height: r.height + 'px'
    });
    active.label.textContent = describe(el);
    active.label.style.top = Math.max(0, r.top - 22) + 'px';
    active.label.style.left = r.left + 'px';
  }

  function stop() {
    if (!active) return;
    document.removeEventListener('mousemove', active.onMove, true);
    document.removeEventListener('click', active.onClick, true);
    document.removeEventListener('keydown', active.onKey, true);
    active.host.remove();
    active = null;
  }

  LLA.startPicker = function (key) {
    stop();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .box { position:fixed; border:2px solid #0a66c2; background:rgba(10,102,194,.12); display:none; }
        .label { position:fixed; background:#0a66c2; color:#fff; font:11px/1.5 monospace; padding:1px 5px; white-space:nowrap; max-width:60vw; overflow:hidden; text-overflow:ellipsis; }
        .banner { position:fixed; top:12px; left:50%; transform:translateX(-50%); background:#111; color:#fff;
                  font:13px/1.4 -apple-system,system-ui,sans-serif; padding:8px 14px; border-radius:6px; }
      </style>
      <div class="box"></div><div class="label"></div>
      <div class="banner">Click the <b>${(globalThis.LLA_SELECTOR_LABELS[key] || key)}</b> element — Esc to cancel</div>`;
    document.documentElement.appendChild(host);

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el !== host) highlight(el);
    };
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      const selector = cssPath(el);
      const overrides = { ...LLA.settings.selectorOverrides, [key]: selector };
      LLA.saveSettings({ selectorOverrides: overrides }).then(() => {
        LLA.toast(`Bound ${globalThis.LLA_SELECTOR_LABELS[key] || key} → ${selector}`, 4000);
        stop();
      });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stop();
      }
    };

    active = { host, box: shadow.querySelector('.box'), label: shadow.querySelector('.label'), onMove, onClick, onKey };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  };
})();
