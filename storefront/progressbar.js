(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  const api = factory();
  if (root) {
    root.__TN_PROGRESSBAR_HELPERS__ = api;
    api.init(root);
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const APP_VERSION = '2026-02-24-19';

  function clampPct(pct) {
    const n = Number(pct || 0);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

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

  function parseSubtotalFromText(text) {
    if (!text) return null;
    const raw = String(text).trim().replace(/\s+/g, '');
    const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function parseConfigNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      // Accept "40000", "40000.00", "40.000", "40.000,00"
      const normalized = s.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
      const n = Number.parseFloat(normalized);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function pickThreshold(primary, fallback) {
    const a = parseConfigNumber(primary);
    const b = parseConfigNumber(fallback);
    if (a != null && b != null) return Math.max(a, b);
    if (a != null) return a;
    if (b != null) return b;
    return 0;
  }

  function decideEmpty(input) {
    const now = Number(input && input.now) || Date.now();
    const lastEvidenceAt = Number(input && input.lastEvidenceAt) || 0;
    const stableMs = Number(input && input.stableMs) || 300;
    const lsCount = input && typeof input.lsCount === 'number' ? input.lsCount : null;
    const hasItems = !!(input && input.hasItems);
    const subtotal = input && typeof input.subtotal === 'number' ? input.subtotal : null;
    const emptyVisible = !!(input && input.emptyVisible);

    // Any evidence of non-empty wins immediately.
    if (lsCount != null && lsCount > 0) return false;
    if (hasItems) return false;
    if (subtotal != null && subtotal > 0) return false;

    // If LS is available and says 0, treat as empty (but allow for transient states).
    if (lsCount === 0) {
      return now - lastEvidenceAt > stableMs;
    }

    // Without LS, require explicit empty view to avoid false negatives.
    if (!emptyVisible) return false;
    return now - lastEvidenceAt > stableMs;
  }

  function buildLocalEnvioResult(total, cfg) {
    if (!cfg || cfg.enable_envio_rule === false) return null;
    const scope = String(cfg.envio_scope || 'all');
    if (scope !== 'all') return null;

    const threshold = Math.max(0, pickThreshold(cfg.envio_min_amount, cfg.monto_envio_gratis));
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
      pct: clampPct((total / threshold) * 100),
      message: msg,
      color,
    };
  }

  function buildLocalCuotasResult(total, cfg) {
    if (!cfg || cfg.enable_cuotas_rule === false) return null;
    const scope = String(cfg.cuotas_scope || 'all');
    if (scope !== 'all') return null;

    const threshold = Math.max(0, pickThreshold(cfg.cuotas_threshold_amount, cfg.monto_cuotas));
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
      pct: clampPct((total / threshold) * 100),
      message: msg,
      color,
    };
  }

  function renderDefault(total, cfg) {
    const envioGoal = Math.max(0, Number((cfg && (cfg.envio_min_amount || cfg.monto_envio_gratis)) || 50000));
    const regaloGoal = Math.max(0, Number((cfg && (cfg.regalo_min_amount || cfg.monto_regalo)) || 100000));

    if (envioGoal > 0 && total < envioGoal) {
      const missing = envioGoal - total;
      return {
        pct: clampPct((total / envioGoal) * 100),
        message: `Te faltan <strong>$${money(missing)}</strong> para envio gratis`,
        color: '#2563eb',
      };
    }

    if (regaloGoal > 0 && total < regaloGoal) {
      const missing = regaloGoal - total;
      return {
        pct: clampPct((total / regaloGoal) * 100),
        message: `<span class="tn-progressbar__ok">Envio gratis activado</span>. Te faltan <strong>$${money(missing)}</strong> para un regalo`,
        color: '#2563eb',
      };
    }

    return {
      pct: 100,
      message: '<span class="tn-progressbar__ok">Felicitaciones, ya tenes todos los beneficios.</span>',
      color: '#2563eb',
    };
  }

  function requiresRemoteEvaluation(cfg) {
    if (!cfg) return false;

    const envioScope = String(cfg.envio_scope || 'all');
    const cuotasScope = String(cfg.cuotas_scope || 'all');
    const regaloMode = String(cfg.regalo_mode || 'combo_products');

    if (cfg.enable_envio_rule !== false && envioScope !== 'all') return true;
    if (cfg.enable_cuotas_rule !== false && cuotasScope !== 'all') return true;

    if (cfg.enable_regalo_rule !== false) {
      if (regaloMode === 'combo_products') {
        const min = Math.max(0, Number(cfg.regalo_min_amount || 0));
        const p1 = String(cfg.regalo_primary_product_id || '').trim();
        const p2 = String(cfg.regalo_secondary_product_id || '').trim();
        if (min > 0 && p1 && p2) return true;
      }
      if (regaloMode === 'target_rule') {
        const qty = Math.max(0, Number(cfg.regalo_target_qty || 0));
        const p = String(cfg.regalo_target_product_id || '').trim();
        const c = String(cfg.regalo_target_category_id || '').trim();
        if (qty > 0 && (p || c)) return true;
      }
    }

    return false;
  }

  function init(win) {
    if (!win || !win.document) return;
    if (win.__TN_PROGRESSBAR_APP_LOADED__) return;
    win.__TN_PROGRESSBAR_APP_LOADED__ = true;
    win.__TN_PROGRESSBAR_APP_VERSION__ = APP_VERSION;

    const doc = win.document;
    const scriptNode = doc.currentScript || doc.querySelector('script[data-tn-progressbar="1"]');
    const scriptSrc = (scriptNode && scriptNode.src) || '';
    const srcUrl = scriptSrc ? new URL(scriptSrc) : null;
    const baseUrl = srcUrl ? srcUrl.origin : win.location.origin;
    let storeId = srcUrl ? (srcUrl.searchParams.get('store_id') || srcUrl.searchParams.get('store')) : null;

    if (win.console && typeof win.console.info === 'function') {
      win.console.info('[ProgressBar] app version:', APP_VERSION, 'store:', storeId || 'unknown');
    }

    const state = {
      config: null,
      configLoaded: false,
      freshConfig: false,
      lastConfigFetchAt: 0,
      lastRemote: null,
      evalTimer: null,
      evalInFlight: null,
      lastEvalKey: null,
      raf: null,
      subtotalObserver: null,
      observedNode: null,
      cartObserver: null,
      observedCartRoot: null,
      modalObserver: null,
      observedModal: null,
      domObserver: null,
      lastRendered: null,
      forceLocalUntil: 0,
      barHiddenUntilConfig: false,
      lastEvidenceAt: Date.now(),
      keepVisibleUntil: 0,
      openPoller: null,
      lastSubtotalRaw: null,
    };

    function detectStoreId() {
      if (storeId) return storeId;
      try {
        const fromLs = win.LS && win.LS.store && (win.LS.store.id || win.LS.store.store_id);
        if (fromLs) {
          storeId = String(fromLs);
          return storeId;
        }
      } catch (_) {}
      try {
        const fromGlobal = win.Store && (win.Store.id || win.Store.store_id);
        if (fromGlobal) {
          storeId = String(fromGlobal);
          return storeId;
        }
      } catch (_) {}
      return null;
    }

    function getCacheKey() {
      return `tn_progressbar_cfg_${detectStoreId() || 'unknown'}`;
    }

    try {
      const cached = win.localStorage ? win.localStorage.getItem(getCacheKey()) : null;
      if (cached) {
        state.config = JSON.parse(cached);
        state.configLoaded = true;
        // Cached config is safe to render (it's already customized); refresh in background.
        state.freshConfig = true;
      }
    } catch (_) {}

    function isVisible(el) {
      if (!el) return false;
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function resolveCartRoot() {
      const bar = doc.getElementById('app-barra-progreso');
      if (bar && bar.closest) {
        const root = bar.closest('#modal-cart,[data-component="cart"],.js-ajax-cart-panel');
        if (root) return root;
      }
      return (
        doc.getElementById('modal-cart') ||
        doc.querySelector('[data-component="cart"]') ||
        doc.querySelector('.js-ajax-cart-panel') ||
        doc.body
      );
    }

    function getCartContainer() {
      return (
        doc.getElementById('modal-cart') ||
        doc.querySelector('[data-component="cart"]') ||
        doc.querySelector('.js-ajax-cart-panel') ||
        null
      );
    }

    function q(selector) {
      const root = resolveCartRoot();
      return (root && root.querySelector) ? root.querySelector(selector) : doc.querySelector(selector);
    }

    function hasCartItems() {
      const root = resolveCartRoot();
      const node = (root && root.querySelector) ? root.querySelector('.js-cart-item') : doc.querySelector('.js-cart-item');
      return !!node;
    }

    function getLsItemCount() {
      try {
        const c = (win.LS && win.LS.cart) || {};
        const list = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);
        if (!Array.isArray(list)) return null;
        return list.reduce(function (acc, it) {
          const q0 = Math.max(0, Number(it && it.quantity) || 0);
          return acc + q0;
        }, 0);
      } catch (_) {
        return null;
      }
    }

    function isCartEmpty() {
      // During quantity changes, Tiendanube can briefly show the empty view.
      // Keep bar visible during that transient window.
      if (Date.now() < state.keepVisibleUntil) return false;

      const lsCount = getLsItemCount();
      const emptyState = q('.js-empty-ajax-cart');
      const emptyVisible = !!(emptyState && isVisible(emptyState));
      const hasItems = hasCartItems();
      const subtotal = getSubtotalAmount();

      if ((lsCount != null && lsCount > 0) || hasItems || (subtotal != null && subtotal > 0)) {
        state.lastEvidenceAt = Date.now();
      }

      return decideEmpty({
        now: Date.now(),
        lastEvidenceAt: state.lastEvidenceAt,
        // Be more conservative before declaring the cart empty to avoid
        // flicker while the theme re-renders the cart and subtotal.
        stableMs: 900,
        lsCount,
        hasItems,
        subtotal,
        emptyVisible,
      });
    }

    function isCartOpen() {
      const modal = doc.getElementById('modal-cart');
      if (modal) {
        if (modal.classList && modal.classList.contains('modal-show')) return true;
        return isVisible(modal);
      }
      const root = getCartContainer();
      if (!root) return false;
      return isVisible(root);
    }

    function maybeStartCartOpenPoll() {
      if (!isCartOpen()) {
        if (state.openPoller) {
          try { clearInterval(state.openPoller); } catch (_) {}
          state.openPoller = null;
        }
        return;
      }

      if (state.openPoller) return;

      // Low-cost local poll while the modal is open. This covers themes that update
      // totals without firing observable attribute mutations.
      state.openPoller = setInterval(function () {
        if (!isCartOpen()) {
          try { clearInterval(state.openPoller); } catch (_) {}
          state.openPoller = null;
          return;
        }

        patchLsCartMethods();
        ensureBarMounted();

        const node = getSubtotalNode();
        const raw = node && node.getAttribute ? node.getAttribute('data-priceraw') : null;
        if (raw != null && raw !== state.lastSubtotalRaw) {
          state.lastSubtotalRaw = raw;
        }

        scheduleRender();
      }, 80);
    }

    function getCartRoot() {
      return (
        doc.getElementById('modal-cart') ||
        doc.querySelector('[data-component="cart"]') ||
        doc.querySelector('.js-ajax-cart-panel') ||
        doc.body
      );
    }

    function getSubtotalNode() {
      return (
        q('.js-subtotal-price[data-priceraw]') ||
        q('.js-ajax-cart-total.js-cart-subtotal') ||
        q('[data-component="cart.subtotal"]') ||
        q('.js-cart-total[data-priceraw]') ||
        null
      );
    }

    function getSubtotalAmount() {
      const node = getSubtotalNode();
      if (!node) return null;
      const raw = node.getAttribute('data-priceraw');
      if (raw != null && raw !== '') {
        const cents = Number(raw);
        if (Number.isFinite(cents)) return cents / 100;
      }
      return parseSubtotalFromText(node.textContent || '');
    }

    function getLineItemsTotal() {
      const root = resolveCartRoot();
      const nodes = (root && root.querySelectorAll) ? root.querySelectorAll('.js-cart-item-subtotal') : [];
      if (!nodes || !nodes.length) return null;
      let sum = 0;
      let found = 0;
      for (let i = 0; i < nodes.length; i++) {
        const v = parseSubtotalFromText(nodes[i].textContent || '');
        if (v == null) continue;
        sum += v;
        found += 1;
      }
      if (!found) return null;
      return sum;
    }

    function getLsTotal() {
      try {
        const c = (win.LS && win.LS.cart) || {};
        const direct = toAmount(c.total);
        if (direct != null && direct > 0) return direct;

        // Fallback: recompute total from items when LS.cart.total is
        // missing, stale or zero. This makes the first render after
        // adding products much more reliable across themes.
        const list = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);
        if (!Array.isArray(list) || !list.length) return direct;

        let sum = 0;
        let found = 0;
        for (let i = 0; i < list.length; i++) {
          const item = list[i] || {};
          const qty = Math.max(1, Number(item.quantity || 1));
          const unit = toAmount(item.unit_price || item.price || item.unitPrice || item.base_price);
          const lineRaw = item.line_total || item.subtotal || item.total || item.line_price;
          const line = toAmount(lineRaw) || (unit != null ? unit * qty : null);
          if (line == null) continue;
          sum += line;
          found += 1;
        }
        if (!found) return direct;
        return sum;
      } catch (_) {
        return null;
      }
    }

    function getCurrentTotal() {
      const fromDom = getSubtotalAmount();
      if (fromDom != null) return Number(fromDom);
      const fromLines = getLineItemsTotal();
      if (fromLines != null) return Number(fromLines);
      const fromLs = getLsTotal();
      if (fromLs != null) return Number(fromLs);
      return null;
    }

    function ensureBarMounted() {
      const existing = doc.getElementById('app-barra-progreso');
      if (existing) return existing;

      const container = getCartContainer();
      if (!container) return null;

      const wrapper = doc.createElement('div');
      wrapper.id = 'app-barra-progreso';
      wrapper.className = 'tn-progressbar';
      wrapper.innerHTML = [
        '<div class="tn-progressbar__text" id="tn-progressbar-text">&nbsp;</div>',
        '<div class="tn-progressbar__track">',
        '  <div class="tn-progressbar__fill" id="tn-progressbar-fill"></div>',
        '</div>',
      ].join('');

      const root = container;
      const cartList = root.querySelector ? root.querySelector('.js-ajax-cart-list') : null;
      if (cartList) {
        // Insert before the modal body so it survives list/body rerenders.
        const panel = root.querySelector ? root.querySelector('.js-ajax-cart-panel') : null;
        const body = (panel || root).querySelector ? (panel || root).querySelector('.modal-body') : null;
        if (body && body.parentNode) {
          body.parentNode.insertBefore(wrapper, body);
          return wrapper;
        }
        if (cartList.parentNode) {
          cartList.parentNode.insertBefore(wrapper, cartList);
          return wrapper;
        }
      }

      const subtotalRow = root.querySelector ? root.querySelector('[data-store="cart-subtotal"]') : null;
      if (subtotalRow && subtotalRow.parentNode) {
        subtotalRow.parentNode.insertBefore(wrapper, subtotalRow);
        return wrapper;
      }

      const modalBody = root.querySelector ? root.querySelector('.modal-body') : null;
      if (modalBody) {
        modalBody.insertBefore(wrapper, modalBody.firstChild);
        return wrapper;
      }

      const anchor = getSubtotalNode() || (root.querySelector ? root.querySelector('.js-cart-item') : null);
      if (!anchor || !anchor.parentNode) return null;
      anchor.parentNode.insertBefore(wrapper, anchor);
      return wrapper;
    }

    function removeBar() {
      const node = doc.getElementById('app-barra-progreso');
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    function setBarVisible(visible) {
      const node = doc.getElementById('app-barra-progreso');
      if (!node) return;
      node.style.display = visible ? '' : 'none';
    }

    function buildUiResult(total) {
      const cfg = state.config;
      const localEnvio = buildLocalEnvioResult(total, cfg);
      const localCuotas = buildLocalCuotasResult(total, cfg);
      const preferLocalOnly = Date.now() < state.forceLocalUntil;

      if (!state.configLoaded) {
        // Don't show defaults while config is still loading.
        return state.lastRendered || { pct: 0, message: '&nbsp;', color: '#2563eb' };
      }

      if (!preferLocalOnly && state.lastRemote && Math.abs(Number(state.lastRemote.cart_total || 0) - total) < 0.01) {
        const remote = state.lastRemote;
        if (remote.regalo && remote.regalo.enabled) {
          const color = String(remote.regalo.bar_color || '#a855f7');
          if (remote.regalo.reached) {
            return {
              pct: 100,
              message: String(remote.regalo.text_reached || '<span class="tn-progressbar__ok">Regalo desbloqueado.</span>'),
              color,
            };
          }
          const pfx = String(remote.regalo.text_prefix || '').trim();
          const sfx = String(remote.regalo.text_suffix || '').trim();
          return {
            pct: clampPct(Number(remote.regalo.progress || 0) * 100),
            message: `${pfx || 'Te faltan'} <strong>$${money(remote.regalo.missing_amount || 0)}</strong> ${sfx || ''}`.trim(),
            color,
          };
        }

        if (remote.cuotas && remote.cuotas.enabled && remote.cuotas.scope !== 'all') {
          const color = String(remote.cuotas.bar_color || '#0ea5e9');
          if (remote.cuotas.reached) {
            return {
              pct: 100,
              message: String(remote.cuotas.text_reached || '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>'),
              color,
            };
          }
          const pfx = String(remote.cuotas.text_prefix || '').trim();
          const sfx = String(remote.cuotas.text_suffix || '').trim();
          return {
            pct: clampPct(Number(remote.cuotas.progress || 0) * 100),
            message: `${pfx || 'Te faltan'} <strong>$${money(remote.cuotas.missing_amount || 0)}</strong> ${sfx || ''}`.trim(),
            color,
          };
        }

        if (remote.envio && remote.envio.enabled && remote.envio.scope !== 'all') {
          const color = String(remote.envio.bar_color || '#2563eb');
          if (remote.envio.reached) {
            return {
              pct: 100,
              message: String(remote.envio.text_reached || '<span class="tn-progressbar__ok">Envio gratis activado.</span>'),
              color,
            };
          }
          const pfx = String(remote.envio.text_prefix || '').trim();
          const sfx = String(remote.envio.text_suffix || '').trim();
          return {
            pct: clampPct(Number(remote.envio.progress || 0) * 100),
            message: `${pfx || 'Te faltan'} <strong>$${money(remote.envio.missing_amount || 0)}</strong> ${sfx || ''}`.trim(),
            color,
          };
        }
      }

      // If admin config exists, never fall back to default copy/colors.
      if (state.configLoaded) {
        return localEnvio || localCuotas || null;
      }

      return renderDefault(total, cfg);
    }

    function renderNow() {
      if (isCartEmpty()) {
        // Keep DOM node to avoid flicker; just hide it.
        setBarVisible(false);
        state.barHiddenUntilConfig = false;
        if (state.evalTimer) {
          try { clearTimeout(state.evalTimer); } catch (_) {}
          state.evalTimer = null;
        }
        if (state.evalInFlight) {
          try { state.evalInFlight.abort(); } catch (_) {}
          state.evalInFlight = null;
        }
        return;
      }
      const wrapper = ensureBarMounted();
      if (!wrapper) return;

      const fill = doc.getElementById('tn-progressbar-fill');
      const text = doc.getElementById('tn-progressbar-text');
      if (!fill || !text) return;

      // Always force visible when cart is not empty.
      state.barHiddenUntilConfig = false;
      setBarVisible(true);

      const total = getCurrentTotal();
      if (total == null) {
        // During cart ajax rerenders, totals can disappear momentarily.
        // Keep the last rendered state instead of flashing/hiding.
        if (state.lastRendered) {
          fill.style.width = `${clampPct(state.lastRendered.pct)}%`;
          fill.style.background = state.lastRendered.color || '#2563eb';
          text.innerHTML = state.lastRendered.message || '&nbsp;';
        }
        return;
      }

      const result = buildUiResult(total);
      if (!result) {
        // When the cart is not empty but there is no specific rule to show
        // (or config is in an intermediate state), keep the bar visible with
        // a neutral fallback instead of hiding it. This avoids flicker and
        // “missing bar” glitches while configuration or remote evaluation
        // catch up.
        setBarVisible(true);
        const fallback = state.lastRendered || { pct: 0, message: '&nbsp;', color: '#2563eb' };
        fill.style.width = `${clampPct(fallback.pct)}%`;
        fill.style.backgroundImage = 'none';
        fill.style.backgroundColor = fallback.color || '#2563eb';
        text.innerHTML = fallback.message || '&nbsp;';
        state.lastRendered = fallback;
        return;
      }

      fill.style.width = `${clampPct(result.pct)}%`;
      fill.style.backgroundImage = 'none';
      fill.style.backgroundColor = result.color || '#2563eb';
      text.innerHTML = result.message || '&nbsp;';
      state.lastRendered = result;
    }

    function scheduleRender() {
      if (state.raf) win.cancelAnimationFrame(state.raf);
      state.raf = win.requestAnimationFrame(function () {
        state.raf = null;
        renderNow();
      });
    }

    function buildSnapshot() {
      const c = (win.LS && win.LS.cart) || {};
      const list = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);
      const items = list.map(function (item) {
        const pid = String(item.product_id || item.id || (item.product && item.product.id) || '').trim();
        const qty = Math.max(1, Number(item.quantity || 1));
        const unit = toAmount(item.unit_price || item.price || item.unitPrice || item.base_price);
        const lineRaw = item.line_total || item.subtotal || item.total || item.line_price;
        const line = toAmount(lineRaw) || (unit != null ? unit * qty : 0);
        const categories = Array.isArray(item.categories) ? item.categories.map(function (c0) { return String((c0 && c0.id) || c0); }) : [];
        return { product_id: pid, quantity: qty, unit_price: unit != null ? unit : 0, line_total: line, categories };
      }).filter(function (i) { return i.product_id; });

      const total = getCurrentTotal();
      return { total_amount: Number(total || 0), items };
    }

    function buildEvalKey(snapshot) {
      // Stable-ish key: avoid spamming server when nothing relevant changed.
      const total = Number(snapshot && snapshot.total_amount) || 0;
      const items = Array.isArray(snapshot && snapshot.items) ? snapshot.items : [];
      const parts = [String(total.toFixed(2)), String(items.length)];
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        parts.push(String(it.product_id || ''));
        parts.push(String(it.quantity || 0));
        parts.push(String(Number(it.line_total || 0).toFixed(2)));
      }
      return parts.join('|');
    }

    async function evaluateRemote() {
      if (!detectStoreId()) return;
      if (isCartEmpty()) return;
      if (!requiresRemoteEvaluation(state.config)) {
        state.lastRemote = null;
        return;
      }

      const snapshot = buildSnapshot();
      const evalKey = buildEvalKey(snapshot);
      if (state.lastEvalKey === evalKey && state.evalInFlight) return;
      state.lastEvalKey = evalKey;

      if (state.evalTimer) clearTimeout(state.evalTimer);
      // Use a very small debounce so that evaluation feels instant
      // while still coalescing rapid bursts of changes.
      state.evalTimer = setTimeout(async function () {
        try {
          if (state.evalInFlight) {
            try { state.evalInFlight.abort(); } catch (_) {}
          }
          const controller = new AbortController();
          state.evalInFlight = controller;
          const abortTimer = setTimeout(function () { controller.abort(); }, 1200);
          const res = await fetch(`${baseUrl}/api/goals/${encodeURIComponent(storeId)}/evaluate`, {
            method: 'POST',
            // Avoid CORS preflight: application/json triggers OPTIONS.
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(snapshot),
            signal: controller.signal,
          });
          clearTimeout(abortTimer);
          if (state.evalInFlight === controller) state.evalInFlight = null;
          if (!res.ok) return;
          const data = await res.json();
          state.lastRemote = data;
          renderNow();
        } catch (_) {}
      }, 20);
    }

    async function loadConfig(force) {
      if (!detectStoreId()) return;
      const now = Date.now();
      const minInterval = state.config ? 3000 : 400;
      if (!force && now - state.lastConfigFetchAt < minInterval) return;
      state.lastConfigFetchAt = now;

      try {
        const res = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        state.config = data || null;
        state.configLoaded = !!data;
        state.freshConfig = !!data;
        try {
          if (win.localStorage && data) {
            win.localStorage.setItem(getCacheKey(), JSON.stringify(data));
          }
        } catch (_) {}
        renderNow();
        evaluateRemote();
      } catch (_) {}
    }

    function bindSubtotalObserver() {
      const node = getSubtotalNode();
      if (!node) return;
      if (state.observedNode === node) return;
      if (state.subtotalObserver) {
        state.subtotalObserver.disconnect();
      }
      state.observedNode = node;
      state.subtotalObserver = new MutationObserver(function () {
        scheduleRender();
        evaluateRemote();
      });
      state.subtotalObserver.observe(node, {
        attributes: true,
        attributeFilter: ['data-priceraw', 'data-component-value'],
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    function bindCartObserver() {
      const root = resolveCartRoot();
      if (!root) return;
      if (state.observedCartRoot === root) return;
      if (state.cartObserver) state.cartObserver.disconnect();
      state.observedCartRoot = root;
      state.cartObserver = new MutationObserver(function (mutations) {
        for (let i = 0; i < mutations.length; i++) {
          const m = mutations[i];
          const t = m && m.target;
          if (!t || t.nodeType !== 1) continue;
          // Themes often update totals by mutating data-priceraw on hidden nodes.
          if (t.getAttribute && t.getAttribute('data-priceraw') != null) {
            scheduleRender();
            evaluateRemote();
            return;
          }
        }
      });
      state.cartObserver.observe(root, {
        attributes: true,
        attributeFilter: ['data-priceraw', 'data-component-value', 'style', 'class'],
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    function bindModalObserver() {
      const modal = doc.getElementById('modal-cart') || doc.querySelector('[data-component="cart"]');
      if (!modal) return;
      if (state.observedModal === modal) return;
      if (state.modalObserver) state.modalObserver.disconnect();
      state.observedModal = modal;
      state.modalObserver = new MutationObserver(function () {
        try {
          maybeStartCartOpenPoll();
          ensureBarMounted();
          scheduleRender();
        } catch (_) {}
      });
      state.modalObserver.observe(modal, {
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-hidden'],
      });
    }

    function bindDomObserver() {
      if (state.domObserver) return;
      state.domObserver = new MutationObserver(function () {
        ensureBarMounted();
        bindSubtotalObserver();
        bindCartObserver();
        bindModalObserver();
        maybeStartCartOpenPoll();
        patchLsCartMethods();
        scheduleRender();
      });
      state.domObserver.observe(doc.body, { childList: true, subtree: true });
    }

    function pulseRefresh(options) {
      const keepMsRaw = options && options.keepMs;
      const keepMs = Number.isFinite(Number(keepMsRaw)) ? Number(keepMsRaw) : 3500;
      const end = Date.now() + 1400;
      state.forceLocalUntil = Date.now() + 1600;
      state.keepVisibleUntil = Date.now() + Math.max(0, keepMs);
      maybeStartCartOpenPoll();
      const tick = function () {
        scheduleRender();
        evaluateRemote();
        if (Date.now() < end) setTimeout(tick, 70);
      };
      tick();
    }

    function patchLsCartMethods() {
      const LS = win.LS;
      if (!LS || typeof LS !== 'object') return;

      const methods = [
        'addToCart',
        'addItem',
        'addProduct',
        'removeItem',
        'removeProduct',
        'plusQuantity',
        'minusQuantity',
        'updateQuantity',
        'setQuantity',
        'updateCart',
      ];

      methods.forEach(function (name) {
        const fn = LS[name];
        if (typeof fn !== 'function') return;
        if (fn.__tnProgressbarWrapped) return;

        function wrapped() {
          let out;
          try {
            out = fn.apply(LS, arguments);
          } catch (err) {
            try {
              const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
              pulseRefresh({ keepMs });
            } catch (_) {}
            throw err;
          }

          try {
            const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
            pulseRefresh({ keepMs });
          } catch (_) {}

          if (out && typeof out.then === 'function') {
            return out.finally(function () {
              try {
                const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
                pulseRefresh({ keepMs });
              } catch (_) {}
            });
          }
          return out;
        }

        wrapped.__tnProgressbarWrapped = true;
        LS[name] = wrapped;
      });
    }

    doc.addEventListener('cart:updated', function () {
      scheduleRender();
      evaluateRemote();
    });

    doc.addEventListener('click', function (event) {
      const target = event && event.target;
      if (!target) return;
      const ctrl = target.closest ? target.closest('.js-cart-quantity-btn,[data-component="quantity.plus"],[data-component="quantity.minus"]') : null;
      if (!ctrl) return;
      pulseRefresh();
    }, true);

    doc.addEventListener('input', function (event) {
      const target = event && event.target;
      if (!target) return;
      if (target.classList && target.classList.contains('js-cart-quantity-input')) {
        pulseRefresh();
      }
    }, true);

    ensureBarMounted();
    bindSubtotalObserver();
    bindCartObserver();
    bindModalObserver();
    bindDomObserver();
    renderNow();

    loadConfig(true).catch(function () {});
    maybeStartCartOpenPoll();
    patchLsCartMethods();

    // Store id can arrive late (LS boot). Keep trying briefly.
    (function waitForStoreId() {
      let tries = 0;
      const tick = function () {
        tries += 1;
        const sid = detectStoreId();
        if (sid) {
          loadConfig(true).catch(function () {});
          patchLsCartMethods();
          scheduleRender();
          return;
        }
        if (tries < 40) setTimeout(tick, 150);
      };
      tick();
    })();

    // Gentle retries for cold starts; observers will still keep UI in sync.
    (function retryConfig() {
      if (state.configLoaded) return;
      setTimeout(function () { loadConfig(true).catch(function () {}); }, 300);
      setTimeout(function () { loadConfig(true).catch(function () {}); }, 1000);
      setTimeout(function () { loadConfig(true).catch(function () {}); }, 3000);
    })();

    // No aggressive polling. Cart DOM observers + explicit events drive updates.
  }

  return {
    APP_VERSION,
    clampPct,
    toAmount,
    parseSubtotalFromText,
    parseConfigNumber,
    pickThreshold,
    decideEmpty,
    buildLocalEnvioResult,
    buildLocalCuotasResult,
    renderDefault,
    requiresRemoteEvaluation,
    init,
  };
});


