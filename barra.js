(function () {
  const currentScript = document.currentScript;
  const scriptSrc = (currentScript && currentScript.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  const storeId = srcUrl
    ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store'))
    : null;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${baseUrl}/styles.css`;
  document.head.appendChild(link);

  const CONFIG = {
    envioGratis: 50000,
    cuotasSinInteres: 80000,
    regaloMisterioso: 100000,
  };

  function formatMoney(value) {
    return Number(value).toLocaleString('es-AR');
  }

  function createWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'barra-progreso-wrapper';
    wrapper.id = 'app-barra-progreso';

    wrapper.innerHTML = [
      '<div class="barra-progreso-texto" id="barra-txt">Cargando...</div>',
      '<div class="barra-progreso-bg"><div class="barra-progreso-fill" id="barra-fill"></div></div>',
    ].join('');

    return wrapper;
  }

  function update(cart) {
    const fill = document.getElementById('barra-fill');
    const txt = document.getElementById('barra-txt');
    if (!fill || !txt || !cart) return;

    const total = Number(cart.total || 0) / 100;
    let percentage = 0;
    let message = '';

    if (total < CONFIG.envioGratis) {
      percentage = (total / CONFIG.envioGratis) * 100;
      const missing = CONFIG.envioGratis - total;
      message = `Te faltan <strong>$${formatMoney(missing)}</strong> para el envio gratis`;
    } else if (total < CONFIG.regaloMisterioso) {
      percentage = (total / CONFIG.regaloMisterioso) * 100;
      const missing = CONFIG.regaloMisterioso - total;
      message = `<span class="meta-lograda">Envio gratis activado</span>. Te faltan <strong>$${formatMoney(missing)}</strong> para un regalo`;
    } else {
      percentage = 100;
      message = '<span class="meta-lograda">Felicitaciones, ya tenes todos los beneficios.</span>';
    }

    fill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
    txt.innerHTML = message;
  }

  function mountIfNeeded() {
    const cartItem = document.querySelector('.js-cart-item');
    const exists = document.getElementById('app-barra-progreso');

    if (cartItem && !exists) {
      const bar = createWrapper();
      cartItem.parentNode.insertBefore(bar, cartItem);
      if (window.LS && window.LS.cart) {
        update(window.LS.cart);
      }
    }
  }

  async function loadConfig() {
    if (!storeId) return;

    try {
      const response = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}`);
      if (!response.ok) return;

      const data = await response.json();
      if (data && data.monto_envio_gratis != null) {
        CONFIG.envioGratis = Number(data.monto_envio_gratis);
      }
      if (data && data.monto_cuotas != null) {
        CONFIG.cuotasSinInteres = Number(data.monto_cuotas);
      }
      if (data && data.monto_regalo != null) {
        CONFIG.regaloMisterioso = Number(data.monto_regalo);
      }
    } catch (_err) {
      // Keep defaults when API is not reachable.
    }
  }

  document.addEventListener('cart:updated', function (event) {
    mountIfNeeded();
    if (event && event.detail && event.detail.cart) {
      update(event.detail.cart);
    }
  });

  loadConfig().finally(function () {
    mountIfNeeded();
    setInterval(mountIfNeeded, 1000);
  });
})();
