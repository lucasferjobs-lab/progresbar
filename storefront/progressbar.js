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
  const APP_VERSION = '2026-02-27-03';

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

  function buildEvalKeyStable(snapshot) {
    const total = Number(snapshot && snapshot.total_amount) || 0;
    const items = Array.isArray(snapshot && snapshot.items) ? snapshot.items : [];

    const normalized = items.map(function (it) {
      const pid = String((it && it.product_id) || '').trim();
      if (!pid) return null;
      const qty = Math.max(1, Number((it && it.quantity) || 1));
      const line = Number((it && it.line_total) || 0);
      return {
        product_id: pid,
        quantity: Number.isFinite(qty) ? qty : 1,
        line_total: Number.isFinite(line) ? line : 0,
      };
    }).filter(function (x) { return !!x; });

    normalized.sort(function (a, b) {
      const byId = a.product_id.localeCompare(b.product_id);
      if (byId) return byId;
      if (a.quantity !== b.quantity) return a.quantity - b.quantity;
      return a.line_total - b.line_total;
    });

    const parts = [String(total.toFixed(2)), String(normalized.length)];
    for (let i = 0; i < normalized.length; i++) {
      const it = normalized[i];
      parts.push(it.product_id);
      parts.push(String(it.quantity || 0));
      parts.push(String(Number(it.line_total || 0).toFixed(2)));
    }
    return parts.join('|');
  }

  // A more stable signature for remote evaluation dedupe. We intentionally ignore
  // per-line totals because themes can temporarily render incomplete DOM values
  // during AJAX updates, which would otherwise cause request storms.
  function buildRemoteKey(snapshot) {
    const total = Number(snapshot && snapshot.total_amount) || 0;
    const items = Array.isArray(snapshot && snapshot.items) ? snapshot.items : [];

    const normalized = items.map(function (it) {
      const pid = String((it && it.product_id) || '').trim();
      if (!pid) return null;
      const qty = Math.max(1, Number((it && it.quantity) || 1));
      return {
        product_id: pid,
        quantity: Number.isFinite(qty) ? qty : 1,
      };
    }).filter(function (x) { return !!x; });

    normalized.sort(function (a, b) {
      const byId = a.product_id.localeCompare(b.product_id);
      if (byId) return byId;
      return a.quantity - b.quantity;
    });

    const parts = [String(total.toFixed(2)), String(normalized.length)];
    for (let i = 0; i < normalized.length; i++) {
      const it = normalized[i];
      parts.push(it.product_id);
      parts.push(String(it.quantity || 0));
    }
    return parts.join('|');
  }

  function isSnapshotStableForRemote(snapshot) {
    if (!snapshot) return false;
    const total = Number(snapshot.total_amount) || 0;
    if (!Number.isFinite(total) || total <= 0) return false;
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    if (!items.length) return false;

    let sum = 0;
    let anyNonZero = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const line = Math.max(0, Number(it.line_total || 0));
      if (Number.isFinite(line)) {
        sum += line;
        if (line > 0) anyNonZero = true;
      }
    }

    // If we can't read any line totals yet, defer.
    if (!anyNonZero) return false;

    const delta = Math.abs(sum - total);
    // Allow small mismatch due to rounding/discount display quirks, but not large gaps.
    const tol = Math.max(0.5, total * 0.03);
    return delta <= tol;
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
    const color = String(cfg.envio_bar_color || '#008c99');

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
    const color = String(cfg.cuotas_bar_color || '#fbb03b');

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
        color: '#008c99',
      };
    }

    if (regaloGoal > 0 && total < regaloGoal) {
      const missing = regaloGoal - total;
      return {
        pct: clampPct((total / regaloGoal) * 100),
        message: `<span class="tn-progressbar__ok">Envio gratis activado</span>. Te faltan <strong>$${money(missing)}</strong> para un regalo`,
        color: '#008c99',
      };
    }

    return {
      pct: 100,
      message: '<span class="tn-progressbar__ok">Felicitaciones, ya tenes todos los beneficios.</span>',
      color: '#008c99',
    };
  }

  function requiresRemoteEvaluation(cfg) {
    if (!cfg) return false;
    if (!isBillingEntitled(cfg)) return false;

    const envioScope = String(cfg.envio_scope || 'all');
    const cuotasScope = String(cfg.cuotas_scope || 'all');
    const regaloMode = String(cfg.regalo_mode || 'combo_products');

    // Product-scope rules can be evaluated locally using cart DOM. Only
    // category-scope (and regalo rules) require server-side evaluation.
    if (cfg.enable_envio_rule !== false && envioScope === 'category') return true;
    if (cfg.enable_cuotas_rule !== false && cuotasScope === 'category') return true;

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

  function isBillingEntitled(cfg) {
    if (!cfg) return true;
    if (cfg.billing_active !== false) return true;
    const until = cfg.billing_override_until;
    if (!until) return false;
    const ms = (until instanceof Date) ? until.getTime() : Date.parse(String(until));
    if (!Number.isFinite(ms)) return false;
    return ms > Date.now();
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
    const CONFIG_FRESH_MS = 25_000;

    // Intentionally no console logs in production.

    const state = {
      config: null,
      configLoaded: false,
      freshConfig: false,
      lastConfigFetchAt: 0,
      configCachedAt: 0,
      lastRemote: null,
      lastRemoteKey: null,
      lastRemoteAt: 0,
      lastRemoteErrKey: null,
      lastRemoteErrAt: 0,
      configInFlight: null,
      evalTimer: null,
      evalInFlight: null,
      lastEvalKey: null,
      lastEvalAt: 0,
      remoteUnstableTries: 0,
      remoteUnstableUntil: 0,
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
      lastRenderedByKey: {},
      lastUiThemeKey: '',
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
      emptySince: 0,
      lastPulseAt: 0,
      lastPulseReason: '',
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
              last_rendered_keys: Object.keys(state.lastRenderedByKey || {}),
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
        const parsed = JSON.parse(cached);
        if (parsed && parsed._pb_cache === 1 && parsed.data) {
          state.config = parsed.data;
          state.configLoaded = true;
          state.freshConfig = true;
          state.configCachedAt = Number(parsed.t || 0) || 0;
        } else if (parsed && typeof parsed === 'object') {
          // Legacy format (no timestamp)
          state.config = parsed;
          state.configLoaded = true;
          state.freshConfig = true;
          state.configCachedAt = 0;
        }
        dbg('config:cache_hit', { bytes: String(cached || '').length, age_ms: state.configCachedAt ? (Date.now() - state.configCachedAt) : null }, 'info');
      }
    } catch (_) {}

    function isVisible(el) {
      if (!el) return false;
      try {
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
        if (el.getAttribute) {
          const ariaHidden = el.getAttribute('aria-hidden');
          if (ariaHidden && String(ariaHidden).toLowerCase() === 'true') return false;
        }

        // Only apply viewport intersection checks for the cart containers.
        const shouldCheckViewport = (
          el.id === 'modal-cart' ||
          (el.getAttribute && el.getAttribute('data-component') === 'cart') ||
          (el.classList && (el.classList.contains('modal') || el.classList.contains('modal-cart') || el.classList.contains('js-ajax-cart-panel')))
        );

        if (shouldCheckViewport && el.getBoundingClientRect) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const vw = Number(win.innerWidth || doc.documentElement.clientWidth || 0);
          const vh = Number(win.innerHeight || doc.documentElement.clientHeight || 0);
          if (vw > 0 && vh > 0) {
            const tol = 2;
            if (rect.bottom <= tol || rect.right <= tol || rect.top >= (vh - tol) || rect.left >= (vw - tol)) return false;
          }
        }

        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      } catch (_) {
        return false;
      }
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
      const now = Date.now();
      const lsCount = getLsItemCount();
      const emptyState = q('.js-empty-ajax-cart');
      const emptyVisible = !!(emptyState && isVisible(emptyState));
      const hasItems = hasCartItems();
      const subtotal = getSubtotalAmount();

      const hasEvidence = ((lsCount != null && lsCount > 0) || hasItems || (subtotal != null && subtotal > 0));
      const strongEmpty = emptyVisible && !hasItems && !hasEvidence;

      // During quantity changes, Tiendanube can briefly show the empty view.
      // During add-to-cart and rerenders, the theme can temporarily display the
      // empty view even when the cart already has items. keepVisibleUntil is only
      // set on user/cart activity, so trust it to avoid delayed mounting/flicker.
      if (now < state.keepVisibleUntil) return false;

      if (hasEvidence) {
        state.lastEvidenceAt = now;
      }

      const empty = decideEmpty({
        now,
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
          dbg('empty:state', { empty, lsCount, hasItems, subtotal, emptyVisible, strongEmpty, stableMs: 500 }, 'info');
        }
      }

      return empty;
    }

    function isCartOpen() {
      const root = getCartContainer();
      if (!root) return false;

      // Modal carts are usually always in the DOM; the theme just toggles a class
      // or aria-hidden while sliding it on/off screen.
      if (root.id === 'modal-cart') {
        if (root.classList && root.classList.contains('modal-show')) return true;
        try {
          const aria = root.getAttribute ? root.getAttribute('aria-hidden') : null;
          if (aria != null && String(aria).toLowerCase() === 'false') return true;
        } catch (_) {}
        return false;
      }

      if (root.classList && root.classList.contains('modal-show')) return true;
      try {
        const aria = root.getAttribute ? root.getAttribute('aria-hidden') : null;
        if (aria != null && String(aria).toLowerCase() === 'true') return false;
      } catch (_) {}
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
        const list = wrapper && wrapper.querySelector ? wrapper.querySelector('[data-pb-list="1"]') : null;
        if (changed || !list) {
          scheduleRender();
          scheduleRemoteEval();
        }
      }, 260);
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

      // If the store is not active in billing, the app must not run.
      if (state.configLoaded && state.config && !isBillingEntitled(state.config)) {
        removeBar();
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

      // If the cart is empty, don't mount (avoids an empty white box). Removal is
      // handled by renderNow() so transient empty states during rerenders don't
      // immediately tear down the UI.
      if (isCartEmpty()) return null;

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
      wrapper.innerHTML = '<div class="tn-progressbar__list" data-pb-list="1"></div>';

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

    function applyUiTheme(wrapper) {
      const cfg = state.config || null;
      if (!cfg || !wrapper || !wrapper.style) return;

      const themeKey = [
        cfg.ui_bg_color,
        cfg.ui_border_color,
        cfg.ui_track_color,
        cfg.ui_text_color,
        cfg.ui_bar_height,
        cfg.ui_radius,
        cfg.ui_shadow,
        cfg.ui_animation,
        cfg.ui_compact,
      ].map(function (v) { return v == null ? '' : String(v); }).join('|');

      if (state.lastUiThemeKey === themeKey) return;
      state.lastUiThemeKey = themeKey;

      function setVar(name, value) {
        const v = String(value || '').trim();
        if (!v) {
          try { wrapper.style.removeProperty(name); } catch (_) {}
          return;
        }
        try { wrapper.style.setProperty(name, v); } catch (_) {}
      }

      setVar('--pb-bg', cfg.ui_bg_color);
      setVar('--pb-border', cfg.ui_border_color);
      setVar('--pb-track', cfg.ui_track_color);
      setVar('--pb-text', cfg.ui_text_color);

      const height = Number(cfg.ui_bar_height || 0);
      if (Number.isFinite(height) && height > 0) {
        setVar('--pb-height', String(Math.max(6, Math.min(24, Math.round(height)))) + 'px');
      } else {
        try { wrapper.style.removeProperty('--pb-height'); } catch (_) {}
      }

      const radius = Number(cfg.ui_radius || 0);
      if (Number.isFinite(radius) && radius >= 0) {
        setVar('--pb-radius', String(Math.max(0, Math.min(40, Math.round(radius)))) + 'px');
      } else {
        try { wrapper.style.removeProperty('--pb-radius'); } catch (_) {}
      }

      wrapper.classList.toggle('pb-no-shadow', cfg.ui_shadow === false);
      wrapper.classList.toggle('pb-no-anim', cfg.ui_animation === false);
      wrapper.classList.toggle('pb-compact', cfg.ui_compact === true);
    }

    function toUiAmountResult(key, eligibleSubtotal, threshold, cfg, options) {
      const opt = options || {};
      const color = String(opt.color || '#008c99');
      const missing = Math.max(0, threshold - eligibleSubtotal);
      const reached = missing <= 0;
      const prefix = String(opt.text_prefix || '').trim();
      const suffix = String(opt.text_suffix || '').trim();
      const reachedText = String(opt.text_reached || '').trim();

      if (reached) {
        return {
          key,
          pct: 100,
          message: reachedText || String(opt.default_reached || ''),
          color,
        };
      }

      const msg = `${prefix || 'Te faltan'} <strong>$${money(missing)}</strong> ${suffix || String(opt.default_suffix || '')}`.trim();
      return {
        key,
        pct: clampPct((eligibleSubtotal / threshold) * 100),
        message: msg,
        color,
      };
    }

    function sumEligibleForProduct(productId) {
      const pid = String(productId || '').trim();
      if (!pid) return { qty: 0, subtotal: 0 };
      // Use the same snapshot strategy as remote-eval: DOM when available, LS
      // fallback when the theme hasn't rendered items yet (0->1 flow).
      const snap = buildSnapshot();
      const items = snap && Array.isArray(snap.items) ? snap.items : [];
      if (!items.length) return { qty: 0, subtotal: 0 };
      let qty = 0;
      let subtotal = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        if (String(it.product_id || '') !== pid) continue;
        const q0 = Math.max(0, Number(it.quantity || 0));
        const l0 = Math.max(0, Number(it.line_total || 0));
        qty += q0;
        subtotal += l0;
      }
      return { qty, subtotal };
    }

    function buildLocalEnvio(total, cfg) {
      if (!cfg || cfg.enable_envio_rule === false) return null;
      const scope = String(cfg.envio_scope || 'all');
      const threshold = Math.max(0, pickThreshold(cfg.envio_min_amount, cfg.monto_envio_gratis));
      if (threshold <= 0) return null;

      if (scope === 'all') {
        if (total <= 0) return null;
        return toUiAmountResult('envio', total, threshold, cfg, {
          color: cfg.envio_bar_color || '#008c99',
          text_prefix: cfg.envio_text_prefix,
          text_suffix: cfg.envio_text_suffix,
          text_reached: cfg.envio_text_reached,
          default_suffix: 'para envio gratis.',
          default_reached: '<span class="tn-progressbar__ok">Envio gratis activado.</span>',
        });
      }

      if (scope === 'product') {
        const target = String(cfg.envio_product_id || '').trim();
        const sum = sumEligibleForProduct(target);
        if (!sum.qty) return null;
        return toUiAmountResult('envio', sum.subtotal, threshold, cfg, {
          color: cfg.envio_bar_color || '#008c99',
          text_prefix: cfg.envio_text_prefix,
          text_suffix: cfg.envio_text_suffix,
          text_reached: cfg.envio_text_reached,
          default_suffix: 'para envio gratis.',
          default_reached: '<span class="tn-progressbar__ok">Envio gratis activado.</span>',
        });
      }

      return null;
    }

    function buildLocalCuotas(total, cfg) {
      if (!cfg || cfg.enable_cuotas_rule === false) return null;
      const scope = String(cfg.cuotas_scope || 'all');
      const threshold = Math.max(0, pickThreshold(cfg.cuotas_threshold_amount, cfg.monto_cuotas));
      if (threshold <= 0) return null;

      if (scope === 'all') {
        if (total <= 0) return null;
        return toUiAmountResult('cuotas', total, threshold, cfg, {
          color: cfg.cuotas_bar_color || '#fbb03b',
          text_prefix: cfg.cuotas_text_prefix,
          text_suffix: cfg.cuotas_text_suffix,
          text_reached: cfg.cuotas_text_reached,
          default_suffix: 'para cuotas sin interes.',
          default_reached: '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>',
        });
      }

      if (scope === 'product') {
        const target = String(cfg.cuotas_product_id || '').trim();
        const sum = sumEligibleForProduct(target);
        if (!sum.qty) return null;
        return toUiAmountResult('cuotas', sum.subtotal, threshold, cfg, {
          color: cfg.cuotas_bar_color || '#fbb03b',
          text_prefix: cfg.cuotas_text_prefix,
          text_suffix: cfg.cuotas_text_suffix,
          text_reached: cfg.cuotas_text_reached,
          default_suffix: 'para cuotas sin interes.',
          default_reached: '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>',
        });
      }

      return null;
    }

    function buildRemoteAmount(key, remoteRule, defaults) {
      const r = remoteRule || null;
      if (!r || !r.enabled) return null;
      if (r.has_match === false) return null;
      const d = defaults || {};
      const color = String(r.bar_color || d.color || '#008c99');
      if (r.reached) {
        return {
          key,
          pct: 100,
          message: String(r.text_reached || d.default_reached || ''),
          color,
        };
      }
      const pfx = String(r.text_prefix || '').trim();
      const sfx = String(r.text_suffix || '').trim();
      return {
        key,
        pct: clampPct(Number(r.progress || 0) * 100),
        message: `${pfx || 'Te faltan'} <strong>$${money(r.missing_amount || 0)}</strong> ${sfx || ''}`.trim(),
        color,
      };
    }

    function buildRemoteRegalo(remoteRule) {
      const r = remoteRule || null;
      if (!r || !r.enabled) return null;
      const color = String(r.bar_color || '#77c3a7');
      if (r.reached) {
        return {
          key: 'regalo',
          pct: 100,
          message: String(r.text_reached || '<span class="tn-progressbar__ok">Regalo desbloqueado.</span>'),
          color,
        };
      }
      const pfx = String(r.text_prefix || '').trim();
      const sfx = String(r.text_suffix || '').trim();
      return {
        key: 'regalo',
        pct: clampPct(Number(r.progress || 0) * 100),
        message: `${pfx || 'Te faltan'} <strong>$${money(r.missing_amount || 0)}</strong> ${sfx || ''}`.trim(),
        color,
      };
    }

    function buildUiResults(total) {
      const cfg = state.config;
      const preferLocalOnly = Date.now() < state.forceLocalUntil;

      if (!state.configLoaded) {
        const prev = state.lastRenderedByKey || {};
        return Object.keys(prev).map(function (k) { return prev[k]; }).filter(Boolean);
      }

      const out = [];
      const envioLocal = buildLocalEnvio(total, cfg);
      const cuotasLocal = buildLocalCuotas(total, cfg);
      if (envioLocal) out.push(envioLocal);
      if (cuotasLocal) out.push(cuotasLocal);

      const remoteOk = !preferLocalOnly && state.lastRemote && Math.abs(Number(state.lastRemote.cart_total || 0) - total) < 0.01;
      if (remoteOk) {
        const remote = state.lastRemote || {};
        const envioScope = String((cfg && cfg.envio_scope) || 'all');
        const cuotasScope = String((cfg && cfg.cuotas_scope) || 'all');

        if (!envioLocal && envioScope === 'category') {
          const rEnvio = buildRemoteAmount('envio', remote.envio, {
            color: '#008c99',
            default_reached: '<span class="tn-progressbar__ok">Envio gratis activado.</span>',
          });
          if (rEnvio) out.push(rEnvio);
        }

        if (!cuotasLocal && cuotasScope === 'category') {
          const rCuotas = buildRemoteAmount('cuotas', remote.cuotas, {
            color: '#fbb03b',
            default_reached: '<span class="tn-progressbar__ok">Cuotas sin interes activadas.</span>',
          });
          if (rCuotas) out.push(rCuotas);
        }

        const rRegalo = buildRemoteRegalo(remote.regalo);
        if (rRegalo) out.push(rRegalo);
      }

      return out;
    }

    function canKeepGoalKey(key) {
      const cfg = state.config;
      if (!cfg) return true;
      const k = String(key || '');
      if (k === 'envio') {
        if (cfg.enable_envio_rule === false) return false;
        const threshold = Math.max(0, pickThreshold(cfg.envio_min_amount, cfg.monto_envio_gratis));
        if (threshold <= 0) return false;
        const scope = String(cfg.envio_scope || 'all');
        if (scope === 'product') return !!String(cfg.envio_product_id || '').trim();
        if (scope === 'category') return !!String(cfg.envio_category_id || '').trim();
        return true;
      }
      if (k === 'cuotas') {
        if (cfg.enable_cuotas_rule === false) return false;
        const threshold = Math.max(0, pickThreshold(cfg.cuotas_threshold_amount, cfg.monto_cuotas));
        if (threshold <= 0) return false;
        const scope = String(cfg.cuotas_scope || 'all');
        if (scope === 'product') return !!String(cfg.cuotas_product_id || '').trim();
        if (scope === 'category') return !!String(cfg.cuotas_category_id || '').trim();
        return true;
      }
      if (k === 'regalo') {
        if (cfg.enable_regalo_rule === false) return false;
        // Only keep when the rule is actually configured; otherwise it should disappear quickly.
        const mode = String(cfg.regalo_mode || 'combo_products').trim();
        if (mode === 'combo_products') {
          const min = Math.max(0, Number(cfg.regalo_min_amount || 0));
          const p1 = String(cfg.regalo_primary_product_id || '').trim();
          const p2 = String(cfg.regalo_secondary_product_id || '').trim();
          return min > 0 && !!p1 && !!p2;
        }
        if (mode === 'target_rule') {
          const qty = Math.max(0, Number(cfg.regalo_target_qty || 0));
          const p = String(cfg.regalo_target_product_id || '').trim();
          const c = String(cfg.regalo_target_category_id || '').trim();
          return qty > 0 && (!!p || !!c);
        }
        return true;
      }
      return true;
    }

    function normalizeUiResults(results) {
      const list = Array.isArray(results) ? results : [];
      const byKey = {};
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r || !r.key) continue;
        byKey[String(r.key)] = r;
      }
      const order = { envio: 0, cuotas: 1, regalo: 2 };
      return Object.keys(byKey).sort(function (a, b) {
        const ai = Object.prototype.hasOwnProperty.call(order, a) ? order[a] : 99;
        const bi = Object.prototype.hasOwnProperty.call(order, b) ? order[b] : 99;
        if (ai != bi) return ai - bi;
        return String(a).localeCompare(String(b));
      }).map(function (k) { return byKey[k]; });
    }

    function ensureListNode(wrapper) {
      if (!wrapper) return null;
      let list = wrapper.querySelector ? wrapper.querySelector('[data-pb-list="1"]') : null;
      if (list) return list;
      // Older versions might have single-bar markup. Repair to multi list.
      try {
        wrapper.innerHTML = '<div class="tn-progressbar__list" data-pb-list="1"></div>';
      } catch (_) {}
      list = wrapper.querySelector ? wrapper.querySelector('[data-pb-list="1"]') : null;
      return list || null;
    }

    function ensureItemNode(list, key) {
      if (!list || !key) return null;
      const k = String(key);
      let item = list.querySelector ? list.querySelector('[data-pb-key="' + k + '"]') : null;
      if (item) return item;

      try {
        item = doc.createElement('div');
        item.className = 'tn-progressbar__item';
        item.setAttribute('data-pb-key', k);
        item.innerHTML = [
          '<div class="tn-progressbar__text js-pb-text">&nbsp;</div>',
          '<div class="tn-progressbar__track">',
          '  <div class="tn-progressbar__fill js-pb-fill"></div>',
          '</div>',
        ].join('');
        list.appendChild(item);
      } catch (_) {
        return null;
      }

      return item;
    }

    function renderUiResults(wrapper, results) {
      const list = ensureListNode(wrapper);
      if (!list) return false;

      const normalized = normalizeUiResults(results);
      const keep = {};

      for (let i = 0; i < normalized.length; i++) {
        const r = normalized[i];
        if (!r || !r.key) continue;
        const key = String(r.key);
        keep[key] = true;

        const item = ensureItemNode(list, key);
        if (!item) continue;

        const fill = item.querySelector ? item.querySelector('.tn-progressbar__fill,.js-pb-fill') : null;
        const text = item.querySelector ? item.querySelector('.tn-progressbar__text,.js-pb-text') : null;
        if (!fill || !text) continue;

        fill.style.width = String(clampPct(r.pct)) + '%';
        fill.style.backgroundImage = 'none';
        fill.style.backgroundColor = r.color || '#008c99';
        text.innerHTML = r.message || '&nbsp;';
      }

      // Remove stale items (avoid duplicate/confusing old bars).
      try {
        const children = list.querySelectorAll ? list.querySelectorAll('[data-pb-key]') : [];
        for (let i = 0; i < (children ? children.length : 0); i++) {
          const n = children[i];
          const k = n && n.getAttribute ? n.getAttribute('data-pb-key') : null;
          if (!k || keep[k]) continue;
          if (n && n.parentNode) n.parentNode.removeChild(n);
        }
      } catch (_) {}

      if (!normalized.length) return false;

      const nextByKey = {};
      for (let i = 0; i < normalized.length; i++) {
        const r = normalized[i];
        if (!r || !r.key) continue;
        nextByKey[String(r.key)] = r;
      }
      state.lastRenderedByKey = nextByKey;
      state.lastRendered = normalized[0] || null;
      return true;
    }

    function renderNow() {
      dbg('render:call', { open: isCartOpen() }, 'debug');
      if (isCartEmpty()) {
        const now = Date.now();
        const prev = state.lastRenderedByKey || {};
        const fallback = Object.keys(prev).map(function (k) { return prev[k]; }).filter(Boolean);

        const container = getCartContainer();
        const wrapper = (container && container.querySelector) ? container.querySelector('#app-barra-progreso') : null;

        // Tiendanube themes can briefly show the "empty cart" view while they
        // rerender quantities/totals. Avoid tearing down the bar in that window.
        if (wrapper && fallback.length) {
          if (!state.emptySince) state.emptySince = now;

          const reason = String(state.lastPulseReason || '');
          const removeIntent = reason.indexOf('removeItem') !== -1 || reason.indexOf('removeProduct') !== -1;
          const graceMs = removeIntent ? 350 : 6500;

          if (now - state.emptySince < graceMs) {
            applyUiTheme(wrapper);
            setBarVisible(true, wrapper);
            renderUiResults(wrapper, fallback);
            return;
          }
        }

        // Empty cart: remove the UI completely (no white box).
        removeBar();
        dbg('render:empty', {
          keepMsLeft: Math.max(0, (state.keepVisibleUntil || 0) - now),
          lsCount: getLsItemCount(),
          hasItems: hasCartItems(),
          subtotal: getSubtotalAmount(),
          emptyVisible: (function () {
            const emptyState = q('.js-empty-ajax-cart');
            return !!(emptyState && isVisible(emptyState));
          })(),
        }, 'info');
        state.emptySince = 0;
        state.lastRenderedByKey = {};
        state.lastRendered = null;
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

      state.emptySince = 0;

      if (state.configLoaded && state.config && !isBillingEntitled(state.config)) {
        removeBar();
        state.lastRenderedByKey = {};
        state.lastRendered = null;
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

      // Always force visible when cart is not empty.
      applyUiTheme(wrapper);
      state.barHiddenUntilConfig = false;
      setBarVisible(true, wrapper);

      const total = getCurrentTotal();
      dbg('render:total', { total }, 'debug');
      if (total == null || total < 1) {
        // During AJAX rerenders, totals can disappear momentarily. Keep the last
        // rendered UI (if any) to avoid showing wrong default content.
        const prev = state.lastRenderedByKey || {};
        const fallback = Object.keys(prev).map(function (k) { return prev[k]; }).filter(Boolean);
        if (fallback.length) {
          renderUiResults(wrapper, fallback);
          return;
        }
        setBarVisible(false, wrapper);
        return;
      }

      const results = buildUiResults(total);
      let merged = Array.isArray(results) ? results.slice() : [];

      // During cart updates, Tiendanube can briefly render incomplete DOM (items missing)
      // which would temporarily drop one of the goals. Keep previously-rendered goals
      // during that burst to avoid a bar disappearing and reappearing.
      const preserveMissing = Date.now() < state.keepVisibleUntil || !!state.evalInFlight;
      if (preserveMissing) {
        const seen = {};
        for (let i = 0; i < merged.length; i++) {
          const r = merged[i];
          if (r && r.key) seen[String(r.key)] = true;
        }
        const prev = state.lastRenderedByKey || {};
        const keys = Object.keys(prev);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (seen[k]) continue;
          if (!canKeepGoalKey(k)) continue;
          const r = prev[k];
          if (r) merged.push(r);
        }
      }

      const ok = renderUiResults(wrapper, merged);
      dbg('render:ui', { count: Array.isArray(merged) ? merged.length : 0, rendered: ok }, 'debug');

      if (ok) return;

      // No applicable goals right now. Avoid flicker during pulses by keeping
      // last rendered results while the cart settles.
      const prev = state.lastRenderedByKey || {};
      const fallback = Object.keys(prev).map(function (k) { return prev[k]; }).filter(Boolean);
      if (fallback.length && Date.now() < state.keepVisibleUntil) {
        renderUiResults(wrapper, fallback);
        return;
      }

      // Stable empty: hide and clear.
      state.lastRenderedByKey = {};
      state.lastRendered = null;
      setBarVisible(false, wrapper);
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
        let totalAmount = Number(total || 0);
        if (!Number.isFinite(totalAmount)) totalAmount = 0;
        const computedTotal = domItems.reduce(function (acc, it) {
          const n = Number(it && it.line_total) || 0;
          return acc + (Number.isFinite(n) ? n : 0);
        }, 0);
        if (totalAmount <= 0 && computedTotal > 0) totalAmount = computedTotal;
        dbg('snapshot:dom', { total: Number(total || 0), items: domItems.length, p0: domItems[0] ? domItems[0].product_id : null }, 'debug');
        return { total_amount: totalAmount, items: domItems.map(function (it) {
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

      let totalAmount = Number(total || 0);
      if (!Number.isFinite(totalAmount)) totalAmount = 0;
      const computedTotal = items.reduce(function (acc, it) {
        const n = Number(it && it.line_total) || 0;
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      if (totalAmount <= 0 && computedTotal > 0) totalAmount = computedTotal;

      dbg('snapshot:ls', { total: Number(total || 0), items: items.length, p0: items[0] ? items[0].product_id : null }, 'debug');
      return { total_amount: totalAmount, items: items.map(function (it) {
        return { product_id: it.product_id, quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total, categories: it.categories };
      }) };
    }

    function buildEvalKey(snapshot) {
      return buildRemoteKey(snapshot);
    }

    function scheduleRemoteEval() {
      if (!detectStoreId()) return;
      if (!isCartOpen()) return;
      if (isCartEmpty()) return;
      if (!requiresRemoteEvaluation(state.config)) {
        state.lastRemote = null;
        state.lastRemoteKey = null;
        return;
      }

      const snapshot = buildSnapshot();
      const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
      if (!items.length) return;
      const evalKey = buildEvalKey(snapshot);
      const now = Date.now();

      // If we already have a remote result for this exact signature, don't refetch.
      // Any needed refresh is driven by config changes (which clear lastRemoteKey)
      // or by cart signature changes.
      if (state.lastRemote && state.lastRemoteKey === evalKey) return;

      // Backoff on repeated failures for the same signature.
      const REMOTE_ERROR_BACKOFF_MS = 5_000;
      if (state.lastRemoteErrKey === evalKey && now - (state.lastRemoteErrAt || 0) < REMOTE_ERROR_BACKOFF_MS) return;

      // Avoid spamming when nothing relevant changed.
      if (state.lastEvalKey === evalKey && now - (state.lastEvalAt || 0) < 1200) return;

      state.pendingEvalSnapshot = snapshot;
      state.pendingEvalKey = evalKey;
      if (now > (state.remoteUnstableUntil || 0)) {
        state.remoteUnstableTries = 0;
        state.remoteUnstableUntil = now + 2500;
      }
      dbg('eval:schedule', { total: snapshot.total_amount, items: (snapshot.items || []).length, evalKey }, 'debug');

      // Don't thrash: wait for the in-flight request to finish, then run again.
      if (state.evalInFlight) return;

      // Debounce to coalesce DOM mutation bursts (trailing edge).
      if (state.evalTimer) {
        try { clearTimeout(state.evalTimer); } catch (_) {}
      }
      state.evalTimer = setTimeout(runRemoteEval, 220);
    }

    async function runRemoteEval() {
      if (state.evalTimer) {
        try { clearTimeout(state.evalTimer); } catch (_) {}
        state.evalTimer = null;
      }

      let snapshot = state.pendingEvalSnapshot;
      let evalKey = state.pendingEvalKey;
      state.pendingEvalSnapshot = null;
      state.pendingEvalKey = null;

      if (!snapshot || !evalKey) return;
      if (!detectStoreId()) return;
      if (!isCartOpen()) return;
      if (isCartEmpty()) return;
      if (!requiresRemoteEvaluation(state.config)) return;

      // Rebuild at execution time: Tiendanube can rebuild the cart DOM between
      // scheduling and execution, and we want the most stable snapshot.
      try {
        const fresh = buildSnapshot();
        const freshItems = fresh && Array.isArray(fresh.items) ? fresh.items : [];
        if (fresh && freshItems.length) {
          const freshKey = buildEvalKey(fresh);
          if (freshKey) {
            snapshot = fresh;
            evalKey = freshKey;
          }
        }
      } catch (_) {}

      // If we already have a remote result for this signature, skip.
      if (state.lastRemote && state.lastRemoteKey === evalKey) return;

      // Avoid sending incomplete payloads while the theme is mid-rerender.
      if (!isSnapshotStableForRemote(snapshot)) {
        const now = Date.now();
        state.remoteUnstableTries = (state.remoteUnstableTries || 0) + 1;
        if (now < (state.remoteUnstableUntil || 0) && state.remoteUnstableTries <= 12) {
          state.pendingEvalSnapshot = snapshot;
          state.pendingEvalKey = evalKey;
          if (!state.evalTimer) state.evalTimer = setTimeout(runRemoteEval, 220);
        }
        return;
      }

      try {
        const controller = new AbortController();
        state.evalInFlight = controller;
        state.remoteUnstableTries = 0;
        state.lastEvalAt = Date.now();
        state.lastEvalKey = evalKey;

        const startedAt = Date.now();
        const abortTimer = setTimeout(function () { controller.abort(); }, 3500);
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
        if (!res.ok) {
          state.lastRemoteErrKey = evalKey;
          state.lastRemoteErrAt = Date.now();
          return;
        }
        const data = await res.json();
        state.lastRemote = data;
        state.lastRemoteKey = evalKey;
        state.lastRemoteAt = Date.now();
        renderNow();
      } catch (_) {
        // ignore
        state.lastRemoteErrKey = evalKey;
        state.lastRemoteErrAt = Date.now();
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
      if (state.configInFlight) return state.configInFlight;
      if (!force && state.configLoaded && state.configCachedAt && now - state.configCachedAt < CONFIG_FRESH_MS) return;
      if (!force && now - state.lastConfigFetchAt < minInterval) return;
      if (force && now - state.lastConfigFetchAt < 250) return;
      state.lastConfigFetchAt = now;

      const promise = (async function () {
        try {
        const startedAt = Date.now();
        dbg('config:fetch', { force: !!force }, 'debug');
        const res = await fetch(`${baseUrl}/api/config/${encodeURIComponent(storeId)}`);
        dbg('config:resp', { ok: !!(res && res.ok), status: res ? res.status : null, ms: Date.now() - startedAt }, 'debug');
        if (!res.ok) return;
        const data = await res.json();
        state.config = data || null;
        state.configLoaded = !!data;
        state.freshConfig = !!data;
        state.configCachedAt = Date.now();
        // Config changes can affect remote evaluation even if the cart didn't change.
        state.lastRemoteKey = null;
        try {
          if (win.localStorage && data) {
            win.localStorage.setItem(getCacheKey(), JSON.stringify({ _pb_cache: 1, t: Date.now(), data }));
          }
        } catch (_) {}
        renderNow();
        scheduleRemoteEval();
        } catch (_) {}
        finally { state.configInFlight = null; }
      })();

      state.configInFlight = promise;
      return promise;
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
        function looksCartRelevant(node) {
          try {
            if (!node || node.nodeType !== 1) return false;
            if (node.id === 'modal-cart') return true;
            if (node.classList && (node.classList.contains('js-cart-item') || node.classList.contains('js-ajax-cart-list') || node.classList.contains('js-empty-ajax-cart'))) return true;
            if (node.getAttribute) {
              const ds = node.getAttribute('data-store');
              if (ds && String(ds).indexOf('cart-item-') !== -1) return true;
              const comp = node.getAttribute('data-component');
              if (comp && String(comp).indexOf('cart') !== -1) return true;
            }
            if (node.querySelector) {
              if (node.querySelector('#modal-cart,.js-cart-item,.js-ajax-cart-total.js-cart-subtotal,.js-empty-ajax-cart,[data-store=\"cart-subtotal\"]')) return true;
            }
            return false;
          } catch (_) {
            return false;
          }
        }

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

          // Some themes update the cart by replacing the entire list without touching
          // subtotal attributes. React to cart-related childList changes so product-scoped
          // rules (envio/cuotas) update immediately.
          if (m && m.type === 'childList') {
            const relevantTarget = looksCartRelevant(t);
            let relevantNodes = false;
            const added = m.addedNodes || [];
            const removed = m.removedNodes || [];
            for (let j = 0; j < (added ? added.length : 0); j++) {
              if (looksCartRelevant(added[j])) { relevantNodes = true; break; }
            }
            if (!relevantNodes) {
              for (let j = 0; j < (removed ? removed.length : 0); j++) {
                if (looksCartRelevant(removed[j])) { relevantNodes = true; break; }
              }
            }

            if (relevantTarget || relevantNodes) {
              scheduleMaintenance();
              scheduleRender();
              scheduleRemoteEval();
              return;
            }
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
          const openish = isCartOpen() || hasCartItems() || ((getSubtotalAmount() || 0) > 0);
          if (openish) startBurst(1400);
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
      state.lastPulseAt = Date.now();
      state.lastPulseReason = reason;
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
      const selector = '.js-cart-quantity-btn,[data-component="quantity.plus"],[data-component="quantity.minus"]';
      let ctrl = null;
      try { ctrl = target.closest ? target.closest(selector) : null; } catch (_) {}
      if (!ctrl) {
        // SVG <use> elements can behave inconsistently with closest() in some themes.
        let n = target;
        for (let i = 0; n && i < 12; i++) {
          try {
            if (n.matches && n.matches(selector)) { ctrl = n; break; }
          } catch (_) {}
          n = n.parentNode;
        }
      }
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

    loadConfig(false).catch(function () {});
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
          loadConfig(false).catch(function () {});
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
      setTimeout(function () { loadConfig(false).catch(function () {}); }, 500);
      setTimeout(function () { loadConfig(false).catch(function () {}); }, 2000);
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
    buildEvalKeyStable,
    decideEmpty,
    buildLocalEnvioResult,
    buildLocalCuotasResult,
    renderDefault,
    requiresRemoteEvaluation,
    init,
  };
});
