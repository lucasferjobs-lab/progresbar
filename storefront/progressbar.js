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
  const APP_VERSION = '2026-02-25-17';

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

    // If LS is available and says 0, only treat as empty when the theme is
    // also showing the explicit empty view. LS can transiently reset to 0
    // during cart rerenders even when there are items.
    if (lsCount === 0) {
      if (!emptyVisible) return false;
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
    const bootAt = Date.now();

    // Intentionally no console logs in production.

    const state = {
      config: null,
      configLoaded: false,
      freshConfig: false,
      lastConfigFetchAt: 0,
      lastRemote: null,
      evalTimer: null,
      evalInFlight: null,
      lastEvalKey: null,
      lastEvalAt: 0,
      pendingEvalSnapshot: null,
      pendingEvalKey: null,
      raf: null,
      subtotalObserver: null,
      observedNode: null,
      cartObserver: null,
      observedCartRoot: null,
      modalObserver: null,
      observedModal: null,
      domObserver: null,
      maintenanceTimer: null,
      lastRendered: null,
      forceLocalUntil: 0,
      barHiddenUntilConfig: false,
      // Timestamp of the last strong non-empty signal. Start at 0 so an empty
      // cart does not show anything until we see evidence of items.
      lastEvidenceAt: 0,
      keepVisibleUntil: 0,
      openPoller: null,
      lastSubtotalRaw: null,
      burstInterval: null,
      burstUntil: 0,
    };

    const debugEnabled = (function () {
      try {
        if (srcUrl && srcUrl.searchParams && srcUrl.searchParams.get('debug') === '1') return true;
        if (srcUrl && srcUrl.searchParams && srcUrl.searchParams.get('tn_progressbar_debug') === '1') return true;
        return !!(win.localStorage && win.localStorage.getItem('tn_progressbar_debug') === '1');
      } catch (_) {
        return false;
      }
    })();

    const debugLog = [];

    function dbg(event, details, level) {
      if (!debugEnabled) return;
      try {
        const t = Date.now();
        debugLog.push({ t, dt: t - bootAt, event: String(event || ''), details: details || null });
        if (debugLog.length > 400) debugLog.shift();
        void level;
      } catch (_) {}
    }

    try {
      win.__TN_PROGRESSBAR_DEBUG__ = {
        enabled: debugEnabled,
        dump: function () { return debugLog.slice(); },
        state: function () {
          try {
            const cfg = state.config || null;
            return {
              app_version: APP_VERSION,
              store_id: detectStoreId(),
              config_loaded: !!state.configLoaded,
              has_config: !!state.config,
              envio: cfg ? {
                enabled: cfg.enable_envio_rule,
                scope: cfg.envio_scope,
                min_amount: cfg.envio_min_amount,
                monto_envio_gratis: cfg.monto_envio_gratis,
                product_id: cfg.envio_product_id,
                category_id: cfg.envio_category_id,
                bar_color: cfg.envio_bar_color,
              } : null,
              cuotas: cfg ? {
                enabled: cfg.enable_cuotas_rule,
                scope: cfg.cuotas_scope,
                threshold_amount: cfg.cuotas_threshold_amount,
                monto_cuotas: cfg.monto_cuotas,
                product_id: cfg.cuotas_product_id,
                category_id: cfg.cuotas_category_id,
                bar_color: cfg.cuotas_bar_color,
              } : null,
              regalo: cfg ? {
                enabled: cfg.enable_regalo_rule,
                mode: cfg.regalo_mode,
                min_amount: cfg.regalo_min_amount,
                monto_regalo: cfg.monto_regalo,
                bar_color: cfg.regalo_bar_color,
              } : null,
              last_evidence_ms_ago: state.lastEvidenceAt ? Date.now() - state.lastEvidenceAt : null,
              keep_visible_ms_left: Math.max(0, (state.keepVisibleUntil || 0) - Date.now()),
              last_subtotal_raw: state.lastSubtotalRaw,
              last_rendered: state.lastRendered,
              has_last_remote: !!state.lastRemote,
              last_eval_key: state.lastEvalKey,
              eval_in_flight: !!state.evalInFlight,
              eval_timer: !!state.evalTimer,
              pending_eval: !!state.pendingEvalSnapshot,
            };
          } catch (_) {
            return null;
          }
        },
      };
    } catch (_) {}

    function detectStoreId() {
      if (storeId) return storeId;
      try {
        const fromLs = win.LS && win.LS.store && (win.LS.store.id || win.LS.store.store_id);
        if (fromLs) {
          storeId = String(fromLs);
          dbg('store_id:resolved', { via: 'LS.store', storeId }, 'info');
          return storeId;
        }
      } catch (_) {}
      try {
        const fromGlobal = win.Store && (win.Store.id || win.Store.store_id);
        if (fromGlobal) {
          storeId = String(fromGlobal);
          dbg('store_id:resolved', { via: 'Store', storeId }, 'info');
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
        dbg('config:cache_hit', { bytes: String(cached || '').length }, 'info');
      }
    } catch (_) {}

    function isVisible(el) {
      if (!el) return false;
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function elSummary(el) {
      try {
        if (!el) return null;
        return {
          tag: String(el.tagName || '').toLowerCase(),
          id: el.id || null,
          class: typeof el.className === 'string' ? el.className : null,
          visible: isVisible(el),
        };
      } catch (_) {
        return null;
      }
    }

    function getCartContainer() {
      const nodes = [];
      function add(el) {
        if (!el) return;
        if (nodes.indexOf(el) !== -1) return;
        nodes.push(el);
      }
      add(doc.getElementById('modal-cart'));
      const others = doc.querySelectorAll ? doc.querySelectorAll('[data-component="cart"],.js-ajax-cart-panel') : [];
      for (let i = 0; i < (others ? others.length : 0); i++) add(others[i]);

      // Prefer the visible cart container (themes often keep a hidden copy).
      for (let i = 0; i < nodes.length; i++) {
        if (isVisible(nodes[i])) return nodes[i];
      }

      // If none is visible yet, prefer #modal-cart (it is usually the one that opens).
      const modal = doc.getElementById('modal-cart');
      if (modal) return modal;
      return nodes[0] || null;
    }

    function resolveCartRoot() {
      return getCartContainer() || doc.body;
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

      const empty = decideEmpty({
        now: Date.now(),
        lastEvidenceAt: state.lastEvidenceAt,
        // Be more conservative before declaring the cart empty to avoid
        // flicker while the theme re-renders the cart and subtotal.
        stableMs: 500,
        lsCount,
        hasItems,
        subtotal,
        emptyVisible,
      });

      // Only log when "empty-ness" changes (avoids console spam).
      if (debugEnabled) {
        const prev = state._lastEmpty;
        if (prev == null || prev !== empty) {
          state._lastEmpty = empty;
          dbg('empty:state', { empty, lsCount, hasItems, subtotal, emptyVisible, stableMs: 500 }, 'info');
        }
      }

      return empty;
    }

    function isCartOpen() {
      const root = getCartContainer();
      if (!root) return false;
      // Some themes keep multiple cart containers in the DOM; rely on the
      // active/visible container chosen by getCartContainer().
      if (root.id === 'modal-cart' && root.classList && root.classList.contains('modal-show')) return true;
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
        const wrapper = ensureBarMounted();

        const node = getSubtotalNode();
        const raw = node && node.getAttribute ? node.getAttribute('data-priceraw') : null;
        const changed = raw != null && raw !== state.lastSubtotalRaw;
        if (changed) state.lastSubtotalRaw = raw;

        // Only re-render when something changed; observers handle most cases.
        const fill = wrapper && wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-fill') || wrapper.querySelector('.tn-progressbar__fill,.js-pb-fill')) : null;
        const text = wrapper && wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-text') || wrapper.querySelector('.tn-progressbar__text,.js-pb-text')) : null;
        if (changed || !fill || !text) {
          scheduleRender();
          scheduleRemoteEval();
        }
      }, 140);
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
        // Prefer the visible cart subtotal element, which tends to be updated
        // first when the cart changes, and only then fall back to hidden
        // helper nodes. This reduces the chances of reading a stale zero
        // value from a hidden subtotal while the visible one already has
        // the correct amount.
        q('.js-ajax-cart-total.js-cart-subtotal') ||
        q('.js-subtotal-price[data-priceraw]') ||
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

    function parseProductIdFromCartItemNode(node) {
      if (!node || !node.getAttribute) return null;
      const storeAttr = String(node.getAttribute('data-store') || '');
      const m = storeAttr.match(/cart-item-(\d+)/);
      return m ? String(m[1]) : null;
    }

    function buildDomItemsSnapshot() {
      const container = getCartContainer();
      const root = container && container.querySelector ? container : doc;
      const nodes = root.querySelectorAll ? root.querySelectorAll('.js-cart-item[data-item-id]') : [];
      if (!nodes || !nodes.length) return [];
      const items = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!n) continue;
        const lineId = String(n.getAttribute('data-item-id') || '').trim();
        const productId = parseProductIdFromCartItemNode(n);
        const qtyNode = n.querySelector ? n.querySelector('.js-cart-quantity-input,[data-component="quantity.value"]') : null;
        const qtyRaw = qtyNode ? (qtyNode.value || qtyNode.getAttribute('value')) : null;
        const qty = Math.max(1, Number(qtyRaw || 1) || 1);
        const subtotalNode = n.querySelector ? n.querySelector('.js-cart-item-subtotal,[data-component="subtotal.value"]') : null;
        const lineTotal = parseSubtotalFromText(subtotalNode ? subtotalNode.textContent : '');

        if (!productId) continue;
        items.push({
          product_id: productId,
          quantity: qty,
          unit_price: lineTotal != null ? (lineTotal / qty) : 0,
          line_total: lineTotal != null ? lineTotal : 0,
          categories: [],
          _line_id: lineId || null,
        });
      }
      return items;
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
      // Prefer DOM subtotal: it matches what the shopper sees and tends to
      // be the most reliable after Tiendanube rerenders the cart.
      const fromDom = getSubtotalAmount();
      if (fromDom != null && fromDom > 0) return Number(fromDom);

      // Fallback to LS for the "just added" case where DOM still shows 0.
      const fromLs = getLsTotal();
      if (fromLs != null && fromLs > 0) return Number(fromLs);

      const fromLines = getLineItemsTotal();
      if (fromLines != null && fromLines > 0) return Number(fromLines);

      if (fromDom != null) return Number(fromDom);
      if (fromLs != null) return Number(fromLs);
      return null;
    }

    function ensureBarMounted() {
      const container = getCartContainer();
      if (!container) {
        dbg('mount:missing_container', null);
        return null;
      }

      // Search ONLY inside the active cart container (themes often duplicate carts).
      let existing = container.querySelector ? container.querySelector('#app-barra-progreso') : null;
      if (existing && !doc.body.contains(existing)) {
        dbg('mount:detached', null, 'warn');
        existing = null;
      }
      if (existing) {
        dbg('mount:reuse', { container: elSummary(container) }, 'debug');
        return existing;
      }

      // Cleanup any stray bars outside the active container (avoid duplicate IDs).
      try {
        const all = doc.querySelectorAll ? doc.querySelectorAll('#app-barra-progreso') : [];
        for (let i = 0; i < (all ? all.length : 0); i++) {
          const node = all[i];
          if (!node) continue;
          if (container.contains(node)) continue;
          if (node.parentNode) node.parentNode.removeChild(node);
        }
      } catch (_) {}

      const wrapper = doc.createElement('div');
      wrapper.id = 'app-barra-progreso';
      wrapper.className = 'tn-progressbar app-barra-progreso-wrapper';
      wrapper.innerHTML = [
        '<div class="tn-progressbar__text js-pb-text" id="tn-progressbar-text">&nbsp;</div>',
        '<div class="tn-progressbar__track">',
        '  <div class="tn-progressbar__fill js-pb-fill" id="tn-progressbar-fill"></div>',
        '</div>',
      ].join('');

      const root = container;
      const panel = root.querySelector ? root.querySelector('.js-ajax-cart-panel') : null;
      const body = (panel || root).querySelector ? (panel || root).querySelector('.modal-body') : null;
      const cartList = body && body.querySelector ? body.querySelector('.js-ajax-cart-list') : (root.querySelector ? root.querySelector('.js-ajax-cart-list') : null);
      if (body && cartList && cartList.parentNode) {
        // Prefer inside the cart body, right above products.
        cartList.parentNode.insertBefore(wrapper, cartList);
        dbg('mount:ok', { at: 'before_list', container: elSummary(container) }, 'info');
        return wrapper;
      }
      if (body) {
        body.insertBefore(wrapper, body.firstChild);
        dbg('mount:ok', { at: 'inside_body', container: elSummary(container) }, 'info');
        return wrapper;
      }

      const subtotalRow = root.querySelector ? root.querySelector('[data-store="cart-subtotal"]') : null;
      if (subtotalRow && subtotalRow.parentNode) {
        subtotalRow.parentNode.insertBefore(wrapper, subtotalRow);
        dbg('mount:ok', { at: 'before_subtotal', container: elSummary(container) }, 'info');
        return wrapper;
      }

      const anchor = getSubtotalNode() || (root.querySelector ? root.querySelector('.js-cart-item') : null);
      if (!anchor || !anchor.parentNode) {
        dbg('mount:no_anchor', null);
        return null;
      }
      anchor.parentNode.insertBefore(wrapper, anchor);
      dbg('mount:ok', { at: 'anchor', container: elSummary(container) }, 'info');
      return wrapper;
    }

    function removeBar() {
      try {
        const nodes = doc.querySelectorAll ? doc.querySelectorAll('#app-barra-progreso') : [];
        for (let i = 0; i < (nodes ? nodes.length : 0); i++) {
          const node = nodes[i];
          if (node && node.parentNode) node.parentNode.removeChild(node);
        }
      } catch (_) {}
    }

    function setBarVisible(visible, wrapper) {
      if (wrapper && wrapper.style) {
        wrapper.style.display = visible ? '' : 'none';
        return;
      }
      try {
        const nodes = doc.querySelectorAll ? doc.querySelectorAll('#app-barra-progreso') : [];
        for (let i = 0; i < (nodes ? nodes.length : 0); i++) {
          const node = nodes[i];
          if (!node || !node.style) continue;
          node.style.display = visible ? '' : 'none';
        }
      } catch (_) {}
    }

    function buildUiResult(total) {
      const cfg = state.config;
      const localEnvio = buildLocalEnvioResult(total, cfg);
      const localCuotas = buildLocalCuotasResult(total, cfg);
      const preferLocalOnly = Date.now() < state.forceLocalUntil;

      if (!state.configLoaded) {
        // Don't show defaults while config is still loading.
        dbg('ui:cfg_missing', null, 'debug');
        return state.lastRendered || { pct: 0, message: '&nbsp;', color: '#2563eb' };
      }

      if (debugEnabled) {
        const envioScope = String((cfg && cfg.envio_scope) || 'all');
        const cuotasScope = String((cfg && cfg.cuotas_scope) || 'all');
        const envioThreshold = Math.max(0, pickThreshold(cfg && cfg.envio_min_amount, cfg && cfg.monto_envio_gratis));
        const cuotasThreshold = Math.max(0, pickThreshold(cfg && cfg.cuotas_threshold_amount, cfg && cfg.monto_cuotas));
        dbg('ui:local', {
          total,
          preferLocalOnly,
          envio: {
            enabled: cfg ? cfg.enable_envio_rule : null,
            scope: envioScope,
            threshold: envioThreshold,
            product_id: cfg ? cfg.envio_product_id : null,
            category_id: cfg ? cfg.envio_category_id : null,
            pct: localEnvio ? localEnvio.pct : null,
          },
          cuotas: {
            enabled: cfg ? cfg.enable_cuotas_rule : null,
            scope: cuotasScope,
            threshold: cuotasThreshold,
            product_id: cfg ? cfg.cuotas_product_id : null,
            category_id: cfg ? cfg.cuotas_category_id : null,
            pct: localCuotas ? localCuotas.pct : null,
          },
        }, 'debug');
      }

      if (!preferLocalOnly && state.lastRemote && Math.abs(Number(state.lastRemote.cart_total || 0) - total) < 0.01) {
        const remote = state.lastRemote;
        if (remote.regalo && remote.regalo.enabled) {
          dbg('ui:remote', { type: 'regalo', scope: remote.regalo.scope || null, progress: remote.regalo.progress, eligible: remote.regalo.eligible_subtotal }, 'debug');
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
          dbg('ui:remote', { type: 'cuotas', scope: remote.cuotas.scope, progress: remote.cuotas.progress, eligible: remote.cuotas.eligible_subtotal }, 'debug');
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
          dbg('ui:remote', { type: 'envio', scope: remote.envio.scope, progress: remote.envio.progress, eligible: remote.envio.eligible_subtotal }, 'debug');
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
        dbg('ui:pick', { localEnvio: !!localEnvio, localCuotas: !!localCuotas }, 'debug');
        return localEnvio || localCuotas || null;
      }

      return renderDefault(total, cfg);
    }

    function renderNow() {
      dbg('render:call', { open: isCartOpen() }, 'debug');
      if (isCartEmpty()) {
        // Keep DOM node to avoid flicker; just hide it.
        setBarVisible(false);
        dbg('render:empty', {
          keepMsLeft: Math.max(0, (state.keepVisibleUntil || 0) - Date.now()),
          lsCount: getLsItemCount(),
          hasItems: hasCartItems(),
          subtotal: getSubtotalAmount(),
          emptyVisible: (function () {
            const emptyState = q('.js-empty-ajax-cart');
            return !!(emptyState && isVisible(emptyState));
          })(),
        }, 'info');
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
      if (!wrapper) {
        dbg('render:no_wrapper', null);
        return;
      }
      dbg('render:wrapper', { wrapper: elSummary(wrapper), container: elSummary(getCartContainer()) }, 'debug');

      let fill = wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-fill') || wrapper.querySelector('.tn-progressbar__fill,.js-pb-fill')) : null;
      let text = wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-text') || wrapper.querySelector('.tn-progressbar__text,.js-pb-text')) : null;
      if (!fill || !text) {
        // Cart rerenders can temporarily wipe our inner nodes. Repair in-place.
        dbg('render:missing_nodes', null, 'warn');
        try {
          wrapper.innerHTML = [
            '<div class="tn-progressbar__text js-pb-text" id="tn-progressbar-text">&nbsp;</div>',
            '<div class="tn-progressbar__track">',
            '  <div class="tn-progressbar__fill js-pb-fill" id="tn-progressbar-fill"></div>',
            '</div>',
          ].join('');
        } catch (_) {}
        fill = wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-fill') || wrapper.querySelector('.tn-progressbar__fill,.js-pb-fill')) : null;
        text = wrapper.querySelector ? (wrapper.querySelector('#tn-progressbar-text') || wrapper.querySelector('.tn-progressbar__text,.js-pb-text')) : null;
        if (!fill || !text) return;
      }

      // Always force visible when cart is not empty.
      state.barHiddenUntilConfig = false;
      setBarVisible(true, wrapper);

      const total = getCurrentTotal();
      dbg('render:total', { total }, 'debug');
      if (total == null || total < 1) {
        // During cart ajax rerenders, totals can disappear or still be zero
        // momentarily even when there are items in the cart. Avoid using a
        // zero total for goal calculations, which would show “missing” equal
        // to the full threshold and a visually “broken” bar. Instead, keep
        // the last rendered state (or a neutral placeholder) until a valid
        // total is available.
        const fallback = state.lastRendered || { pct: 0, message: '&nbsp;', color: '#2563eb' };
        fill.style.width = `${clampPct(fallback.pct)}%`;
        fill.style.backgroundImage = 'none';
        fill.style.backgroundColor = fallback.color || '#2563eb';
        text.innerHTML = fallback.message || '&nbsp;';
        state.lastRendered = fallback;
        return;
      }

      const result = buildUiResult(total);
      dbg('render:ui', { hasResult: !!result }, 'debug');
      if (!result) {
        // When the cart is not empty but there is no specific rule to show
        // (or config is in an intermediate state), keep the bar visible with
        // a neutral fallback instead of hiding it. This avoids flicker and
        // “missing bar” glitches while configuration or remote evaluation
        // catch up.
        setBarVisible(true, wrapper);
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
      dbg('render:done', { pct: result.pct, color: result.color, width: fill.style.width }, 'info');
    }

    function scheduleRender() {
      if (state.raf) win.cancelAnimationFrame(state.raf);
      state.raf = win.requestAnimationFrame(function () {
        state.raf = null;
        renderNow();
      });
    }

    function startBurst(ms) {
      const until = Date.now() + Math.max(0, Number(ms || 0));
      state.burstUntil = Math.max(state.burstUntil || 0, until);
      if (state.burstInterval) return;

      dbg('burst:start', { ms });
      state.burstInterval = setInterval(function () {
        if (Date.now() > state.burstUntil) {
          try { clearInterval(state.burstInterval); } catch (_) {}
          state.burstInterval = null;
          dbg('burst:stop', null);
          return;
        }
        try {
          patchLsCartMethods();
          ensureBarMounted();
          maybeStartCartOpenPoll();
          scheduleRender();
        } catch (_) {}
      }, 80);
    }

    function buildSnapshot() {
      const total = getCurrentTotal();
      const domItems = buildDomItemsSnapshot();
      if (domItems && domItems.length) {
        dbg('snapshot:dom', { total: Number(total || 0), items: domItems.length, p0: domItems[0] ? domItems[0].product_id : null }, 'debug');
        return { total_amount: Number(total || 0), items: domItems.map(function (it) {
          return { product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total, categories: it.categories };
        }) };
      }

      const c = (win.LS && win.LS.cart) || {};
      const list = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);
      const items = list.map(function (item) {
        const lineId = String(item.id || item.item_id || item.cart_item_id || item.line_item_id || item.product_id || '').trim();
        const pidFromProductObj = (item && item.product && (item.product.id || item.product.product_id)) ? String(item.product.id || item.product.product_id).trim() : '';
        const pid = pidFromProductObj || String(item.product_id || '').trim() || String(item.productId || '').trim() || lineId;
        const qty = Math.max(1, Number(item.quantity || 1));
        const unit = toAmount(item.unit_price || item.price || item.unitPrice || item.base_price);
        const lineRaw = item.line_total || item.subtotal || item.total || item.line_price;
        const line = toAmount(lineRaw) || (unit != null ? unit * qty : 0);
        const categories = Array.isArray(item.categories) ? item.categories.map(function (c0) { return String((c0 && c0.id) || c0); }) : [];
        return { product_id: pid, quantity: qty, unit_price: unit != null ? unit : 0, line_total: line, categories, _line_id: lineId || null };
      }).filter(function (i) { return i.product_id; });

      dbg('snapshot:ls', { total: Number(total || 0), items: items.length, p0: items[0] ? items[0].product_id : null }, 'debug');
      return { total_amount: Number(total || 0), items: items.map(function (it) {
        return { product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total, categories: it.categories };
      }) };
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

    function scheduleRemoteEval() {
      if (!detectStoreId()) return;
      if (isCartEmpty()) return;
      if (!requiresRemoteEvaluation(state.config)) {
        state.lastRemote = null;
        return;
      }

      const snapshot = buildSnapshot();
      const evalKey = buildEvalKey(snapshot);
      const now = Date.now();
      if (state.lastRemote && state.lastEvalKey === evalKey && now - (state.lastEvalAt || 0) < 800) return;

      state.pendingEvalSnapshot = snapshot;
      state.pendingEvalKey = evalKey;
      dbg('eval:schedule', { total: snapshot.total_amount, items: (snapshot.items || []).length, evalKey }, 'debug');

      // Don't thrash: wait for the in-flight request to finish, then run again.
      if (state.evalInFlight) return;

      // Debounce to coalesce DOM mutation bursts.
      if (state.evalTimer) return;
      state.evalTimer = setTimeout(runRemoteEval, 180);
    }

    async function runRemoteEval() {
      if (state.evalTimer) {
        try { clearTimeout(state.evalTimer); } catch (_) {}
        state.evalTimer = null;
      }

      const snapshot = state.pendingEvalSnapshot;
      const evalKey = state.pendingEvalKey;
      state.pendingEvalSnapshot = null;
      state.pendingEvalKey = null;

      if (!snapshot || !evalKey) return;
      if (!detectStoreId()) return;
      if (isCartEmpty()) return;
      if (!requiresRemoteEvaluation(state.config)) return;

      try {
        const controller = new AbortController();
        state.evalInFlight = controller;
        state.lastEvalAt = Date.now();
        state.lastEvalKey = evalKey;

        const startedAt = Date.now();
        const abortTimer = setTimeout(function () { controller.abort(); }, 1400);
        const res = await fetch(`${baseUrl}/api/goals/${encodeURIComponent(storeId)}/evaluate`, {
          method: 'POST',
          // Avoid CORS preflight: application/json triggers OPTIONS.
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(snapshot),
          signal: controller.signal,
        });
        clearTimeout(abortTimer);
        if (state.evalInFlight === controller) state.evalInFlight = null;
        dbg('eval:resp', { ok: !!(res && res.ok), status: res ? res.status : null, ms: Date.now() - startedAt }, 'debug');
        if (!res.ok) return;
        const data = await res.json();
        state.lastRemote = data;
        renderNow();
      } catch (_) {
        // ignore
      } finally {
        state.evalInFlight = null;
        // If something changed while we were in-flight, schedule again.
        if (state.pendingEvalSnapshot) scheduleRemoteEval();
      }
    }

    async function loadConfig(force) {
      if (!detectStoreId()) return;
      const now = Date.now();
      const minInterval = state.config ? 3000 : 400;
      if (!force && now - state.lastConfigFetchAt < minInterval) return;
      state.lastConfigFetchAt = now;

      try {
        const startedAt = Date.now();
        dbg('config:fetch', { force: !!force }, 'debug');
        const res = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}?_=${Date.now()}`, { cache: 'no-store' });
        dbg('config:resp', { ok: !!(res && res.ok), status: res ? res.status : null, ms: Date.now() - startedAt }, 'debug');
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
        scheduleRemoteEval();
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
        scheduleRemoteEval();
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
            scheduleRemoteEval();
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
      const modal = getCartContainer();
      if (!modal) return;
      if (state.observedModal === modal) return;
      if (state.modalObserver) state.modalObserver.disconnect();
      state.observedModal = modal;
      state.modalObserver = new MutationObserver(function () {
        try {
          scheduleMaintenance();
        } catch (_) {}
      });
      state.modalObserver.observe(modal, {
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-hidden'],
      });
    }

    function scheduleMaintenance() {
      if (state.maintenanceTimer) return;
      dbg('maintenance:schedule', null, 'debug');
      state.maintenanceTimer = setTimeout(function () {
        state.maintenanceTimer = null;
        dbg('maintenance:run', { open: isCartOpen() }, 'debug');
        try {
          ensureBarMounted();
          bindSubtotalObserver();
          bindCartObserver();
          bindModalObserver();
          maybeStartCartOpenPoll();
          patchLsCartMethods();
          if (isCartOpen()) startBurst(1400);
          scheduleRender();
          scheduleRemoteEval();
        } catch (_) {}
      }, 60);
    }

    function bindDomObserver() {
      if (state.domObserver) return;
      state.domObserver = new MutationObserver(function () {
        scheduleMaintenance();
      });
      state.domObserver.observe(doc.body, { childList: true, subtree: true });
    }

    function pulseRefresh(options) {
      const keepMsRaw = options && options.keepMs;
      const keepMs = Number.isFinite(Number(keepMsRaw)) ? Number(keepMsRaw) : 3500;
      const reason = (options && options.reason) ? String(options.reason) : 'pulse';
      const end = Date.now() + 1400;
      state.forceLocalUntil = Date.now() + 1600;
      state.keepVisibleUntil = Date.now() + Math.max(0, keepMs);
      // Consider this an "activity" signal to avoid empty-flicker while the cart rerenders.
      state.lastEvidenceAt = Date.now();
      dbg('pulse', { reason, keepMs }, 'info');
      maybeStartCartOpenPoll();
      startBurst(Math.max(1500, keepMs));
      const tick = function () {
        scheduleRender();
        if (Date.now() < end) setTimeout(tick, 70);
      };
      tick();
      // Remote evaluation is debounced; one trigger per pulse is enough.
      scheduleRemoteEval();
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
          dbg('ls:call', { name }, 'debug');
          let out;
          try {
            out = fn.apply(LS, arguments);
          } catch (err) {
            try {
              const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
              pulseRefresh({ keepMs, reason: `ls:${name}:throw` });
            } catch (_) {}
            throw err;
          }

          try {
            const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
            pulseRefresh({ keepMs, reason: `ls:${name}` });
          } catch (_) {}

          if (out && typeof out.then === 'function') {
            return out.finally(function () {
              try {
                const keepMs = (name === 'removeItem' || name === 'removeProduct') ? 0 : 4500;
                pulseRefresh({ keepMs, reason: `ls:${name}:finally` });
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
      scheduleRemoteEval();
    });

    // 0 -> 1 flow: add-to-cart usually submits /comprar/. Kick a pulse to keep
    // the bar stable while Tiendanube re-renders the cart via AJAX.
    doc.addEventListener('submit', function (event) {
      const form = event && event.target;
      const action = form && form.action ? String(form.action) : '';
      if (!action || action.indexOf('/comprar') === -1) return;
      pulseRefresh({ keepMs: 5000, reason: 'submit:/comprar' });
    }, true);

    doc.addEventListener('click', function (event) {
      const target = event && event.target;
      if (!target) return;
      const ctrl = target.closest ? target.closest('.js-cart-quantity-btn,[data-component="quantity.plus"],[data-component="quantity.minus"]') : null;
      if (!ctrl) return;
      pulseRefresh({ reason: 'click:qty' });
    }, true);

    doc.addEventListener('input', function (event) {
      const target = event && event.target;
      if (!target) return;
      if (target.classList && target.classList.contains('js-cart-quantity-input')) {
        pulseRefresh({ reason: 'input:qty' });
      }
    }, true);

    ensureBarMounted();
    bindSubtotalObserver();
    bindCartObserver();
    bindModalObserver();
    bindDomObserver();
    renderNow();

    dbg('boot', { app: APP_VERSION, baseUrl, storeId: storeId || null, debug: debugEnabled }, 'info');

    loadConfig(true).catch(function () {});
    maybeStartCartOpenPoll();
    patchLsCartMethods();
    // Patch LS early even if it boots late: makes 0->1 add-to-cart stable.
    (function patchLsEarly() {
      let tries = 0;
      const t = setInterval(function () {
        tries += 1;
        try { patchLsCartMethods(); } catch (_) {}
        if (tries >= 50) {
          try { clearInterval(t); } catch (_) {}
        }
      }, 250);
    })();

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
