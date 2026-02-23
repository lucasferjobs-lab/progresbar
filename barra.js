(function () {
  if (window.__TN_PROGRESSBAR_BOOTSTRAPPED__) return;
  window.__TN_PROGRESSBAR_BOOTSTRAPPED__ = true;

  const BUILD_VERSION = '2026-02-23-2';
  window.__TN_PROGRESSBAR_VERSION__ = BUILD_VERSION;

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

  if (window.console && typeof window.console.info === 'function') {
    window.console.info('[ProgressBar] loader version:', BUILD_VERSION);
  }
})();
