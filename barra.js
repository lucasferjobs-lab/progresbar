(function () {
  if (window.__TN_PROGRESSBAR_BOOTSTRAPPED__) return;
  window.__TN_PROGRESSBAR_BOOTSTRAPPED__ = true;

  const BUILD_VERSION = '2026-03-04-03';
  window.__TN_PROGRESSBAR_VERSION__ = BUILD_VERSION;
  const CONFIG_FRESH_MS = 25_000;
  const WARM_INTERVAL_MS = 10 * 60 * 1000;

  const currentScript = document.currentScript;
  const scriptSrc = (currentScript && currentScript.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  const query = srcUrl ? srcUrl.search : '';
  const sep = query ? '&' : '?';
  const versionedQuery = `${query}${sep}v=${encodeURIComponent(BUILD_VERSION)}`;

  const debugEnabled = (function () {
    try {
      if (srcUrl && srcUrl.searchParams && srcUrl.searchParams.get('debug') === '1') return true;
      if (srcUrl && srcUrl.searchParams && srcUrl.searchParams.get('tn_progressbar_debug') === '1') return true;
      return !!(window.localStorage && window.localStorage.getItem('tn_progressbar_debug') === '1');
    } catch (_) {
      return false;
    }
  })();

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

  function needsRemote(cfg) {
    try {
      if (!cfg) return false;
      const envioEnabled = cfg.enable_envio_rule !== false;
      const cuotasEnabled = cfg.enable_cuotas_rule !== false;
      const regaloEnabled = cfg.enable_regalo_rule !== false;
      const envioScope = String(cfg.envio_scope || 'all');
      const cuotasScope = String(cfg.cuotas_scope || 'all');
      if (envioEnabled && envioScope === 'category') return true;
      if (cuotasEnabled && cuotasScope === 'category') return true;
      if (regaloEnabled) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function warmBackend() {
    const storeId = resolveStoreId();
    if (!storeId) return false;
    const lockKey = `tn_progressbar_warm_${storeId}`;
    try {
      const now = Date.now();
      const last = Number((window.sessionStorage && window.sessionStorage.getItem(lockKey)) || 0);
      if (last && now - last < WARM_INTERVAL_MS) return true;
      if (window.sessionStorage) window.sessionStorage.setItem(lockKey, String(now));
    } catch (_) {}

    // Use no-cors to avoid console noise if the endpoint doesn't send CORS headers.
    fetch(`${baseUrl}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
    return true;
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
        if (t && Number.isFinite(t) && Date.now() - t < CONFIG_FRESH_MS) {
          if (parsed && parsed.data && needsRemote(parsed.data)) warmBackend();
          return true;
        }
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
        if (needsRemote(data)) warmBackend();
      })
      .catch(() => {
      });

    return true;
  }

  // Prefetch config early so the first cart open renders with custom copy/colors.
  prefetchConfig();

  // Start loading assets after kicking off the config prefetch. This reduces the
  // window where the app runs without having the latest store settings cached.
  injectCss(`${baseUrl}/static/storefront/progressbar.css${versionedQuery}`);
  injectScript(`${baseUrl}/static/storefront/progressbar.js${versionedQuery}`);

  setTimeout(prefetchConfig, 500);
  setTimeout(prefetchConfig, 2000);

  if (debugEnabled) {
    try {
      // eslint-disable-next-line no-console
      console.log('[ProgressBar][loader]', { version: BUILD_VERSION, baseUrl });
    } catch (_) {}
  }

  // Intentionally no console logs in production.
})();















