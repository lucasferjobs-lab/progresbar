(function () {
  if (window.__TN_PROGRESSBAR_BOOTSTRAPPED__) return;
  window.__TN_PROGRESSBAR_BOOTSTRAPPED__ = true;

  const BUILD_VERSION = '2026-02-27-03';
  window.__TN_PROGRESSBAR_VERSION__ = BUILD_VERSION;
  const CONFIG_FRESH_MS = 25_000;

  const currentScript = document.currentScript;
  const scriptSrc = (currentScript && currentScript.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  const query = srcUrl ? srcUrl.search : '';
  const sep = query ? '&' : '?';
  const versionedQuery = `${query}${sep}v=${encodeURIComponent(BUILD_VERSION)}`;

  function injectCss(href) {
    if (document.querySelector(`link[data-tn-progressbar="1"][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-tn-progressbar', '1');
    document.head.appendChild(link);
  }

  function injectScript(src) {
    if (document.querySelector(`script[data-tn-progressbar="1"][src="${src}"]`)) return;
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.setAttribute('data-tn-progressbar', '1');
    document.head.appendChild(script);
  }

  injectCss(`${baseUrl}/static/storefront/progressbar.css${versionedQuery}`);
  injectScript(`${baseUrl}/static/storefront/progressbar.js${versionedQuery}`);

  function resolveStoreId() {
    try {
      const fromQuery = srcUrl ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store')) : null;
      if (fromQuery) return String(fromQuery);
    } catch (_) {}
    try {
      const fromLs = window.LS && window.LS.store && (window.LS.store.id || window.LS.store.store_id);
      if (fromLs) return String(fromLs);
    } catch (_) {}
    try {
      const fromGlobal = window.Store && (window.Store.id || window.Store.store_id);
      if (fromGlobal) return String(fromGlobal);
    } catch (_) {}
    return null;
  }

  function prefetchConfig() {
    const storeId = resolveStoreId();
    if (!storeId) return false;
    const cacheKey = `tn_progressbar_cfg_${storeId}`;
    const lockKey = `tn_progressbar_cfg_prefetch_${storeId}`;

    try {
      const raw = window.localStorage ? window.localStorage.getItem(cacheKey) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        const t = parsed && parsed._pb_cache === 1 ? Number(parsed.t || 0) : 0;
        if (t && Number.isFinite(t) && Date.now() - t < CONFIG_FRESH_MS) return true;
      }
    } catch (_) {}

    try {
      const now = Date.now();
      const last = Number((window.sessionStorage && window.sessionStorage.getItem(lockKey)) || 0);
      if (last && now - last < CONFIG_FRESH_MS) return true;
      if (window.sessionStorage) window.sessionStorage.setItem(lockKey, String(now));
    } catch (_) {}

    fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}`)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        try {
          if (window.localStorage) {
            window.localStorage.setItem(cacheKey, JSON.stringify({ _pb_cache: 1, t: Date.now(), data }));
          }
        } catch (_) {}
      })
      .catch(() => {
      });

    return true;
  }

  // Prefetch config early so the first cart open renders with custom copy/colors.
  prefetchConfig();
  setTimeout(prefetchConfig, 500);
  setTimeout(prefetchConfig, 2000);

  // Intentionally no console logs in production.
})();















