(function () {
  if (window.__TN_PROGRESSBAR_APP_LOADED__) return;
  window.__TN_PROGRESSBAR_APP_LOADED__ = true;

  const scriptNode = document.currentScript || document.querySelector('script[data-tn-progressbar="1"]');
  const scriptSrc = (scriptNode && scriptNode.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  const storeId = srcUrl ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store')) : null;

  const config = {
    envioGratis: 50000,
    cuotasSinInteres: 80000,
    regaloMisterioso: 100000,
  };

  const state = {
    observedSubtotalNode: null,
    subtotalObserver: null,
    domObserver: null,
    raf: null,
    advanced: null,
    evalSeq: 0,
    lastEvalAt: 0,
    lastSignature: '',
    evalTimer: null,
  };

  function money(n) {
    return Number(n || 0).toLocaleString('es-AR');
  }

  function toAmount(raw) {
    if (raw == null || raw === '') return null;

    if (typeof raw === 'string') {
      const hasDecimalSeparator = raw.includes('.') || raw.includes(',');
      const normalized = raw.replace(/\./g, '').replace(',', '.');
      const n = Number(normalized);
      if (!Number.isFinite(n)) return null;
      if (hasDecimalSeparator) return n;
      if (Number.isInteger(n)) return n / 100;
      return n;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (Number.isInteger(n)) return n / 100;
    return n;
  }

  function getSubtotalNode() {
    return (
      document.querySelector('.js-ajax-cart-total.js-cart-subtotal') ||
      document.querySelector('[data-component="cart.subtotal"]') ||
      null
    );
  }

  function parseSubtotalFromText(text) {
    if (!text) return null;
    const raw = String(text).trim().replace(/\s+/g, '');
    const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function getSubtotalAmount() {
    const node = getSubtotalNode();
    if (!node) return null;

    const rawCents = node.getAttribute('data-priceraw');
    if (rawCents != null && rawCents !== '') {
      const cents = Number(rawCents);
      if (Number.isFinite(cents)) return cents / 100;
    }

    const textValue = parseSubtotalFromText(node.textContent || '');
    if (textValue != null) return textValue;

    return null;
  }

  function ensureBarMounted() {
    const existing = document.getElementById('app-barra-progreso');
    if (existing) return existing;

    const wrapper = document.createElement('div');
    wrapper.id = 'app-barra-progreso';
    wrapper.className = 'tn-progressbar';
    wrapper.innerHTML = [
      '<div class="tn-progressbar__text" id="tn-progressbar-text">Calculando beneficios...</div>',
      '<div class="tn-progressbar__track">',
      '  <div class="tn-progressbar__fill" id="tn-progressbar-fill"></div>',
      '</div>',
    ].join('');

    const cartList = document.querySelector('.js-ajax-cart-list');
    if (cartList) {
      const firstItem = cartList.querySelector('.js-cart-item');
      if (firstItem && firstItem.parentNode) {
        firstItem.parentNode.insertBefore(wrapper, firstItem);
        return wrapper;
      }
      cartList.prepend(wrapper);
      return wrapper;
    }

    const fallbackAnchor = getSubtotalNode() || document.querySelector('.js-cart-item');
    if (!fallbackAnchor || !fallbackAnchor.parentNode) return null;
    fallbackAnchor.parentNode.insertBefore(wrapper, fallbackAnchor);
    return wrapper;
  }

  function renderDefault(total) {
    let pct = 0;
    let message = '';

    if (total < config.envioGratis) {
      pct = (total / config.envioGratis) * 100;
      const faltan = config.envioGratis - total;
      message = `Te faltan <strong>$${money(faltan)}</strong> para envio gratis`;
    } else if (total < config.regaloMisterioso) {
      pct = (total / config.regaloMisterioso) * 100;
      const faltan = config.regaloMisterioso - total;
      message = `<span class="tn-progressbar__ok">Envio gratis activado</span>. Te faltan <strong>$${money(faltan)}</strong> para un regalo`;
    } else {
      pct = 100;
      message = '<span class="tn-progressbar__ok">Felicitaciones, ya tenes todos los beneficios.</span>';
    }

    return { pct, message, color: '#2563eb' };
  }

  function applyTemplate(template, vars) {
    if (!template) return '';
    return String(template)
      .replaceAll('{{missing}}', '$' + money(vars.missing || 0))
      .replaceAll('{{threshold}}', '$' + money(vars.threshold || 0))
      .replaceAll('{{subtotal}}', '$' + money(vars.subtotal || 0));
  }

  function buildEnvioResult(envio) {
    if (!envio || !envio.enabled) return null;
    if (!envio.has_match && envio.scope !== 'all') return null;
    if (envio.reached) {
      const reached = String(envio.text_reached || '').trim();
      return {
        pct: 100,
        message: reached || '<span class="tn-progressbar__ok">Envio gratis activado.</span>',
        color: envio.bar_color || '#2563eb',
      };
    }
    const prefix = String(envio.text_prefix || '').trim();
    const suffix = String(envio.text_suffix || '').trim();
    let custom = '';
    if (prefix || suffix) {
      custom = `${prefix || 'Te faltan'} <strong>$${money(envio.missing_amount)}</strong> ${suffix || ''}`.trim();
    } else {
      custom = applyTemplate(envio.text, {
        missing: envio.missing_amount,
        threshold: envio.threshold_amount,
        subtotal: envio.eligible_subtotal,
      });
    }
    return {
      pct: Number(envio.progress || 0) * 100,
      message: custom || `Te faltan <strong>$${money(envio.missing_amount)}</strong> para envio gratis.`,
      color: envio.bar_color || '#2563eb',
    };
  }

  function buildCuotasResult(cuotas) {
    if (!cuotas || !cuotas.enabled) return null;
    if (!cuotas.has_match && cuotas.scope !== 'all') return null;
    if (cuotas.reached) {
      const reached = String(cuotas.text_reached || '').trim();
      return {
        pct: 100,
        message: reached || '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>',
        color: cuotas.bar_color || '#0ea5e9',
      };
    }
    const prefix = String(cuotas.text_prefix || '').trim();
    const suffix = String(cuotas.text_suffix || '').trim();
    let custom = '';
    if (prefix || suffix) {
      custom = `${prefix || 'Te faltan'} <strong>$${money(cuotas.missing_amount)}</strong> ${suffix || ''}`.trim();
    } else {
      custom = applyTemplate(cuotas.text, {
        missing: cuotas.missing_amount,
        threshold: cuotas.threshold_amount,
        subtotal: cuotas.eligible_subtotal,
      });
    }
    return {
      pct: Number(cuotas.progress || 0) * 100,
      message: custom || `Te faltan <strong>$${money(cuotas.missing_amount)}</strong> para cuotas sin interes.`,
      color: cuotas.bar_color || '#0ea5e9',
    };
  }

  function buildRegaloResult(regalo) {
    if (!regalo || !regalo.enabled) return null;

    if (regalo.mode === 'combo_products') {
      if (regalo.reached) {
        const reached = String(regalo.text_reached || '').trim();
        return {
          pct: 100,
          message: reached || '<span class="tn-progressbar__ok">Regalo desbloqueado.</span>',
          color: regalo.bar_color || '#a855f7',
        };
      }
      if (!regalo.combo_matched) {
        return {
          pct: 20,
          message: 'Agrega ambos productos para activar el regalo.',
          color: regalo.bar_color || '#a855f7',
        };
      }
      const prefix = String(regalo.text_prefix || '').trim();
      const suffix = String(regalo.text_suffix || '').trim();
      let custom = '';
      if (prefix || suffix) {
        custom = `${prefix || 'Te faltan'} <strong>$${money(regalo.missing_amount)}</strong> ${suffix || ''}`.trim();
      } else {
        custom = applyTemplate(regalo.text, {
          missing: regalo.missing_amount,
          threshold: regalo.min_amount,
          subtotal: 0,
        });
      }
      return {
        pct: Number(regalo.progress || 0) * 100,
        message: custom || `Te faltan <strong>$${money(regalo.missing_amount)}</strong> para obtener el regalo.`,
        color: regalo.bar_color || '#a855f7',
      };
    }

    if (regalo.reached) {
      const reached = String(regalo.text_reached || '').trim();
      return {
        pct: 100,
        message: reached || '<span class="tn-progressbar__ok">Regalo desbloqueado.</span>',
        color: regalo.bar_color || '#a855f7',
      };
    }
    const prefix = String(regalo.text_prefix || '').trim();
    const suffix = String(regalo.text_suffix || '').trim();
    let custom = '';
    if (prefix || suffix) {
      custom = `${prefix || 'Te faltan'} <strong>$${money(regalo.missing_amount)}</strong> ${suffix || ''}`.trim();
    } else {
      custom = applyTemplate(regalo.text, {
        missing: regalo.missing_amount,
        threshold: regalo.min_amount,
        subtotal: 0,
      });
    }
    return {
      pct: Number(regalo.progress || 0) * 100,
      message: custom || `Te faltan ${Math.max(0, Number(regalo.missing_qty || 0))} unidades y <strong>$${money(regalo.missing_amount)}</strong> para el regalo.`,
      color: regalo.bar_color || '#a855f7',
    };
  }

  function render(totalAmount) {
    const wrapper = ensureBarMounted();
    if (!wrapper) return;

    const fill = document.getElementById('tn-progressbar-fill');
    const text = document.getElementById('tn-progressbar-text');
    if (!fill || !text) return;

    const total = Number(totalAmount || 0);
    let result = renderDefault(total);

    const adv = state.advanced;
    const regaloResult = adv ? buildRegaloResult(adv.regalo) : null;
    const cuotasResult = adv ? buildCuotasResult(adv.cuotas) : null;
    const envioResult = adv ? buildEnvioResult(adv.envio) : null;

    result = regaloResult || cuotasResult || envioResult || result;

    fill.style.width = `${Math.max(0, Math.min(100, result.pct))}%`;
    if (result.color) {
      fill.style.background = result.color;
    } else {
      fill.style.background = '';
    }
    text.innerHTML = result.message;
  }

  function buildCartSnapshot(cart) {
    const c = cart || (window.LS && window.LS.cart) || {};
    const productList = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);

    const items = productList.map((item) => {
      const productId = String(item.product_id || item.id || (item.product && item.product.id) || '').trim();
      const quantity = Math.max(1, Number(item.quantity || 1));

      const unitPrice = toAmount(item.unit_price || item.price || item.unitPrice || item.base_price);
      const lineTotalRaw = item.line_total || item.subtotal || item.total || item.line_price;
      const lineTotal = toAmount(lineTotalRaw) || (unitPrice != null ? unitPrice * quantity : 0);

      const categories = Array.isArray(item.categories)
        ? item.categories.map((c0) => String((c0 && c0.id) || c0))
        : [];

      return {
        product_id: productId,
        quantity,
        unit_price: unitPrice != null ? unitPrice : 0,
        line_total: lineTotal,
        categories,
      };
    }).filter((i) => i.product_id);

    const totalAmount = toAmount(c.total) || getSubtotalAmount() || items.reduce((acc, i) => acc + Number(i.line_total || 0), 0);
    return {
      total_amount: Number(totalAmount || 0),
      items,
    };
  }

  async function evaluateAdvanced(cartSnapshot) {
    if (!storeId) return;

    const now = Date.now();
    const signature = JSON.stringify({
      total: cartSnapshot.total_amount,
      items: cartSnapshot.items.map((i) => [i.product_id, i.quantity, i.line_total]),
    });

    if (state.lastSignature === signature && now - state.lastEvalAt < 15000) return;

    state.lastSignature = signature;
    state.lastEvalAt = now;
    const seq = ++state.evalSeq;

    try {
      const res = await fetch(`${baseUrl}/api/goals/${encodeURIComponent(storeId)}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartSnapshot),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== state.evalSeq) return;
      state.advanced = data;
      render(cartSnapshot.total_amount);
    } catch (_) {
      // Keep default rendering if evaluation endpoint is unavailable.
    }
  }

  function scheduleEvaluate(cartSnapshot) {
    if (state.evalTimer) clearTimeout(state.evalTimer);
    state.evalTimer = setTimeout(function () {
      state.evalTimer = null;
      evaluateAdvanced(cartSnapshot).catch(function () {});
    }, 350);
  }

  function scheduleRenderFromDom(shouldEvaluate) {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      const amount = getSubtotalAmount();
      if (amount != null) {
        render(amount);
        if (shouldEvaluate !== false) {
          scheduleEvaluate(buildCartSnapshot());
        }
      }
    });
  }

  function bindSubtotalObserver() {
    const node = getSubtotalNode();
    if (!node) return;
    if (state.observedSubtotalNode === node) return;

    if (state.subtotalObserver) {
      state.subtotalObserver.disconnect();
      state.subtotalObserver = null;
    }

    state.observedSubtotalNode = node;
    state.subtotalObserver = new MutationObserver(function () {
      scheduleRenderFromDom();
    });

    state.subtotalObserver.observe(node, {
      attributes: true,
      attributeFilter: ['data-priceraw', 'data-component-value'],
      childList: true,
      characterData: true,
      subtree: true,
    });

    scheduleRenderFromDom();
  }

  function bindDomObserver() {
    if (state.domObserver) return;
    state.domObserver = new MutationObserver(function () {
      ensureBarMounted();
      bindSubtotalObserver();
      scheduleRenderFromDom();
    });

    state.domObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function loadConfig() {
    if (!storeId) return;

    try {
      const res = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.monto_envio_gratis != null) config.envioGratis = Number(data.monto_envio_gratis);
      if (data && data.monto_cuotas != null) config.cuotasSinInteres = Number(data.monto_cuotas);
      if (data && data.monto_regalo != null) config.regaloMisterioso = Number(data.monto_regalo);
    } catch (_) {
      // Keep defaults.
    }
  }

  document.addEventListener('cart:updated', function (event) {
    const cart = event && event.detail ? event.detail.cart : null;
    const snapshot = buildCartSnapshot(cart);
    render(snapshot.total_amount);
    scheduleEvaluate(snapshot);
  });

  loadConfig().finally(function () {
    ensureBarMounted();
    bindSubtotalObserver();
    bindDomObserver();
    const initial = buildCartSnapshot();
    render(initial.total_amount);
    scheduleEvaluate(initial);
    setInterval(function () { scheduleRenderFromDom(false); }, 3000);
  });
})();
