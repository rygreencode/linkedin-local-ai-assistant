/* Tiered DOM resolution with user overrides. Stage 1 of the auto-healer:
   overrides from chrome.storage.local, then semantic fallbacks, then a status
   report the popup renders as OK / FAILED per element. */
(function () {
  const LLA = (globalThis.LLA = globalThis.LLA || {});

  LLA.settings = { ...globalThis.LLA_DEFAULT_SETTINGS };

  LLA.loadSettings = async function () {
    const stored = await chrome.storage.local.get('settings');
    LLA.settings = { ...globalThis.LLA_DEFAULT_SETTINGS, ...(stored.settings || {}) };
    return LLA.settings;
  };

  LLA.saveSettings = async function (patch) {
    LLA.settings = { ...LLA.settings, ...patch };
    await chrome.storage.local.set({ settings: LLA.settings });
    return LLA.settings;
  };

  LLA.log = function (...args) {
    if (LLA.settings.debug) console.log('[LLA]', ...args);
  };

  function candidates(key) {
    const override = LLA.settings.selectorOverrides?.[key];
    const tiers = globalThis.LLA_SELECTOR_TIERS[key] || [];
    return override ? [override, ...tiers] : tiers;
  }

  /* Returns { el, selector, tier } or null. tier -1 means the user's override matched. */
  LLA.resolve = function (key, root = document) {
    const list = candidates(key);
    const hasOverride = Boolean(LLA.settings.selectorOverrides?.[key]);
    for (let i = 0; i < list.length; i++) {
      let el;
      try {
        el = root.querySelector(list[i]);
      } catch (err) {
        console.warn('[LLA] invalid selector for', key, list[i], err);
        continue;
      }
      if (el) return { el, selector: list[i], tier: hasOverride ? i - 1 : i };
    }
    return null;
  };

  LLA.resolveAll = function (key, root = document) {
    const list = candidates(key);
    for (const sel of list) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch {
        continue;
      }
      if (nodes.length) return { nodes: Array.from(nodes), selector: sel };
    }
    return { nodes: [], selector: null };
  };

  /* Diagnostic snapshot for the popup's repair UI. */
  LLA.diagnose = function () {
    return Object.keys(globalThis.LLA_SELECTOR_TIERS).map((key) => {
      const hit = LLA.resolve(key);
      return {
        key,
        label: globalThis.LLA_SELECTOR_LABELS[key] || key,
        ok: Boolean(hit),
        selector: hit ? hit.selector : null,
        tier: hit ? hit.tier : null,
        overridden: Boolean(LLA.settings.selectorOverrides?.[key])
      };
    });
  };
})();
