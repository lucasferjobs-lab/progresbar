(function () {
  if (window.__PB_ADMIN_LOADED__) return;
  window.__PB_ADMIN_LOADED__ = true;

  const cfg = window.__PB_ADMIN__ || {};
  const FALLBACK_ALLOWED_ORIGINS = [
    'https://admin.tiendanube.com',
    'https://admin.nuvemshop.com.br',
    'https://admin.lojavirtualnuvem.com.br',
  ];

  let CLIENT_ID = cfg.clientId || null;
  let ADMIN_ALLOWED_ORIGINS = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : FALLBACK_ALLOWED_ORIGINS;
  let SUPPORT_EMAIL = String(cfg.supportEmail || '').trim();

  const ACTION_CONNECTED = 'app/connected';
  const ACTION_READY = 'app/ready';
  const ACTION_STORE_INFO = 'app/store/info';

  const doc = window.document;

  function $(id) {
    return doc.getElementById(id);
  }

  function sanitizeStoreId(value) {
    return String(value || '').replace(/[^0-9]/g, '');
  }

  function showToast(message, kind) {
    const el = $('pbToast');
    if (!el) return;
    el.textContent = String(message || '');
    el.classList.remove('is-error');
    if (kind === 'error') el.classList.add('is-error');
    el.classList.add('is-show');
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(function () {
      el.classList.remove('is-show');
    }, 2300);
  }

  function setNexoError(message) {
    const el = $('nexoError');
    if (!el) return;
    if (!message) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.textContent = String(message);
    el.style.display = '';
  }

  function setSettingsLocked(locked, message) {
    const form = $('settingsForm');
    const saveBtn = $('saveBtn');

    if (saveBtn) saveBtn.disabled = !!locked;

    if (form) {
      const fields = form.querySelectorAll('input,select,textarea');
      for (let i = 0; i < fields.length; i++) {
        const el = fields[i];
        if (!el) continue;
        if (el.id === 'storeId') continue;
        el.disabled = !!locked;
      }
    }

    if (locked && message) setNexoError(message);
  }

  function updateBillingPanel(config) {
    const statusEl = $('billingStatus');
    const untilWrap = $('billingUntilWrap');
    const untilEl = $('billingUntil');
    const codeWrap = $('billingCodeWrap');
    const codeEl = $('billingCode');

    if (!statusEl) return;

    if (!config) {
      statusEl.textContent = '...';
      if (untilWrap) untilWrap.classList.add('hidden');
      if (codeWrap) codeWrap.classList.add('hidden');
      return;
    }

    const active = config.billing_active !== false;
    const untilRaw = config.billing_override_until ? String(config.billing_override_until) : '';
    const untilMs = untilRaw ? Date.parse(untilRaw) : NaN;
    const overrideValid = Number.isFinite(untilMs) && untilMs > Date.now();

    if (active) {
      statusEl.textContent = 'Activa';
    } else if (overrideValid) {
      statusEl.textContent = 'Habilitada por cupón';
    } else {
      statusEl.textContent = 'Pago requerido';
    }

    const untilText = overrideValid ? new Date(untilMs).toLocaleString() : '';
    if (untilEl) untilEl.textContent = untilText || '';
    if (untilWrap) untilWrap.classList.toggle('hidden', !overrideValid);

    const code = String(config.billing_override_code || '').trim();
    if (codeEl) codeEl.textContent = code || '...';
    if (codeWrap) codeWrap.classList.toggle('hidden', !(overrideValid && !!code));
  }

  function initViews() {
    const buttons = Array.prototype.slice.call(doc.querySelectorAll('[data-pb-nav=\"1\"][data-pb-view]'));
    const panels = Array.prototype.slice.call(doc.querySelectorAll('[data-pb-view-panel]'));
    if (!buttons.length || !panels.length) return;

    function activate(view) {
      buttons.forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-pb-view') === view);
      });
      panels.forEach(function (p) {
        p.classList.toggle('is-active', p.getAttribute('data-pb-view-panel') === view);
      });
    }

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        activate(btn.getAttribute('data-pb-view'));
      });
    });

    // Jump buttons inside content (do not affect the nav active state outside activate()).
    Array.prototype.slice.call(doc.querySelectorAll('[data-pb-jump]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        activate(btn.getAttribute('data-pb-jump'));
      });
    });

    activate('settings');
  }

  function initTabs() {
    const root = $('viewSettings');
    if (!root) return;
    const tabButtons = Array.prototype.slice.call(root.querySelectorAll('.tab-btn'));
    const tabPanels = Array.prototype.slice.call(root.querySelectorAll('.tab-panel'));
    if (!tabButtons.length || !tabPanels.length) return;

    tabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = btn.getAttribute('data-tab-target');
        tabButtons.forEach(function (b) { b.classList.remove('active'); });
        tabPanels.forEach(function (p) { p.classList.remove('active'); });
        btn.classList.add('active');
        const panel = doc.getElementById(target);
        if (panel) panel.classList.add('active');
      });
    });
  }

  function toggleScope(scope, productWrap, categoryWrap) {
    if (!productWrap || !categoryWrap) return;
    const s = String(scope || 'all');
    productWrap.classList.toggle('hidden', s !== 'product');
    categoryWrap.classList.toggle('hidden', s !== 'category');
  }

  function toggleRegaloMode() {
    const regaloModeInput = $('regalo_mode');
    const regaloComboFields = $('regalo_combo_fields');
    const regaloTargetFields = $('regalo_target_fields');
    if (!regaloModeInput || !regaloComboFields || !regaloTargetFields) return;

    const mode = String(regaloModeInput.value || 'combo_products');
    const isCombo = mode === 'combo_products';
    regaloComboFields.classList.toggle('hidden', !isCombo);
    regaloTargetFields.classList.toggle('hidden', isCombo);
    toggleRegaloTargetType();
  }

  function toggleRegaloTargetType() {
    const regaloTargetTypeInput = $('regalo_target_type');
    const regaloTargetProductWrap = $('regalo_target_product_wrap');
    const regaloTargetCategoryWrap = $('regalo_target_category_wrap');
    if (!regaloTargetTypeInput || !regaloTargetProductWrap || !regaloTargetCategoryWrap) return;

    const type = String(regaloTargetTypeInput.value || 'same_product_qty');
    regaloTargetProductWrap.classList.toggle('hidden', type !== 'same_product_qty');
    regaloTargetCategoryWrap.classList.toggle('hidden', type !== 'category_qty');
  }

  function fillSelect(selectEl, items) {
    if (!selectEl) return;
    const current = String(selectEl.value || '');
    selectEl.innerHTML = '<option value="">Seleccionar</option>';
    (items || []).forEach(function (item) {
      const opt = doc.createElement('option');
      opt.value = String(item.id);
      opt.textContent = String(item.name || 'Sin nombre') + ' (#' + String(item.id) + ')';
      selectEl.appendChild(opt);
    });
    if (current) selectEl.value = current;
  }

  async function loadAllProducts(storeId) {
    const r = await fetch('/api/admin/products/' + encodeURIComponent(storeId) + '/all', { cache: 'no-store' });
    if (r && r.status === 402) {
      setSettingsLocked(true, 'Pago requerido. Verifica la facturación de la app en Tiendanube.');
      return [];
    }
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  async function loadAllCategories(storeId) {
    const r = await fetch('/api/admin/categories/' + encodeURIComponent(storeId) + '/all', { cache: 'no-store' });
    if (r && r.status === 402) {
      setSettingsLocked(true, 'Pago requerido. Verifica la facturación de la app en Tiendanube.');
      return [];
    }
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  function dispatch(type, payload) {
    if (!(window.parent && window.parent !== window)) return;
    ADMIN_ALLOWED_ORIGINS.forEach(function (origin) {
      try {
        window.parent.postMessage({ type: type, payload: payload }, origin);
      } catch (_) {}
    });
  }

  function dispatchHandshake() {
    dispatch(ACTION_CONNECTED);
    dispatch(ACTION_READY);
  }

  function waitFor(type, timeoutMs) {
    const ms = Math.max(100, Number(timeoutMs || 0));
    return new Promise(function (resolve, reject) {
      const timeoutId = window.setTimeout(function () {
        window.removeEventListener('message', onMessage);
        reject(new Error(type + ' timeout'));
      }, ms);

      function onMessage(event) {
        if (!event || !ADMIN_ALLOWED_ORIGINS.includes(event.origin)) return;
        const data = event && event.data;
        if (!data || data.type !== type) return;
        window.clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
        resolve(data.payload || {});
      }

      window.addEventListener('message', onMessage);
    });
  }

  async function resolveStoreIdViaNexo() {
    if (!(window.parent && window.parent !== window)) return null;

    const nexoLib = window['@tiendanube/nexo'];
    if (CLIENT_ID && nexoLib && typeof nexoLib.create === 'function') {
      const nexo = nexoLib.create({ clientId: CLIENT_ID, log: false });
      await nexoLib.connect(nexo, 5000);
      nexoLib.iAmReady(nexo);
      const storeInfo = await nexoLib.getStoreInfo(nexo);
      return storeInfo && storeInfo.id ? sanitizeStoreId(storeInfo.id) : null;
    }

    dispatchHandshake();
    waitFor(ACTION_CONNECTED, 3500).catch(function () {});
    try {
      const storeInfo = await (function () {
        const info = waitFor(ACTION_STORE_INFO, 3000);
        dispatch(ACTION_STORE_INFO);
        return info;
      })();
      return storeInfo && storeInfo.id ? sanitizeStoreId(storeInfo.id) : null;
    } catch (_) {
      return null;
    }
  }

  async function hydrateFormFromConfig(storeId) {
    const preselected = {};
    let billingLocked = false;
    try {
      const cfgRes = await fetch('/api/config/' + encodeURIComponent(storeId), { cache: 'no-store' });
      if (cfgRes.ok) {
        const c = await cfgRes.json();
        updateBillingPanel(c);
        billingLocked = (function () {
          if (!c || c.billing_active !== false) return false;
          const until = c.billing_override_until;
          if (!until) return true;
          const ms = Date.parse(String(until));
          if (!Number.isFinite(ms)) return true;
          return ms <= Date.now();
        })();
        if (billingLocked) {
          setSettingsLocked(true, 'Pago requerido. Verifica la facturación de la app en Tiendanube.');
        } else {
          setSettingsLocked(false);
        }

        if (c.enable_envio_rule != null) $('enable_envio_rule').checked = !!c.enable_envio_rule;
        if (c.enable_cuotas_rule != null) $('enable_cuotas_rule').checked = !!c.enable_cuotas_rule;
        if (c.enable_regalo_rule != null) $('enable_regalo_rule').checked = !!c.enable_regalo_rule;

        if (c.envio_min_amount != null) $('envio_min_amount').value = Number(c.envio_min_amount);
        if (c.envio_scope) $('envio_scope').value = String(c.envio_scope);
        if (c.envio_text_prefix != null) $('envio_text_prefix').value = String(c.envio_text_prefix || '');
        if (c.envio_text_suffix != null) $('envio_text_suffix').value = String(c.envio_text_suffix || '');
        if (c.envio_text_reached != null) $('envio_text_reached').value = String(c.envio_text_reached || '');
        if (c.envio_bar_color) $('envio_bar_color').value = String(c.envio_bar_color);

        if (c.cuotas_threshold_amount != null) $('cuotas_threshold_amount').value = Number(c.cuotas_threshold_amount);
        if (c.cuotas_scope) $('cuotas_scope').value = String(c.cuotas_scope);
        if (c.cuotas_text_prefix != null) $('cuotas_text_prefix').value = String(c.cuotas_text_prefix || '');
        if (c.cuotas_text_suffix != null) $('cuotas_text_suffix').value = String(c.cuotas_text_suffix || '');
        if (c.cuotas_text_reached != null) $('cuotas_text_reached').value = String(c.cuotas_text_reached || '');
        if (c.cuotas_bar_color) $('cuotas_bar_color').value = String(c.cuotas_bar_color);

        if (c.regalo_mode) $('regalo_mode').value = String(c.regalo_mode);
        if (c.regalo_min_amount != null) $('regalo_min_amount').value = Number(c.regalo_min_amount);
        if (c.regalo_target_type) $('regalo_target_type').value = String(c.regalo_target_type);
        if (c.regalo_target_qty != null) $('regalo_target_qty').value = Number(c.regalo_target_qty);
        if (c.regalo_text_prefix != null) $('regalo_text_prefix').value = String(c.regalo_text_prefix || '');
        if (c.regalo_text_suffix != null) $('regalo_text_suffix').value = String(c.regalo_text_suffix || '');
        if (c.regalo_text_reached != null) $('regalo_text_reached').value = String(c.regalo_text_reached || '');
        if (c.regalo_bar_color) $('regalo_bar_color').value = String(c.regalo_bar_color);

        if (c.ui_bg_color) $('ui_bg_color').value = String(c.ui_bg_color);
        if (c.ui_border_color) $('ui_border_color').value = String(c.ui_border_color);
        if (c.ui_track_color) $('ui_track_color').value = String(c.ui_track_color);
        if (c.ui_text_color) $('ui_text_color').value = String(c.ui_text_color);
        if (c.ui_bar_height != null) {
          const v = Number(c.ui_bar_height);
          $('ui_bar_height').value = v;
          const r = $('ui_bar_height_range');
          if (r) r.value = String(v);
        }
        if (c.ui_radius != null) $('ui_radius').value = Number(c.ui_radius);
        if (c.ui_shadow != null) $('ui_shadow').checked = !!c.ui_shadow;
        if (c.ui_animation != null) $('ui_animation').checked = !!c.ui_animation;
        if (c.ui_compact != null) $('ui_compact').checked = !!c.ui_compact;

        preselected.envio_category_id = String(c.envio_category_id || '');
        preselected.envio_product_id = String(c.envio_product_id || '');
        preselected.cuotas_category_id = String(c.cuotas_category_id || '');
        preselected.cuotas_product_id = String(c.cuotas_product_id || '');
        preselected.regalo_primary_product_id = String(c.regalo_primary_product_id || '');
        preselected.regalo_secondary_product_id = String(c.regalo_secondary_product_id || '');
        preselected.regalo_target_product_id = String(c.regalo_target_product_id || '');
        preselected.regalo_target_category_id = String(c.regalo_target_category_id || '');
        preselected.regalo_gift_product_id = String(c.regalo_gift_product_id || '');
      }
    } catch (_) {}

    toggleScope($('envio_scope').value, $('envio_product_wrap'), $('envio_category_wrap'));
    toggleScope($('cuotas_scope').value, $('cuotas_product_wrap'), $('cuotas_category_wrap'));
    toggleRegaloMode();

    if (billingLocked) return;

    try {
      const selectsToDisable = [
        'envio_product_id',
        'envio_category_id',
        'cuotas_product_id',
        'cuotas_category_id',
        'regalo_primary_product_id',
        'regalo_secondary_product_id',
        'regalo_target_product_id',
        'regalo_target_category_id',
        'regalo_gift_product_id',
      ];

      selectsToDisable.forEach(function (id) {
        const el = $(id);
        if (!el) return;
        el.disabled = true;
        el.innerHTML = '<option value="">Cargando...</option>';
      });

      const [products, categories] = await Promise.all([
        loadAllProducts(storeId),
        loadAllCategories(storeId),
      ]);

      [
        'envio_product_id',
        'cuotas_product_id',
        'regalo_primary_product_id',
        'regalo_secondary_product_id',
        'regalo_target_product_id',
        'regalo_gift_product_id',
      ].forEach(function (id) { fillSelect($(id), products); });

      [
        'envio_category_id',
        'cuotas_category_id',
        'regalo_target_category_id',
      ].forEach(function (id) { fillSelect($(id), categories); });

      selectsToDisable.forEach(function (id) {
        const el = $(id);
        if (el) el.disabled = false;
      });

      Object.keys(preselected).forEach(function (key) {
        const el = $(key);
        if (el && preselected[key]) el.value = preselected[key];
      });
    } catch (_) {}
  }

  function bindSaveAjax() {
    const form = $('settingsForm');
    const btn = $('saveBtn');
    if (!form || !btn) return;

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      setNexoError('');

      const storeId = sanitizeStoreId($('storeId').value || '');
      if (!storeId) {
        showToast('Store ID pendiente', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Guardando...';

      try {
        const fd = new FormData(form);
        const body = new URLSearchParams();
        fd.forEach(function (value, key) {
          body.append(key, String(value));
        });

        const res = await fetch('/admin/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
          },
          body: body.toString(),
        });

        const data = await res.json().catch(function () { return null; });
        if (!res.ok) {
          const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'Save failed';
          showToast('No se pudo guardar', 'error');
          setNexoError(msg);
          return;
        }

        showToast('Guardado', 'ok');
      } catch (err) {
        void err;
        showToast('No se pudo guardar', 'error');
        setNexoError('Save failed');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Guardar configuración';
      }
    });
  }

  function bindCouponRedeem() {
    const btn = $('couponRedeemBtn');
    const input = $('couponCode');
    if (!btn || !input) return;

    btn.addEventListener('click', async function () {
      setNexoError('');
      const storeId = sanitizeStoreId($('storeId').value || '');
      const code = String(input.value || '').trim().toUpperCase();

      if (!storeId) {
        showToast('Store ID pendiente', 'error');
        return;
      }
      if (!code) {
        showToast('Cupón inválido', 'error');
        return;
      }

      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Aplicando...';

      try {
        const res = await fetch('/api/billing/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ store_id: storeId, code: code }),
        });

        const data = await res.json().catch(function () { return null; });
        if (!res.ok) {
          const msg = data && (data.error || data.message) ? String(data.error || data.message) : 'Cupón inválido';
          showToast('Cupón inválido', 'error');
          setNexoError(msg);
          return;
        }

        input.value = '';
        showToast('Cupón aplicado', 'ok');
        setSettingsLocked(false);
        await hydrateFormFromConfig(storeId);
      } catch (_) {
        showToast('Cupón inválido', 'error');
        setNexoError('Cupón inválido');
      } finally {
        btn.disabled = false;
        btn.textContent = prev || 'Aplicar cupón';
      }
    });
  }

  function boot() {
    initViews();
    initTabs();
    bindSaveAjax();
    bindCouponRedeem();

    (function bindUiRangeSync() {
      const range = $('ui_bar_height_range');
      const number = $('ui_bar_height');
      if (!range || !number) return;

      function clamp(n) {
        const min = Number(number.min || 6);
        const max = Number(number.max || 24);
        const v = Math.round(Number(n || 0));
        if (!Number.isFinite(v)) return min;
        return Math.max(min, Math.min(max, v));
      }

      function syncFromRange() {
        const v = clamp(range.value);
        number.value = String(v);
      }

      function syncFromNumber() {
        const v = clamp(number.value);
        number.value = String(v);
        range.value = String(v);
      }

      range.addEventListener('input', syncFromRange);
      number.addEventListener('input', syncFromNumber);
      number.addEventListener('change', syncFromNumber);

      // Initial sync (covers default values before config loads).
      syncFromNumber();
    })();

    const envioScopeInput = $('envio_scope');
    const cuotasScopeInput = $('cuotas_scope');
    const regaloModeInput = $('regalo_mode');
    const regaloTargetTypeInput = $('regalo_target_type');

    if (envioScopeInput) {
      envioScopeInput.addEventListener('change', function () {
        toggleScope(envioScopeInput.value, $('envio_product_wrap'), $('envio_category_wrap'));
      });
    }
    if (cuotasScopeInput) {
      cuotasScopeInput.addEventListener('change', function () {
        toggleScope(cuotasScopeInput.value, $('cuotas_product_wrap'), $('cuotas_category_wrap'));
      });
    }
    if (regaloModeInput) regaloModeInput.addEventListener('change', toggleRegaloMode);
    if (regaloTargetTypeInput) regaloTargetTypeInput.addEventListener('change', toggleRegaloTargetType);

    // Saved toast for non-JS saves (fallback).
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('saved') === '1') {
        showToast('Guardado', 'ok');
        u.searchParams.delete('saved');
        window.history.replaceState({}, '', u.toString());
      }
    } catch (_) {}

    async function loadBootstrap() {
      try {
        const r = await fetch('/api/admin/bootstrap', { cache: 'no-store' });
        if (!r.ok) return;
        const b = await r.json();
        if (b && b.clientId) CLIENT_ID = String(b.clientId);
        if (b && Array.isArray(b.allowedOrigins) && b.allowedOrigins.length) ADMIN_ALLOWED_ORIGINS = b.allowedOrigins;
        if (b && b.supportEmail) SUPPORT_EMAIL = String(b.supportEmail || '').trim();
      } catch (_) {}
    }

    function parseInitialStoreIdFromUrl() {
      try {
        const u = new URL(window.location.href);
        return sanitizeStoreId(u.searchParams.get('store_id') || u.searchParams.get('store') || '');
      } catch (_) {
        return '';
      }
    }

    (async function initStore() {
      await loadBootstrap();

      const storeIdInput = $('storeId');
      const storeIdLabel = $('storeLabel');

      const initialStoreId = sanitizeStoreId(parseInitialStoreIdFromUrl() || cfg.initialStoreId || storeIdInput.value || '');
      if (storeIdInput && initialStoreId) storeIdInput.value = initialStoreId;
      if (storeIdLabel && initialStoreId) storeIdLabel.textContent = initialStoreId;

      let resolved = initialStoreId;
      try {
        const fromNexo = await resolveStoreIdViaNexo();
        if (fromNexo) resolved = fromNexo;
      } catch (_) {}

      if (storeIdInput && resolved) storeIdInput.value = resolved;
      if (storeIdLabel && resolved) storeIdLabel.textContent = resolved;

      if (!resolved) {
        setNexoError('No se pudo inicializar Nexo. Verifica la URL dentro del Admin de Tiendanube.');
        return;
      }

      await hydrateFormFromConfig(resolved);

      // Contact actions (after bootstrap so SUPPORT_EMAIL is fresh).
      const mailBtn = $('supportEmailBtn');
      if (mailBtn && SUPPORT_EMAIL) {
        mailBtn.href = 'mailto:' + encodeURIComponent(SUPPORT_EMAIL);
      }
    })();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
