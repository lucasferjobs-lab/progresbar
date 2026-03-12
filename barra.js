;(function () {
  try {
    var win = window;
    var doc = win.document;

    // Evitar doble carga
    if (win.__TN_PROGRESSBAR_LOADER_LOADED__) return;
    win.__TN_PROGRESSBAR_LOADER_LOADED__ = true;

    // Detectar el tag <script> actual
    var scriptNode = doc.currentScript;
    if (!scriptNode) {
      var scripts = doc.getElementsByTagName('script');
      scriptNode = scripts && scripts.length ? scripts[scripts.length - 1] : null;
    }
    if (!scriptNode || !scriptNode.src) return;

    var scriptSrc = scriptNode.src;
    var srcUrl;
    try {
      srcUrl = new URL(scriptSrc);
    } catch (_) {
      srcUrl = null;
    }

    var baseOrigin = srcUrl ? srcUrl.origin : (win.location ? (win.location.protocol + '//' + win.location.host) : '');
    var storeId = srcUrl ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store')) : null;
    var version = srcUrl ? (srcUrl.searchParams.get('v') || srcUrl.searchParams.get('version') || '') : '';

    // Construir URL del bundle principal de storefront
    var bundleUrl = baseOrigin + '/static/storefront/progressbar.js';
    try {
      var u = new URL(bundleUrl);
      if (storeId) u.searchParams.set('store', storeId);
      if (version) u.searchParams.set('v', version);
      bundleUrl = u.toString();
    } catch (_) {
      // Fallback simple si URL() no está disponible
      var sep = bundleUrl.indexOf('?') === -1 ? '?' : '&';
      if (storeId) {
        bundleUrl += sep + 'store=' + encodeURIComponent(storeId);
        sep = '&';
      }
      if (version) {
        bundleUrl += sep + 'v=' + encodeURIComponent(version);
      }
    }

    var loader = doc.createElement('script');
    loader.src = bundleUrl;
    loader.async = true;
    loader.setAttribute('data-tn-progressbar', '1');

    var parent = doc.head || doc.body || doc.documentElement;
    if (!parent) return;
    parent.appendChild(loader);
  } catch (_err) {
    // Silencioso en producción
  }
})();
