(function () {
  if (window.__TN_PROGRESSBAR_APP_LOADED__) return;
  window.__TN_PROGRESSBAR_APP_LOADED__ = true;
  const APP_VERSION = '2026-02-23-10';
  window.__TN_PROGRESSBAR_APP_VERSION__ = APP_VERSION;

  const scriptNode = document.currentScript || document.querySelector('script[data-tn-progressbar="1"]');
  const scriptSrc = (scriptNode && scriptNode.src) || '';
  const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
  const baseUrl = srcUrl ? srcUrl.origin : window.location.origin;
  let storeId = srcUrl ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store')) : null;
  if (window.console && typeof window.console.info === 'function') {
    window.console.info('[ProgressBar] app version:', APP_VERSION, 'store:', storeId || 'unknown');
  }

  function detectStoreId() {
    if (storeId) return storeId;
    try {
      const fromLs = window.LS && window.LS.store && (window.LS.store.id || window.LS.store.store_id);
      if (fromLs) {
        storeId = String(fromLs);
        return storeId;
      }
    } catch (_) {}
    try {
      const fromGlobal = window.Store && (window.Store.id || window.Store.store_id);
      if (fromGlobal) {
        storeId = String(fromGlobal);
        return storeId;
      }
    } catch (_) {}
    try {
      const hidden = document.querySelector('[name="store_id"], #store_id, [data-store-id]');
      const v = hidden ? (hidden.value || hidden.getAttribute('data-store-id')) : null;
      if (v) {
        storeId = String(v);
        return storeId;
      }
    } catch (_) {}
    return null;
  }

  function getConfigCacheKey() {
    return `tn_progressbar_cfg_${detectStoreId() || 'unknown'}`;
  }

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
    liveConfig: null,
    lastConfigFetchAt: 0,
    lastStoreIdSynced: null,
  };
  try {
    const cachedCfg = window.localStorage ? window.localStorage.getItem(getConfigCacheKey()) : null;
    if (cachedCfg) state.liveConfig = JSON.parse(cachedCfg);
  } catch (_) {}

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
      '<div class="tn-progressbar__text" id="tn-progressbar-text">&nbsp;</div>',
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

  function removeBar() {
    const existing = document.getElementById('app-barra-progreso');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) {
      return false;
    }
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function countVisibleCartItems() {
    const nodes = document.querySelectorAll('.js-ajax-cart-list .js-cart-item');
    let count = 0;
    nodes.forEach(function (n) {
      if (isVisible(n)) count += 1;
    });
    return count;
  }

  function isCartEmpty(cartSnapshot) {
    const visibleItems = countVisibleCartItems();
    if (visibleItems > 0) return false;

    const hasSnapshotItems = !!(cartSnapshot && Array.isArray(cartSnapshot.items) && cartSnapshot.items.length > 0);
    const snapshotTotal = Number((cartSnapshot && cartSnapshot.total_amount) || 0);
    if (hasSnapshotItems || snapshotTotal > 0) return false;

    const domSubtotal = getSubtotalAmount();
    if (domSubtotal != null) {
      if (domSubtotal > 0) return false;
      if (domSubtotal === 0 && !hasSnapshotItems) return true;
    }

    const emptyState = document.querySelector('.js-empty-ajax-cart');
    if (emptyState && isVisible(emptyState)) return true;

    return false;
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

  function buildLocalEnvioResult(total, cfg) {
    if (!cfg || cfg.enable_envio_rule === false) return null;
    const scope = String(cfg.envio_scope || 'all');
    if (scope !== 'all') return null;
    const threshold = Math.max(0, Number(cfg.envio_min_amount || cfg.monto_envio_gratis || 0));
    if (threshold <= 0) return null;
    const missing = Math.max(0, threshold - total);
    const reached = missing <= 0;
    const color = String(cfg.envio_bar_color || '#2563eb');
    if (reached) {
      return {
        pct: 100,
        message: String(cfg.envio_text_reached || '<span class="tn-progressbar__ok">Envio gratis activado.</span>'),
        color,
      };
    }
    const prefix = String(cfg.envio_text_prefix || '').trim();
    const suffix = String(cfg.envio_text_suffix || '').trim();
    const msg = `${prefix || 'Te faltan'} <strong>$${money(missing)}</strong> ${suffix || 'para envio gratis.'}`.trim();
    return {
      pct: Math.max(0, Math.min(100, (total / threshold) * 100)),
      message: msg,
      color,
    };
  }

  function buildLocalCuotasResult(total, cfg) {
    if (!cfg || cfg.enable_cuotas_rule === false) return null;
    const scope = String(cfg.cuotas_scope || 'all');
    if (scope !== 'all') return null;
    const threshold = Math.max(0, Number(cfg.cuotas_threshold_amount || cfg.monto_cuotas || 0));
    if (threshold <= 0) return null;
    const missing = Math.max(0, threshold - total);
    const reached = missing <= 0;
    const color = String(cfg.cuotas_bar_color || '#0ea5e9');
    if (reached) {
      return {
        pct: 100,
        message: String(cfg.cuotas_text_reached || '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>'),
        color,
      };
    }
    const prefix = String(cfg.cuotas_text_prefix || '').trim();
    const suffix = String(cfg.cuotas_text_suffix || '').trim();
    const msg = `${prefix || 'Te faltan'} <strong>$${money(missing)}</strong> ${suffix || 'para cuotas sin interes.'}`.trim();
    return {
      pct: Math.max(0, Math.min(100, (total / threshold) * 100)),
      message: msg,
      color,
    };
  }

  function requiresRemoteEvaluation(cfg) {
    if (!cfg) return true;

    const envioEnabled = cfg.enable_envio_rule !== false;
    const cuotasEnabled = cfg.enable_cuotas_rule !== false;
    const regaloEnabled = cfg.enable_regalo_rule !== false;

    const envioScope = String(cfg.envio_scope || 'all');
    const cuotasScope = String(cfg.cuotas_scope || 'all');
    const regaloMode = String(cfg.regalo_mode || 'combo_products');
    const regaloMinAmount = Math.max(0, Number(cfg.regalo_min_amount || cfg.monto_regalo || 0));
    const regaloPrimary = String(cfg.regalo_primary_product_id || '').trim();
    const regaloSecondary = String(cfg.regalo_secondary_product_id || '').trim();
    const regaloTargetQty = Math.max(0, Number(cfg.regalo_target_qty || 0));
    const regaloTargetProduct = String(cfg.regalo_target_product_id || '').trim();
    const regaloTargetCategory = String(cfg.regalo_target_category_id || '').trim();

    if (envioEnabled && envioScope !== 'all') return true;
    if (cuotasEnabled && cuotasScope !== 'all') return true;
    if (regaloEnabled) {
      if (regaloMode === 'combo_products') {
        if (regaloMinAmount > 0 && regaloPrimary && regaloSecondary) return true;
      } else if (regaloMode === 'target_rule') {
        if (regaloTargetQty > 0 && (regaloTargetProduct || regaloTargetCategory)) return true;
      } else {
        return true;
      }
    }

    return false;
  }

  function ensureStoreContext() {
    const detected = detectStoreId();
    if (!detected) return null;
    if (state.lastStoreIdSynced !== detected) {
      state.lastStoreIdSynced = detected;
      state.lastConfigFetchAt = 0;
      try {
        const cachedCfg = window.localStorage ? window.localStorage.getItem(getConfigCacheKey()) : null;
        if (cachedCfg) state.liveConfig = JSON.parse(cachedCfg);
      } catch (_) {}
      loadConfig(true).catch(function () {});
    }
    return detected;
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

  function render(totalAmount, cartSnapshot) {
    if (isCartEmpty(cartSnapshot)) {
      removeBar();
      return;
    }

    const wrapper = ensureBarMounted();
    if (!wrapper) return;

    const fill = document.getElementById('tn-progressbar-fill');
    const text = document.getElementById('tn-progressbar-text');
    if (!fill || !text) return;

    const adv = state.advanced;
    const localCfg = state.liveConfig;
    const total = Number(totalAmount || 0);
    const advFresh = !!(adv && Math.abs(Number(adv.cart_total || 0) - total) < 0.01);
    const hasAdminCfg = !!localCfg;

    const regaloResult = advFresh ? buildRegaloResult(adv.regalo) : null;
    const cuotasResult = (advFresh && adv.cuotas) ? buildCuotasResult(adv.cuotas) : buildLocalCuotasResult(total, localCfg);
    const envioResult = (advFresh && adv.envio) ? buildEnvioResult(adv.envio) : buildLocalEnvioResult(total, localCfg);

    let result = null;
    if (hasAdminCfg) {
      result = regaloResult || cuotasResult || envioResult || { pct: 0, message: '&nbsp;', color: '' };
    } else if (advFresh) {
      result = regaloResult || cuotasResult || envioResult || renderDefault(total);
    } else {
      result = { pct: 0, message: '&nbsp;', color: '' };
    }

    fill.style.width = `${Math.max(0, Math.min(100, result.pct))}%`;
    if (result.color) {
      fill.style.background = result.color;
    } else {
      fill.style.background = '';
    }
    text.innerHTML = result.message || '&nbsp;';
  }

  function buildCartSnapshot(cart, forcedTotalAmount) {
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

    const totalAmount = (forcedTotalAmount != null ? Number(forcedTotalAmount) : null)
      || getSubtotalAmount()
      || toAmount(c.total)
      || items.reduce((acc, i) => acc + Number(i.line_total || 0), 0);
    return {
      total_amount: Number(totalAmount || 0),
      items,
    };
  }

  async function evaluateAdvanced(cartSnapshot) {
    if (!ensureStoreContext()) return;
    if (!requiresRemoteEvaluation(state.liveConfig)) {
      state.advanced = null;
      return;
    }

    const now = Date.now();
    const signature = JSON.stringify({
      total: cartSnapshot.total_amount,
      items: cartSnapshot.items.map((i) => [i.product_id, i.quantity, i.line_total]),
    });

    if (state.lastSignature === signature && now - state.lastEvalAt < 120) return;

    state.lastSignature = signature;
    state.lastEvalAt = now;
    const seq = ++state.evalSeq;

    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(function () { controller.abort(); }, 1800);
      const res = await fetch(`${baseUrl}/api/goals/${encodeURIComponent(storeId)}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartSnapshot),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== state.evalSeq) return;
      state.advanced = data;
      render(cartSnapshot.total_amount, cartSnapshot);
    } catch (_) {
      // Keep default rendering if evaluation endpoint is unavailable.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function scheduleEvaluate(cartSnapshot) {
    if (!requiresRemoteEvaluation(state.liveConfig)) return;
    if (state.evalTimer) clearTimeout(state.evalTimer);
    state.evalTimer = setTimeout(function () {
      state.evalTimer = null;
      evaluateAdvanced(cartSnapshot).catch(function () {});
    }, 60);
  }

  function scheduleRenderFromDom(shouldEvaluate) {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      const amount = getSubtotalAmount();
      if (amount != null) {
        const snapshot = buildCartSnapshot(null, amount);
        render(amount, snapshot);
        if (shouldEvaluate !== false) {
          scheduleEvaluate(snapshot);
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

  async function loadConfig(force) {
    if (!ensureStoreContext()) return;

    try {
      const now = Date.now();
      const minInterval = state.liveConfig ? 5000 : 1000;
      if (!force && now - state.lastConfigFetchAt < minInterval) return;
      state.lastConfigFetchAt = now;
      const ts = Date.now();
      const res = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}?_=${ts}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      state.liveConfig = data || null;
      if (!requiresRemoteEvaluation(state.liveConfig)) {
        state.advanced = null;
      }
      try {
        if (window.localStorage && data) {
          window.localStorage.setItem(getConfigCacheKey(), JSON.stringify(data));
        }
      } catch (_) {}
      if (data && data.monto_envio_gratis != null) config.envioGratis = Number(data.monto_envio_gratis);
      if (data && data.monto_cuotas != null) config.cuotasSinInteres = Number(data.monto_cuotas);
      if (data && data.monto_regalo != null) config.regaloMisterioso = Number(data.monto_regalo);
    } catch (_) {
      // Keep defaults.
    }
  }

  document.addEventListener('cart:updated', function (event) {
    ensureStoreContext();
    const cart = event && event.detail ? event.detail.cart : null;
    const snapshot = buildCartSnapshot(cart);
    render(snapshot.total_amount, snapshot);
    scheduleEvaluate(snapshot);
  });

  document.addEventListener('click', function (event) {
    const target = event && event.target;
    if (!target) return;
    const quantityControl = target.closest ? target.closest('.js-cart-quantity-btn,[data-component="quantity.plus"],[data-component="quantity.minus"]') : null;
    if (!quantityControl) return;
    scheduleRenderFromDom();
  });

  document.addEventListener('input', function (event) {
    const target = event && event.target;
    if (!target) return;
    if (target.classList && target.classList.contains('js-cart-quantity-input')) {
      scheduleRenderFromDom();
    }
  });

  ensureBarMounted();
  ensureStoreContext();
  bindSubtotalObserver();
  bindDomObserver();
  const initial = buildCartSnapshot();
  render(initial.total_amount, initial);
  scheduleEvaluate(initial);

  loadConfig(true).then(function () {
    const amount = getSubtotalAmount();
    const snapshot = buildCartSnapshot(null, amount);
    render(snapshot.total_amount, snapshot);
    scheduleEvaluate(snapshot);
  }).catch(function () {});

  setInterval(function () {
    ensureStoreContext();
    scheduleRenderFromDom(false);
    const amount = getSubtotalAmount();
    const snapshot = buildCartSnapshot(null, amount);
    if (isCartEmpty(snapshot)) {
      removeBar();
      return;
    }
    scheduleEvaluate(snapshot);
  }, 180);

  setInterval(function () {
    loadConfig().then(function () {
      const amount = getSubtotalAmount();
      const snapshot = buildCartSnapshot(null, amount);
      render(snapshot.total_amount, snapshot);
      scheduleEvaluate(snapshot);
    }).catch(function () {});
  }, 1000);
})();









