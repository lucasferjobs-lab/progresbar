(function () {
  if (window.__PB_ADMIN_LOADED__) return;
  window.__PB_ADMIN_LOADED__ = true;

  // Configuración inicial
  const cfg = window.__PB_ADMIN__ || {};
  const FALLBACK_ALLOWED_ORIGINS = [
    'https://admin.tiendanube.com',
    'https://admin.nuvemshop.com.br',
    'https://admin.lojavirtualnuvem.com.br',
  ];

  let CLIENT_ID = cfg.clientId || null;
  let ADMIN_ALLOWED_ORIGINS = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : FALLBACK_ALLOWED_ORIGINS;
  let SUPPORT_EMAIL = String(cfg.supportEmail || '').trim();

  // Acciones de comunicación
  const ACTION_CONNECTED = 'app/connected';
  const ACTION_READY = 'app/ready';
  const ACTION_STORE_INFO = 'app/store/info';

  // Elementos del DOM
  const doc = window.document;

  function $(id) {
    return doc.getElementById(id);
  }

  function qsa(selector) {
    return Array.from(doc.querySelectorAll(selector));
  }

  function sanitizeStoreId(value) {
    return String(value || '').replace(/[^0-9]/g, '');
  }

  // Toast notifications
  function showToast(message, kind) {
    const el = $('pbToast');
    if (!el) return;
    
    el.textContent = String(message || '');
    el.classList.remove('is-error');
    if (kind === 'error') el.classList.add('is-error');
    el.classList.add('is-show');
    
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => {
      el.classList.remove('is-show');
    }, 3000);
  }

  // Error handling
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

  // Lock/unlock settings
  function setSettingsLocked(locked, message) {
    const form = $('settingsForm');
    const saveBtn = $('saveBtn');

    if (saveBtn) saveBtn.disabled = !!locked;

    if (form) {
      const fields = form.querySelectorAll('input,select,textarea');
      fields.forEach(field => {
        if (field.id === 'storeId') return;
        field.disabled = !!locked;
      });
    }

    if (locked && message) setNexoError(message);
  }

  // Update billing panel
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
      statusEl.className = 'font-bold text-emerald-600';
    } else if (overrideValid) {
      statusEl.textContent = 'Habilitada por cupón';
      statusEl.className = 'font-bold text-amber-500';
    } else {
      statusEl.textContent = 'Pago requerido';
      statusEl.className = 'font-bold text-red-600';
    }

    const untilText = overrideValid ? new Date(untilMs).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }) : '';
    
    if (untilEl) untilEl.textContent = untilText || '';
    if (untilWrap) untilWrap.classList.toggle('hidden', !overrideValid);

    const code = String(config.billing_override_code || '').trim();
    if (codeEl) {
      codeEl.textContent = code || '...';
    }
    
    if (codeWrap) codeWrap.classList.toggle('hidden', !(overrideValid && !!code));
  }

  // Initialize views navigation
  function initViews() {
    const buttons = qsa('[data-pb-nav="1"][data-pb-view]');
    const panels = qsa('[data-pb-view-panel]');
    
    if (!buttons.length || !panels.length) return;

    function activate(view) {
      buttons.forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.pbView === view);
      });
      
      panels.forEach(panel => {
        panel.classList.toggle('is-active', panel.dataset.pbViewPanel === view);
      });
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        activate(btn.dataset.pbView);
      });
    });

    qsa('[data-pb-jump]').forEach(btn => {
      btn.addEventListener('click', () => {
        activate(btn.dataset.pbJump);
      });
    });

    activate('settings');
  }

  // Initialize tabs
  function initTabs() {
    const root = $('viewSettings');
    if (!root) return;
    
    const tabButtons = qsa('.tab-btn', root);
    const tabPanels = qsa('.tab-panel', root);
    
    if (!tabButtons.length || !tabPanels.length) return;

    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tabTarget;
        
        tabButtons.forEach(b => b.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        const panel = $(target);
        if (panel) panel.classList.add('active');
      });
    });
  }

  // Scope toggle functions
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
    
    (items || []).forEach(item => {
      const opt = doc.createElement('option');
      opt.value = String(item.id);
      opt.textContent = `${String(item.name || 'Sin nombre')} (#${String(item.id)})`;
      selectEl.appendChild(opt);
    });
    
    if (current) selectEl.value = current;
  }

  async function loadAllProducts(storeId) {
    try {
      const response = await fetch(`/api/admin/products/${encodeURIComponent(storeId)}/all`, {
        cache: 'no-store', headers: { 'Accept': 'application/json' }
      });
      if (response && response.status === 402) {
        setSettingsLocked(true, 'Pago requerido. Verifica la facturación de la app en Tiendanube.');
        return [];
      }
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.items) ? data.items : [];
    } catch (error) { return []; }
  }

  async function loadAllCategories(storeId) {
    try {
      const response = await fetch(`/api/admin/categories/${encodeURIComponent(storeId)}/all`, {
        cache: 'no-store', headers: { 'Accept': 'application/json' }
      });
      if (response && response.status === 402) {
        setSettingsLocked(true, 'Pago requerido. Verifica la facturación de la app en Tiendanube.');
        return [];
      }
      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data.items) ? data.items : [];
    } catch (error) { return []; }
  }

  function dispatch(type, payload) {
    if (!(window.parent && window.parent !== window)) return;
    ADMIN_ALLOWED_ORIGINS.forEach(origin => {
      try { window.parent.postMessage({ type, payload }, origin); } catch (_) {}
    });
  }

  function dispatchHandshake() {
    dispatch(ACTION_CONNECTED);
    dispatch(ACTION_READY);
  }

  function waitFor(type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error(`${type} timeout`));
      }, timeoutMs);

      function onMessage(event) {
        if (!event || !ADMIN_ALLOWED_ORIGINS.includes(event.origin)) return;
        const data = event?.data;
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
      try {
        const nexo = nexoLib.create({ clientId: CLIENT_ID, log: false });
        await nexoLib.connect(nexo, 5000);
        nexoLib.iAmReady(nexo);
        const storeInfo = await nexoLib.getStoreInfo(nexo);
        return storeInfo?.id ? sanitizeStoreId(storeInfo.id) : null;
      } catch (error) { return null; }
    }
    dispatchHandshake();
    try {
      dispatch(ACTION_STORE_INFO);
      const storeInfo = await waitFor(ACTION_STORE_INFO, 3000);
      return storeInfo?.id ? sanitizeStoreId(storeInfo.id) : null;
    } catch (_) { return null; }
  }

  async function hydrateFormFromConfig(storeId) {
    const preselected = {};
    let billingLocked = false;
    
    try {
      const cfgRes = await fetch(`/api/config/${encodeURIComponent(storeId)}`, {
        cache: 'no-store', headers: { 'Accept': 'application/json' }
      });
      
      if (cfgRes.ok) {
        const config = await cfgRes.json();
        updateBillingPanel(config);
        
        billingLocked = (() => {
          if (!config || config.billing_active !== false) return false;
          const until = config.billing_override_until;
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
        
        applyConfigValues(config);
        
        preselected.envio_category_id = String(config.envio_category_id || '');
        preselected.envio_product_id = String(config.envio_product_id || '');
        preselected.cuotas_category_id = String(config.cuotas_category_id || '');
        preselected.cuotas_product_id = String(config.cuotas_product_id || '');
        preselected.regalo_primary_product_id = String(config.regalo_primary_product_id || '');
        preselected.regalo_secondary_product_id = String(config.regalo_secondary_product_id || '');
        preselected.regalo_target_product_id = String(config.regalo_target_product_id || '');
        preselected.regalo_target_category_id = String(config.regalo_target_category_id || '');
        preselected.regalo_gift_product_id = String(config.regalo_gift_product_id || '');
      }
    } catch (error) {}
    
    toggleScope($('envio_scope').value, $('envio_product_wrap'), $('envio_category_wrap'));
    toggleScope($('cuotas_scope').value, $('cuotas_product_wrap'), $('cuotas_category_wrap'));
    toggleRegaloMode();
    
    if (billingLocked) return;
    await loadDropdowns(storeId, preselected);
  }
  
  function applyConfigValues(config) {
    if (config.enable_envio_rule != null) $('enable_envio_rule').checked = !!config.enable_envio_rule;
    if (config.enable_cuotas_rule != null) $('enable_cuotas_rule').checked = !!config.enable_cuotas_rule;
    if (config.enable_regalo_rule != null) $('enable_regalo_rule').checked = !!config.enable_regalo_rule;
    
    if (config.envio_min_amount != null) $('envio_min_amount').value = Number(config.envio_min_amount);
    if (config.envio_scope) $('envio_scope').value = String(config.envio_scope);
    if (config.envio_text_prefix != null) $('envio_text_prefix').value = String(config.envio_text_prefix || '');
    if (config.envio_text_suffix != null) $('envio_text_suffix').value = String(config.envio_text_suffix || '');
    if (config.envio_text_reached != null) $('envio_text_reached').value = String(config.envio_text_reached || '');
    if (config.envio_bar_color) {
        $('envio_bar_color').value = String(config.envio_bar_color);
        if($('envio_color_hex')) $('envio_color_hex').innerText = String(config.envio_bar_color).toUpperCase();
    }
    
    if (config.cuotas_threshold_amount != null) $('cuotas_threshold_amount').value = Number(config.cuotas_threshold_amount);
    if (config.cuotas_scope) $('cuotas_scope').value = String(config.cuotas_scope);
    if (config.cuotas_text_prefix != null) $('cuotas_text_prefix').value = String(config.cuotas_text_prefix || '');
    if (config.cuotas_text_suffix != null) $('cuotas_text_suffix').value = String(config.cuotas_text_suffix || '');
    if (config.cuotas_text_reached != null) $('cuotas_text_reached').value = String(config.cuotas_text_reached || '');
    if (config.cuotas_bar_color) $('cuotas_bar_color').value = String(config.cuotas_bar_color);
    
    if (config.regalo_mode) $('regalo_mode').value = String(config.regalo_mode);
    if (config.regalo_min_amount != null) $('regalo_min_amount').value = Number(config.regalo_min_amount);
    if (config.regalo_target_type) $('regalo_target_type').value = String(config.regalo_target_type);
    if (config.regalo_target_qty != null) $('regalo_target_qty').value = Number(config.regalo_target_qty);
    if (config.regalo_text_prefix != null) $('regalo_text_prefix').value = String(config.regalo_text_prefix || '');
    if (config.regalo_text_suffix != null) $('regalo_text_suffix').value = String(config.regalo_text_suffix || '');
    if (config.regalo_text_reached != null) $('regalo_text_reached').value = String(config.regalo_text_reached || '');
    if (config.regalo_bar_color) $('regalo_bar_color').value = String(config.regalo_bar_color);
    
    if (config.ui_bg_color) $('ui_bg_color').value = String(config.ui_bg_color);
    if (config.ui_border_color) $('ui_border_color').value = String(config.ui_border_color);
    if (config.ui_track_color) $('ui_track_color').value = String(config.ui_track_color);
    if (config.ui_text_color) $('ui_text_color').value = String(config.ui_text_color);
    if (config.ui_bar_height != null) {
      const v = Number(config.ui_bar_height);
      $('ui_bar_height').value = v;
      if ($('ui_bar_height_range')) $('ui_bar_height_range').value = String(v);
    }
    if (config.ui_radius != null) $('ui_radius').value = Number(config.ui_radius);
    if (config.ui_shadow != null) $('ui_shadow').checked = !!config.ui_shadow;
    if (config.ui_animation != null) $('ui_animation').checked = !!config.ui_animation;
    if (config.ui_compact != null) $('ui_compact').checked = !!config.ui_compact;
    
    if (config.ui_show_icons != null) $('ui_show_icons').checked = !!config.ui_show_icons;
    if (config.ui_show_percent != null) $('ui_show_percent').checked = !!config.ui_show_percent;
    if (config.ui_percent_bump != null) $('ui_percent_bump').checked = !!config.ui_percent_bump;
    if (config.ui_shimmer != null) $('ui_shimmer').checked = !!config.ui_shimmer;
    if (config.ui_shimmer_opacity != null) {
      const v = Number(config.ui_shimmer_opacity);
      $('ui_shimmer_opacity').value = v;
      if ($('ui_shimmer_opacity_range')) $('ui_shimmer_opacity_range').value = String(v);
    }
    if (config.ui_shimmer_speed != null) $('ui_shimmer_speed').value = Number(config.ui_shimmer_speed);
    
    if (config.ui_elastic != null) $('ui_elastic').checked = !!config.ui_elastic;
    if (config.ui_success_pulse != null) $('ui_success_pulse').checked = !!config.ui_success_pulse;
  }
  
  async function loadDropdowns(storeId, preselected) {
    const selectsToDisable = [
      'envio_product_id', 'envio_category_id', 'cuotas_product_id', 'cuotas_category_id',
      'regalo_primary_product_id', 'regalo_secondary_product_id', 'regalo_target_product_id',
      'regalo_target_category_id', 'regalo_gift_product_id',
    ];
    
    selectsToDisable.forEach(id => {
      if ($(id)) { $(id).disabled = true; $(id).innerHTML = '<option value="">Cargando...</option>'; }
    });
    
    try {
      const [products, categories] = await Promise.all([ loadAllProducts(storeId), loadAllCategories(storeId) ]);
      ['envio_product_id','cuotas_product_id','regalo_primary_product_id','regalo_secondary_product_id','regalo_target_product_id','regalo_gift_product_id'].forEach(id => fillSelect($(id), products));
      ['envio_category_id','cuotas_category_id','regalo_target_category_id'].forEach(id => fillSelect($(id), categories));
      
      selectsToDisable.forEach(id => { if ($(id)) $(id).disabled = false; });
      Object.keys(preselected).forEach(key => { if ($(key) && preselected[key]) $(key).value = preselected[key]; });
    } catch (error) {}
  }

  // Intercept form submit to show modern toast
  doc.addEventListener('DOMContentLoaded', async () => {
    try {
      setSettingsLocked(true, 'Conectando con Tiendanube...');

      try {
        const resp = await fetch('/api/admin/bootstrap', { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (resp.ok) {
          const data = await resp.json();
          if (data && typeof data === 'object') {
            if (data.clientId) CLIENT_ID = data.clientId;
            if (Array.isArray(data.allowedOrigins) && data.allowedOrigins.length) ADMIN_ALLOWED_ORIGINS = data.allowedOrigins;
            if (data.supportEmail) SUPPORT_EMAIL = String(data.supportEmail || '').trim();
          }
        }
      } catch (err) {}

      initViews();
      initTabs();

      if ($('envio_scope')) $('envio_scope').addEventListener('change', () => toggleScope($('envio_scope').value, $('envio_product_wrap'), $('envio_category_wrap')));
      if ($('cuotas_scope')) $('cuotas_scope').addEventListener('change', () => toggleScope($('cuotas_scope').value, $('cuotas_product_wrap'), $('cuotas_category_wrap')));
      if ($('regalo_mode')) $('regalo_mode').addEventListener('change', toggleRegaloMode);
      if ($('regalo_target_type')) $('regalo_target_type').addEventListener('change', toggleRegaloTargetType);

      // Listener para colores UI (sólo estético)
      if ($('envio_bar_color') && $('envio_color_hex')) {
          $('envio_bar_color').addEventListener('input', (e) => $('envio_color_hex').innerText = e.target.value.toUpperCase());
      }
      
      // Sincronizar sliders y numbers
      ['ui_bar_height', 'ui_shimmer_opacity'].forEach(id => {
          if($(id) && $(id + '_range')) {
              $(id).addEventListener('input', (e) => $(id + '_range').value = e.target.value);
              $(id + '_range').addEventListener('input', (e) => $(id).value = e.target.value);
          }
      });

      const couponBtn = $('couponRedeemBtn');
      const couponInput = $('couponCode');
      if (couponBtn && couponInput) {
        couponBtn.addEventListener('click', async () => {
          const storeId = sanitizeStoreId($('storeId') && $('storeId').value);
          const code = String(couponInput.value || '').trim().toUpperCase();
          if (!storeId || !code) { showToast('Ingresá el código de cupón.', 'error'); return; }
          try {
            couponBtn.disabled = true;
            const resp = await fetch('/api/billing/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ store_id: storeId, code }) });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok || data.statusCode >= 400) {
              showToast(data && data.error ? String(data.error) : 'No se pudo aplicar el cupón.', 'error');
            } else {
              showToast('Cupón aplicado correctamente.', null);
              const cfgRes = await fetch(`/api/config/${encodeURIComponent(storeId)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
              if (cfgRes.ok) updateBillingPanel(await cfgRes.json());
            }
          } catch (err) { showToast('Error al aplicar el cupón.', 'error'); } 
          finally { couponBtn.disabled = false; }
        });
      }

      if ($('supportEmailBtn')) {
        $('supportEmailBtn').addEventListener('click', (ev) => {
          ev.preventDefault();
          const email = SUPPORT_EMAIL || 'contacto@franfersoluciones.com';
          window.location.href = `mailto:${email}?subject=${encodeURIComponent('Consulta sobre ProgressBar CRO')}&body=${encodeURIComponent('Hola,\n\nNecesito ayuda con la configuración de ProgressBar en mi tienda Tiendanube.\n\nGracias.')}`;
        });
      }

      const storeId = await resolveStoreIdViaNexo();
      if (!storeId) {
        setNexoError('No se pudo obtener la tienda desde Nexo. Cerrá y volvé a abrir la app desde el Admin de Tiendanube.');
        setSettingsLocked(true);
        return;
      }

      if ($('storeId')) $('storeId').value = storeId;
      if ($('storeLabel')) $('storeLabel').textContent = `#${storeId}`;

      setNexoError('');
      setSettingsLocked(false);
      await hydrateFormFromConfig(storeId);
      
      // Submit handler for toast
      $('settingsForm').addEventListener('submit', function(e) {
          // Asumimos que el form enviará el POST via action natural (como lo tenías). 
          // Mostramos el toast antes de la recarga (o si lo cambias a fetch asíncrono en el futuro).
          showToast('Guardando configuración...', null);
          $('saveBtn').disabled = true;
          $('saveBtn').innerHTML = '<span class="opacity-80">Guardando...</span>';
      });
      
    } catch (err) {
      setNexoError('Ocurrió un error al inicializar la app. Intentá recargar la página.');
      setSettingsLocked(true);
    }
  });
})();