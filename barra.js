(function () {
  if (window.__TN_PROGRESSBAR_BOOTSTRAPPED__) return;
  window.__TN_PROGRESSBAR_BOOTSTRAPPED__ = true;

  const currentScript = document.currentScript;
  const scriptSrc = (currentScript && currentScript.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  const query = srcUrl ? srcUrl.search : '';

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

  injectCss(`${baseUrl}/static/storefront/progressbar.css`);
  injectScript(`${baseUrl}/static/storefront/progressbar.js${query}`);
})();
