require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const pool = require('./db');
const { registerPortalRoutes } = require('./portal');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const CLIENT_ID = process.env.TIENDANUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.TIENDANUBE_CLIENT_SECRET;
const SCRIPT_ID = process.env.TIENDANUBE_SCRIPT_ID;
const SCRIPT_QUERY_PARAMS = process.env.TIENDANUBE_SCRIPT_QUERY_PARAMS || '';
const DEFAULT_SCRIPT_SRC = APP_BASE_URL ? `${APP_BASE_URL}/barra.js` : '';
const APP_SCRIPT_SRC = process.env.APP_SCRIPT_SRC || DEFAULT_SCRIPT_SRC;
const APP_USER_AGENT = process.env.TIENDANUBE_USER_AGENT || `ProgressBar-TN (${CLIENT_ID || 'unknown'})`;
const OAUTH_STATE_ENFORCE = process.env.OAUTH_STATE_ENFORCE === 'true';
const OAUTH_STATE_TTL_MS = Number(process.env.OAUTH_STATE_TTL_MS || 10 * 60 * 1000);
const API_BASE = process.env.TIENDANUBE_API_BASE || 'https://api.tiendanube.com';
const API_VERSION = process.env.TIENDANUBE_API_VERSION || '2025-03';

const ADMIN_ALLOWED_ORIGINS = [
  'https://admin.tiendanube.com',
  'https://admin.nuvemshop.com.br',
  'https://admin.lojavirtualnuvem.com.br',
];

const oauthStateStore = new Map();
const evaluateGoalsCache = new Map();
let goalSettingsTableReady = false;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('[WARN] Missing TIENDANUBE_CLIENT_ID or TIENDANUBE_CLIENT_SECRET in environment.');
}
if (!APP_BASE_URL) {
  console.warn('[WARN] APP_BASE_URL is empty. Use a stable HTTPS public domain in production.');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- INICIO DEL FIX DE SEGURIDAD PARA EL IFRAME ---
app.use((req, res, next) => {
  const frameAncestorsAllowed = [
    'https://*.mitiendanube.com',
    'https://admin.tiendanube.com',
    'https://*.nuvemshop.com.br',
    'https://*.lojavirtualnuvem.com.br',
  ].join(' ');

  // 1. Permitimos explícitamente el iframe de Tiendanube
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${frameAncestorsAllowed};`);

  // 2. Removemos restricciones de servidores antiguos
  res.removeHeader('X-Frame-Options');

  // 3. FIX CRÍTICO: Evitamos el error "strict-origin-when-cross-origin"
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  
  // 4. Mantenemos tus otras configuraciones de seguridad
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  next();
});
// --- FIN DEL FIX DE SEGURIDAD ---

// CORS for storefront script/config/evaluation fetches from merchant domains.
app.use(['/api/config', '/api/goals'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files used by storefront script
app.use('/static', express.static(path.join(__dirname)));
app.get('/barra.js', (_req, res) => res.sendFile(path.join(__dirname, 'barra.js')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/estilos.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));

app.get('/', (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(302, `/admin${query}`);
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Optional helper to generate a short-lived OAuth state in case you build
// a custom "start installation" flow.
app.get('/oauth/state', (_req, res) => {
  const state = randomState();
  storeOAuthState(state);
  res.status(200).json({ state, expires_in_ms: OAUTH_STATE_TTL_MS });
});

function randomState() {
  return crypto.randomBytes(24).toString('hex');
}

function storeOAuthState(state) {
  oauthStateStore.set(state, Date.now() + OAUTH_STATE_TTL_MS);
}

function consumeOAuthState(state) {
  const expiresAt = oauthStateStore.get(state);
  oauthStateStore.delete(state);
  if (!expiresAt) return false;
  return Date.now() <= expiresAt;
}

setInterval(() => {
  const now = Date.now();
  for (const [state, expiresAt] of oauthStateStore.entries()) {
    if (expiresAt <= now) oauthStateStore.delete(state);
  }
}, 60_000).unref();

function parseQueryParams(raw, storeId) {
  let base = { store_id: String(storeId) };

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = { ...parsed, store_id: String(storeId) };
      }
    } catch {
      base = { store_id: String(storeId) };
    }
  }

  // Tiendanube expects query_params as a JSON string.
  return JSON.stringify(base);
}

function apiStoreUrl(storeId, resourcePath) {
  return `${API_BASE}/${API_VERSION}/${storeId}/${resourcePath}`;
}

async function ensureGoalSettingsTable() {
  if (goalSettingsTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_goal_settings (
      id SERIAL PRIMARY KEY,
      store_id VARCHAR(255) NOT NULL UNIQUE REFERENCES tiendas(store_id) ON DELETE CASCADE,
      cuotas_threshold_amount DECIMAL DEFAULT 0,
      cuotas_category_id VARCHAR(255),
      cuotas_product_id VARCHAR(255),
      regalo_min_amount DECIMAL DEFAULT 0,
      regalo_primary_product_id VARCHAR(255),
      regalo_secondary_product_id VARCHAR(255),
      regalo_gift_product_id VARCHAR(255),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  goalSettingsTableReady = true;
}

async function getStoreAccessToken(storeId) {
  const result = await pool.query(
    `SELECT access_token
     FROM tiendas
     WHERE store_id = $1
     LIMIT 1`,
    [storeId]
  );
  return result.rows[0] ? String(result.rows[0].access_token || '') : '';
}

function pickLocalizedName(nameValue) {
  if (!nameValue) return '';
  if (typeof nameValue === 'string') return nameValue;
  if (typeof nameValue === 'object') {
    return String(
      nameValue.es ||
      nameValue['es_AR'] ||
      nameValue['es_MX'] ||
      nameValue.pt ||
      nameValue.en ||
      Object.values(nameValue)[0] ||
      ''
    );
  }
  return '';
}

function parseCollection(data, keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data && data[key])) return data[key];
  }
  return [];
}

async function upsertStore(storeId, accessToken) {
  await pool.query(
    `INSERT INTO tiendas (store_id, access_token)
     VALUES ($1, $2)
     ON CONFLICT (store_id)
     DO UPDATE SET access_token = EXCLUDED.access_token`,
    [String(storeId), accessToken]
  );
}

async function ensureStoreScript(storeId, accessToken) {
  const endpoint = apiStoreUrl(storeId, 'scripts');
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': APP_USER_AGENT,
  };

  if (SCRIPT_ID) {
    const body = {
      script_id: Number(SCRIPT_ID),
      query_params: parseQueryParams(SCRIPT_QUERY_PARAMS, storeId),
    };
    try {
      await axios.post(endpoint, body, { headers, timeout: 8000 });
      return { linked: true };
    } catch (error) {
      const status = error.response?.status;
      const message = String(error.response?.data?.message || '');
      const isAutoInstalled = status === 422 && message.includes('Script is auto installed');
      if (isAutoInstalled) {
        return { linked: false, reason: 'auto_installed' };
      }
      throw error;
    }
  }

  if (APP_SCRIPT_SRC) {
    const body = {
      src: APP_SCRIPT_SRC,
      event: 'onload',
      where: 'store',
    };

    await axios.post(endpoint, body, { headers, timeout: 8000 });
    return { linked: true };
  }

  return { linked: false, reason: 'no_script_configured' };
}

const productCategoryCache = new Map();

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeCartPayload(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const itemsIn = Array.isArray(raw.items) ? raw.items : [];

  const items = itemsIn.map((item) => {
    const quantity = Math.max(1, Number(item.quantity || 1));
    const unitPrice = toNumberOrNull(item.unit_price);
    const lineTotal = toNumberOrNull(item.line_total);

    return {
      product_id: String(item.product_id || '').trim(),
      quantity,
      unit_price: unitPrice != null ? unitPrice : null,
      line_total: lineTotal != null ? lineTotal : (unitPrice != null ? unitPrice * quantity : 0),
      categories: Array.isArray(item.categories) ? item.categories.map((c) => String(c)) : [],
    };
  }).filter((i) => i.product_id);

  const total = toNumberOrNull(raw.total_amount);
  const computedTotal = items.reduce((acc, i) => acc + (toNumberOrNull(i.line_total) || 0), 0);

  return {
    total_amount: total != null ? total : computedTotal,
    items,
  };
}

async function fetchProductCategories(storeId, accessToken, productId) {
  const cacheKey = `${storeId}:${productId}`;
  const now = Date.now();
  const cached = productCategoryCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.categories;

  const url = `${apiStoreUrl(storeId, `products/${productId}`)}?fields=id,categories`;
  const headers = {
    Authentication: `bearer ${accessToken}`,
    'User-Agent': APP_USER_AGENT,
    'Content-Type': 'application/json',
  };

  const resp = await axios.get(url, { headers, timeout: 8000 });
  const product = resp.data || {};
  const categories = Array.isArray(product.categories)
    ? product.categories.map((c) => String((c && c.id) || c)).filter(Boolean)
    : [];

  productCategoryCache.set(cacheKey, { categories, expiresAt: now + 5 * 60 * 1000 });
  return categories;
}

async function evaluateAdvancedGoals(storeId, payload) {
  await ensureGoalSettingsTable();
  const norm = normalizeCartPayload(payload);
  const settingsResult = await pool.query(
    `SELECT s.*, t.access_token
     FROM store_goal_settings s
     JOIN tiendas t ON t.store_id = s.store_id
     WHERE s.store_id = $1
     LIMIT 1`,
    [storeId]
  );
  const settings = settingsResult.rows[0];
  if (!settings) {
    return { cuotas: null, regalo: null, cart_total: norm.total_amount };
  }

  const accessToken = settings.access_token;
  const out = { cuotas: null, regalo: null, cart_total: norm.total_amount };

  const cuotasThreshold = toNumberOrNull(settings.cuotas_threshold_amount) || 0;
  const cuotasCategoryId = String(settings.cuotas_category_id || '').trim();
  const cuotasProductId = String(settings.cuotas_product_id || '').trim();

  if (cuotasThreshold > 0 && (cuotasCategoryId || cuotasProductId)) {
    let eligibleSubtotal = 0;
    let hasMatch = false;

    for (const item of norm.items) {
      let matches = false;
      if (cuotasProductId && item.product_id === cuotasProductId) {
        matches = true;
      }

      if (!matches && cuotasCategoryId) {
        const localCats = item.categories || [];
        if (localCats.includes(cuotasCategoryId)) {
          matches = true;
        } else if (accessToken) {
          try {
            const remoteCats = await fetchProductCategories(storeId, accessToken, item.product_id);
            if (remoteCats.includes(cuotasCategoryId)) {
              matches = true;
            }
          } catch (_) {}
        }
      }

      if (matches) {
        hasMatch = true;
        eligibleSubtotal += toNumberOrNull(item.line_total) || 0;
      }
    }

    const missing = Math.max(0, cuotasThreshold - eligibleSubtotal);
    out.cuotas = {
      has_match: hasMatch,
      threshold_amount: cuotasThreshold,
      eligible_subtotal: eligibleSubtotal,
      missing_amount: missing,
      reached: hasMatch && missing <= 0,
      target: {
        category_id: cuotasCategoryId || null,
        product_id: cuotasProductId || null,
      },
      progress: cuotasThreshold > 0 ? Math.max(0, Math.min(1, eligibleSubtotal / cuotasThreshold)) : 0,
    };
  }

  const regaloMin = toNumberOrNull(settings.regalo_min_amount) || 0;
  const regaloPrimary = String(settings.regalo_primary_product_id || '').trim();
  const regaloSecondary = String(settings.regalo_secondary_product_id || '').trim();
  const regaloGift = String(settings.regalo_gift_product_id || '').trim();

  if (regaloMin > 0 && regaloPrimary && regaloSecondary) {
    const hasPrimary = norm.items.some((i) => i.product_id === regaloPrimary);
    const hasSecondary = norm.items.some((i) => i.product_id === regaloSecondary);
    const comboMatched = hasPrimary && hasSecondary;
    const missing = comboMatched ? Math.max(0, regaloMin - norm.total_amount) : regaloMin;

    out.regalo = {
      combo_matched: comboMatched,
      has_primary: hasPrimary,
      has_secondary: hasSecondary,
      min_amount: regaloMin,
      missing_amount: missing,
      reached: comboMatched && missing <= 0,
      gift_product_id: regaloGift || null,
      progress: comboMatched && regaloMin > 0 ? Math.max(0, Math.min(1, norm.total_amount / regaloMin)) : 0,
      target: {
        primary_product_id: regaloPrimary,
        secondary_product_id: regaloSecondary,
      },
    };
  }

  return out;
}

function buildEvaluateCacheKey(storeId, payload) {
  const norm = normalizeCartPayload(payload);
  const signature = JSON.stringify({
    total: norm.total_amount,
    items: norm.items.map((i) => [i.product_id, i.quantity, i.line_total]),
  });
  return `${storeId}:${signature}`;
}

async function evaluateAdvancedGoalsCached(storeId, payload) {
  const key = buildEvaluateCacheKey(storeId, payload);
  const now = Date.now();
  const cached = evaluateGoalsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await evaluateAdvancedGoals(storeId, payload);
  evaluateGoalsCache.set(key, { value, expiresAt: now + 4000 });
  return value;
}

app.get('/instalacion', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Missing required query param: code');
  }

  if (state) {
    const isStateValid = consumeOAuthState(String(state));
    if (!isStateValid && OAUTH_STATE_ENFORCE) {
      return res.status(400).send('Invalid oauth state');
    }
  } else if (OAUTH_STATE_ENFORCE) {
    return res.status(400).send('Missing oauth state');
  }

  try {
    const response = await axios.post('https://www.tiendanube.com/apps/authorize/token', {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }, { timeout: 10_000 });

    const { access_token: accessToken, user_id: userId } = response.data;

    await upsertStore(userId, accessToken);

    // Do not block installation redirect on script linking.
    // This avoids admin hangs when partner API is slow/intermittent.
    ensureStoreScript(userId, accessToken)
      .then((scriptResult) => {
        if (scriptResult.reason === 'auto_installed') {
          console.log(`[install] script ${SCRIPT_ID} is auto-installed; skipped manual association for store ${userId}`);
        } else if (scriptResult.linked) {
          console.log(`[install] script linked for store ${userId}`);
        }
      })
      .catch((scriptErr) => {
        const detail = scriptErr.response?.data || scriptErr.message;
        console.warn(`[install] script link failed for store ${userId}:`, detail);
      });

    const adminUrl = `https://admin.tiendanube.com/apps/${CLIENT_ID}/admin?store_id=${userId}`;
    // Top-level redirect to admin after install callback
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.redirect(302, adminUrl);
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error('[install] failed:', detail);
    return res.status(500).send('Installation failed. Check server logs.');
  }
});

app.get('/admin', async (req, res) => {
  const storeId = String(req.query.store_id || req.query.store || '');
  const safeStoreId = storeId.replace(/[^0-9]/g, '');
  const defaultConfig = {
    monto_envio_gratis: 50000,
    monto_cuotas: 80000,
    monto_regalo: 100000,
  };

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ProgressBar - Configuración</title>
    <style>
      :root {
        --bg-0: #eff4f8;
        --bg-1: #f8fbfd;
        --card: #ffffff;
        --line: #d7e2ee;
        --text: #102238;
        --muted: #5a6b7e;
        --brand: #0b6dfa;
        --brand-2: #2aa0ff;
        --ok: #0e9f6e;
        --warn: #db8a00;
        --gift: #b547db;
        --shadow: 0 18px 48px rgba(11, 32, 68, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        font-family: "Segoe UI", "Trebuchet MS", Arial, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 0 0, #d9ecff 0%, transparent 35%),
          radial-gradient(circle at 100% 0, #d7f4ef 0%, transparent 30%),
          linear-gradient(160deg, var(--bg-0), var(--bg-1));
      }
      .card {
        max-width: 820px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 24px;
        box-shadow: var(--shadow);
      }
      .hero {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }
      h1 {
        margin: 0;
        font-size: 27px;
        letter-spacing: 0.2px;
      }
      .subtitle {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 140px;
        height: 34px;
        border-radius: 999px;
        border: 1px solid #c8dcff;
        background: #ebf4ff;
        color: #0b4dba;
        font-size: 13px;
        font-weight: 700;
        padding: 0 12px;
      }
      .grid {
        display: grid;
        gap: 12px;
      }
      .settings-shell {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 12px;
        background: #f9fcff;
      }
      .tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .tab-btn {
        margin: 0;
        width: auto;
        height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid #cbd9ea;
        background: #fff;
        color: #28415e;
        font-size: 12px;
        text-transform: none;
        letter-spacing: 0;
      }
      .tab-btn.active {
        border-color: #8bb8ff;
        background: #eaf3ff;
        color: #0b4dba;
      }
      .tab-panel { display: none; }
      .tab-panel.active { display: grid; gap: 12px; }
      .goal {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 14px;
        background: #fcfeff;
      }
      .goal-title {
        display: flex;
        align-items: center;
        gap: 9px;
        margin: 0 0 8px;
        font-size: 14px;
        font-weight: 700;
      }
      .ico {
        width: 24px;
        height: 24px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 800;
        color: #fff;
      }
      .ico-envio { background: var(--ok); }
      .ico-cuotas { background: var(--warn); }
      .ico-regalo { background: var(--gift); }
      .goal-note {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 12px;
      }
      .search-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        border: 1px solid #d8e3ef;
        border-radius: 8px;
        padding: 8px;
        margin-top: 6px;
        background: #fff;
      }
      .search-item button {
        margin: 0;
        width: auto;
        height: 30px;
        padding: 0 10px;
        font-size: 12px;
        text-transform: none;
      }
      .search-actions {
        display: flex;
        gap: 6px;
      }
      input[type="number"],
      input[type="text"],
      select {
        width: 100%;
        height: 42px;
        border: 1px solid #c4d3e5;
        border-radius: 10px;
        padding: 0 12px;
        font-size: 15px;
        outline: none;
      }
      input[type="number"]:focus,
      input[type="text"]:focus,
      select:focus {
        border-color: #8bb8ff;
        box-shadow: 0 0 0 3px rgba(11, 109, 250, 0.12);
      }
      button {
        margin-top: 8px;
        width: 100%;
        height: 46px;
        border: 0;
        border-radius: 12px;
        background: linear-gradient(90deg, var(--brand), var(--brand-2));
        color: #fff;
        font-weight: 800;
        font-size: 14px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        cursor: pointer;
      }
      .meta {
        margin-top: 12px;
        color: var(--muted);
        font-size: 13px;
      }
      .error {
        margin-top: 12px;
        color: #b42318;
        font-size: 13px;
      }
      @media (max-width: 680px) {
        body { padding: 14px; }
        .card { padding: 16px; border-radius: 14px; }
        h1 { font-size: 23px; }
        .hero { flex-direction: column; align-items: flex-start; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="hero">
        <div>
          <h1>Panel de Objetivos</h1>
          <p class="subtitle">Define metas de carrito para aumentar conversion y ticket promedio.</p>
        </div>
        <span class="badge">ProgressBar Config</span>
      </div>

      <form action="/admin/save" method="POST" class="grid">
        <input type="hidden" name="store_id" id="storeId" value="${safeStoreId}" />
        <section class="settings-shell">
          <div class="tabs">
            <button type="button" class="tab-btn active" data-tab-target="tab-general">Configuracion General</button>
            <button type="button" class="tab-btn" data-tab-target="tab-cuotas">Cuotas</button>
            <button type="button" class="tab-btn" data-tab-target="tab-regalo">Regalo</button>
          </div>

          <div id="tab-general" class="tab-panel active">
            <div class="goal">
              <p class="goal-title"><span class="ico ico-envio">E</span> Envio Gratis</p>
              <p class="goal-note">Activa un incentivo inmediato de compra.</p>
              <input id="envio" type="number" min="0" name="envio" value="${Number(defaultConfig.monto_envio_gratis)}" required />
            </div>

            <div class="goal">
              <p class="goal-title"><span class="ico ico-cuotas">C</span> Cuotas Sin Interes</p>
              <p class="goal-note">Empuja productos de mayor valor por financiamiento.</p>
              <input id="cuotas" type="number" min="0" name="cuotas" value="${Number(defaultConfig.monto_cuotas)}" required />
            </div>

            <div class="goal">
              <p class="goal-title"><span class="ico ico-regalo">R</span> Regalo Sorpresa</p>
              <p class="goal-note">Ultimo gatillo para elevar el subtotal final.</p>
              <input id="regalo" type="number" min="0" name="regalo" value="${Number(defaultConfig.monto_regalo)}" required />
            </div>
          </div>

          <div id="tab-cuotas" class="tab-panel">
            <div class="goal">
              <p class="goal-title"><span class="ico ico-cuotas">C</span> Regla Avanzada de Cuotas</p>
              <p class="goal-note">Configura categoria o producto objetivo para cuotas.</p>
              <input id="cuotas_threshold_amount" type="number" min="0" name="cuotas_threshold_amount" placeholder="Monto objetivo para cuotas (ej: 50000)" />
              <input id="filter_cuotas_category" type="text" placeholder="Filtrar categorias..." />
              <select id="cuotas_category_id" name="cuotas_category_id">
                <option value="">Categoria objetivo (opcional)</option>
              </select>
              <input id="filter_cuotas_product" type="text" placeholder="Filtrar productos..." />
              <select id="cuotas_product_id" name="cuotas_product_id">
                <option value="">Producto objetivo (opcional, prioriza sobre categoria)</option>
              </select>
            </div>
          </div>

          <div id="tab-regalo" class="tab-panel">
            <div class="goal">
              <p class="goal-title"><span class="ico ico-regalo">R</span> Regla Avanzada de Regalo Combo</p>
              <p class="goal-note">Ejemplo: remera azul + pantalon azul + monto minimo para entregar regalo.</p>
              <input id="regalo_min_amount" type="number" min="0" name="regalo_min_amount" placeholder="Monto minimo carrito para regalo" />
              <input id="filter_regalo_primary" type="text" placeholder="Filtrar producto principal..." />
              <select id="regalo_primary_product_id" name="regalo_primary_product_id">
                <option value="">Producto principal (ej: remera azul)</option>
              </select>
              <input id="filter_regalo_secondary" type="text" placeholder="Filtrar producto secundario..." />
              <select id="regalo_secondary_product_id" name="regalo_secondary_product_id">
                <option value="">Producto secundario (ej: pantalon azul)</option>
              </select>
              <input id="filter_regalo_gift" type="text" placeholder="Filtrar producto regalo..." />
              <select id="regalo_gift_product_id" name="regalo_gift_product_id">
                <option value="">Producto regalo</option>
              </select>
            </div>
          </div>
        </section>

        <button type="submit">Guardar configuración</button>
      </form>

      <p class="meta">Store ID: <span id="storeLabel">${safeStoreId || 'pendiente'}</span></p>
      <p class="error" id="nexoError" style="display:none;"></p>
    </main>

    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin="anonymous"></script>
    <script>
      // Compatibility shims for UMD bundles that expect Node-like globals.
      window.global = window;
      window.process = window.process || { env: {} };
      window.react = window.React;
    </script>
    <script src="https://unpkg.com/@tiendanube/nexo@1.3.0/dist/index.js" crossorigin="anonymous"></script>
    <script>
      (async function initNexo() {
        const ACTION_CONNECTED = 'app/connected';
        const ACTION_READY = 'app/ready';
        const ACTION_STORE_INFO = 'app/store/info';
        const ADMIN_ALLOWED_ORIGINS = ${JSON.stringify(ADMIN_ALLOWED_ORIGINS)};

        const nexoError = document.getElementById('nexoError');
        const storeIdInput = document.getElementById('storeId');
        const storeIdLabel = document.getElementById('storeLabel');
        const envioInput = document.getElementById('envio');
        const cuotasInput = document.getElementById('cuotas');
        const regaloInput = document.getElementById('regalo');
        const cuotasThresholdAmountInput = document.getElementById('cuotas_threshold_amount');
        const cuotasCategoryIdInput = document.getElementById('cuotas_category_id');
        const cuotasProductIdInput = document.getElementById('cuotas_product_id');
        const filterCuotasCategoryInput = document.getElementById('filter_cuotas_category');
        const filterCuotasProductInput = document.getElementById('filter_cuotas_product');
        const regaloMinAmountInput = document.getElementById('regalo_min_amount');
        const regaloPrimaryProductIdInput = document.getElementById('regalo_primary_product_id');
        const regaloSecondaryProductIdInput = document.getElementById('regalo_secondary_product_id');
        const regaloGiftProductIdInput = document.getElementById('regalo_gift_product_id');
        const filterRegaloPrimaryInput = document.getElementById('filter_regalo_primary');
        const filterRegaloSecondaryInput = document.getElementById('filter_regalo_secondary');
        const filterRegaloGiftInput = document.getElementById('filter_regalo_gift');
        const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
        const tabPanels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
        const initialStoreId = '${safeStoreId}';
        const selectData = {
          products: [],
          categories: [],
        };

        function dispatch(type, payload) {
          if (window.parent && window.parent !== window) {
            ADMIN_ALLOWED_ORIGINS.forEach(function (origin) {
              window.parent.postMessage({ type: type, payload: payload }, origin);
            });
          }
        }

        function dispatchHandshake() {
          dispatch(ACTION_CONNECTED);
          dispatch(ACTION_READY);
        }

        function waitFor(type, timeoutMs) {
          return new Promise(function (resolve, reject) {
            const timeoutId = setTimeout(function () {
              window.removeEventListener('message', onMessage);
              reject(new Error(type + ' timeout'));
            }, timeoutMs);

            function onMessage(event) {
              if (!event || !ADMIN_ALLOWED_ORIGINS.includes(event.origin)) return;
              const data = event && event.data;
              if (!data || data.type !== type) return;
              clearTimeout(timeoutId);
              window.removeEventListener('message', onMessage);
              resolve(data.payload || {});
            }

            window.addEventListener('message', onMessage);
          });
        }

        function initTabs() {
          if (!tabButtons.length || !tabPanels.length) return;
          tabButtons.forEach(function (btn) {
            btn.addEventListener('click', function () {
              const target = btn.getAttribute('data-tab-target');
              tabButtons.forEach(function (b) { b.classList.remove('active'); });
              tabPanels.forEach(function (p) { p.classList.remove('active'); });
              btn.classList.add('active');
              const panel = document.getElementById(target);
              if (panel) panel.classList.add('active');
            });
          });
        }

        function fillSelect(selectEl, items, placeholder) {
          const current = String(selectEl.value || '');
          selectEl.innerHTML = '';
          const first = document.createElement('option');
          first.value = '';
          first.textContent = placeholder;
          selectEl.appendChild(first);

          (items || []).forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = String(item.id);
            opt.textContent = String(item.name || 'Sin nombre') + ' (#' + String(item.id) + ')';
            selectEl.appendChild(opt);
          });

          if (current) {
            selectEl.value = current;
          }
        }

        function filterItems(items, query) {
          const q = String(query || '').trim().toLowerCase();
          if (!q) return items.slice();
          return items.filter(function (item) {
            const label = String(item.name || '').toLowerCase();
            const id = String(item.id || '').toLowerCase();
            return label.includes(q) || id.includes(q);
          });
        }

        function refreshProductSelects() {
          fillSelect(
            cuotasProductIdInput,
            filterItems(selectData.products, filterCuotasProductInput.value),
            'Producto objetivo (opcional, prioriza sobre categoria)'
          );
          fillSelect(
            regaloPrimaryProductIdInput,
            filterItems(selectData.products, filterRegaloPrimaryInput.value),
            'Producto principal (ej: remera azul)'
          );
          fillSelect(
            regaloSecondaryProductIdInput,
            filterItems(selectData.products, filterRegaloSecondaryInput.value),
            'Producto secundario (ej: pantalon azul)'
          );
          fillSelect(
            regaloGiftProductIdInput,
            filterItems(selectData.products, filterRegaloGiftInput.value),
            'Producto regalo'
          );
        }

        function refreshCategorySelects() {
          fillSelect(
            cuotasCategoryIdInput,
            filterItems(selectData.categories, filterCuotasCategoryInput.value),
            'Categoria objetivo (opcional)'
          );
        }

        async function loadAllProducts(storeId) {
          const r = await fetch('/api/admin/products/' + encodeURIComponent(storeId) + '/all', { cache: 'no-store' });
          if (!r.ok) return [];
          const data = await r.json();
          return Array.isArray(data.items) ? data.items : [];
        }

        async function loadAllCategories(storeId) {
          const r = await fetch('/api/admin/categories/' + encodeURIComponent(storeId) + '/all', { cache: 'no-store' });
          if (!r.ok) return [];
          const data = await r.json();
          return Array.isArray(data.items) ? data.items : [];
        }

        try {
          initTabs();
          if (!window.parent || window.parent === window) {
            return;
          }

          const nexoLib = window['@tiendanube/nexo'];
          if (nexoLib && typeof nexoLib.create === 'function') {
            const nexo = nexoLib.create({ clientId: ${JSON.stringify(CLIENT_ID)}, log: false });
            await nexoLib.connect(nexo, 5000);
            nexoLib.iAmReady(nexo);

            try {
              const storeInfo = await nexoLib.getStoreInfo(nexo);
              if (storeInfo && storeInfo.id) {
                const detectedStoreId = String(storeInfo.id);
                storeIdInput.value = detectedStoreId;
                storeIdLabel.textContent = detectedStoreId;
              }
            } catch (_) {}
          } else {
            // Fallback: manual postMessage handshake if SDK is unavailable.
            dispatchHandshake();
            let attempts = 0;
            const retryTimer = setInterval(function () {
              attempts += 1;
              dispatchHandshake();
              if (attempts >= 20) clearInterval(retryTimer);
            }, 250);
            setTimeout(function () { clearInterval(retryTimer); }, 5000);
            waitFor(ACTION_CONNECTED, 5000).catch(function () {});

            try {
              const storeInfo = await (function () {
                const info = waitFor(ACTION_STORE_INFO, 3000);
                dispatch(ACTION_STORE_INFO);
                return info;
              })();
              if (storeInfo && storeInfo.id) {
                const detectedStoreId = String(storeInfo.id);
                storeIdInput.value = detectedStoreId;
                storeIdLabel.textContent = detectedStoreId;
              }
            } catch (_) {}
          }

          // Fetch persisted config asynchronously so admin page is never blocked by DB latency.
          const resolvedStoreId = storeIdInput.value || initialStoreId;
          if (resolvedStoreId) {
            try {
              const cfgRes = await fetch('/api/config/' + encodeURIComponent(resolvedStoreId), { cache: 'no-store' });
              if (cfgRes.ok) {
                const cfg = await cfgRes.json();
                if (cfg && cfg.monto_envio_gratis != null) envioInput.value = Number(cfg.monto_envio_gratis);
                if (cfg && cfg.monto_cuotas != null) cuotasInput.value = Number(cfg.monto_cuotas);
                if (cfg && cfg.monto_regalo != null) regaloInput.value = Number(cfg.monto_regalo);
                if (cfg && cfg.cuotas_threshold_amount != null) cuotasThresholdAmountInput.value = Number(cfg.cuotas_threshold_amount);
                if (cfg && cfg.cuotas_category_id != null) cuotasCategoryIdInput.value = String(cfg.cuotas_category_id || '');
                if (cfg && cfg.cuotas_product_id != null) cuotasProductIdInput.value = String(cfg.cuotas_product_id || '');
                if (cfg && cfg.regalo_min_amount != null) regaloMinAmountInput.value = Number(cfg.regalo_min_amount);
                if (cfg && cfg.regalo_primary_product_id != null) regaloPrimaryProductIdInput.value = String(cfg.regalo_primary_product_id || '');
                if (cfg && cfg.regalo_secondary_product_id != null) regaloSecondaryProductIdInput.value = String(cfg.regalo_secondary_product_id || '');
                if (cfg && cfg.regalo_gift_product_id != null) regaloGiftProductIdInput.value = String(cfg.regalo_gift_product_id || '');
              }
            } catch (_) {}

            try {
              const [products, categories] = await Promise.all([
                loadAllProducts(resolvedStoreId),
                loadAllCategories(resolvedStoreId),
              ]);
              selectData.products = products;
              selectData.categories = categories;
              refreshProductSelects();
              refreshCategorySelects();

              filterCuotasProductInput.addEventListener('input', refreshProductSelects);
              filterRegaloPrimaryInput.addEventListener('input', refreshProductSelects);
              filterRegaloSecondaryInput.addEventListener('input', refreshProductSelects);
              filterRegaloGiftInput.addEventListener('input', refreshProductSelects);
              filterCuotasCategoryInput.addEventListener('input', refreshCategorySelects);
            } catch (_) {}
          }
        } catch (err) {
          if (!initialStoreId) {
            console.error('[nexo] init error', err);
            nexoError.style.display = 'block';
            nexoError.textContent = 'No se pudo inicializar Nexo. Verifica la URL dentro del Admin de Tiendanube.';
          }
        }
      })();
    </script>
  </body>
</html>`);
});

app.post('/admin/save', async (req, res) => {
  const storeId = String(req.body.store_id || '').replace(/[^0-9]/g, '');
  const envio = Number(req.body.envio);
  const cuotas = Number(req.body.cuotas);
  const regalo = Number(req.body.regalo);
  const cuotasThresholdAmount = Number(req.body.cuotas_threshold_amount || 0);
  const cuotasCategoryId = String(req.body.cuotas_category_id || '').trim();
  const cuotasProductId = String(req.body.cuotas_product_id || '').trim();
  const regaloMinAmount = Number(req.body.regalo_min_amount || 0);
  const regaloPrimaryProductId = String(req.body.regalo_primary_product_id || '').trim();
  const regaloSecondaryProductId = String(req.body.regalo_secondary_product_id || '').trim();
  const regaloGiftProductId = String(req.body.regalo_gift_product_id || '').trim();

  if (!storeId) return res.status(400).send('Missing store_id');
  if ([envio, cuotas, regalo, cuotasThresholdAmount, regaloMinAmount].some((n) => Number.isNaN(n) || n < 0)) {
    return res.status(400).send('Invalid numeric values');
  }

  try {
    await ensureGoalSettingsTable();

    await pool.query(
      `UPDATE tiendas SET monto_envio_gratis = $1, monto_cuotas = $2, monto_regalo = $3 WHERE store_id = $4`,
      [envio, cuotas, regalo, storeId]
    );

    await pool.query(
      `INSERT INTO store_goal_settings (
         store_id,
         cuotas_threshold_amount,
         cuotas_category_id,
         cuotas_product_id,
         regalo_min_amount,
         regalo_primary_product_id,
         regalo_secondary_product_id,
         regalo_gift_product_id,
         updated_at
       )
       VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), CURRENT_TIMESTAMP)
       ON CONFLICT (store_id)
       DO UPDATE SET
         cuotas_threshold_amount = EXCLUDED.cuotas_threshold_amount,
         cuotas_category_id = EXCLUDED.cuotas_category_id,
         cuotas_product_id = EXCLUDED.cuotas_product_id,
         regalo_min_amount = EXCLUDED.regalo_min_amount,
         regalo_primary_product_id = EXCLUDED.regalo_primary_product_id,
         regalo_secondary_product_id = EXCLUDED.regalo_secondary_product_id,
         regalo_gift_product_id = EXCLUDED.regalo_gift_product_id,
         updated_at = CURRENT_TIMESTAMP`,
      [
        storeId,
        cuotasThresholdAmount,
        cuotasCategoryId,
        cuotasProductId,
        regaloMinAmount,
        regaloPrimaryProductId,
        regaloSecondaryProductId,
        regaloGiftProductId,
      ]
    );

    return res.redirect(302, `/admin?store_id=${storeId}`);
  } catch (error) {
    console.error('[admin/save] failed:', error.message);
    return res.status(500).send('Save failed');
  }
});

app.get('/api/config/:storeId', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    await ensureGoalSettingsTable();

    const result = await pool.query(
      `SELECT t.store_id,
              t.monto_envio_gratis,
              t.monto_cuotas,
              t.monto_regalo,
              s.cuotas_threshold_amount,
              s.cuotas_category_id,
              s.cuotas_product_id,
              s.regalo_min_amount,
              s.regalo_primary_product_id,
              s.regalo_secondary_product_id,
              s.regalo_gift_product_id
       FROM tiendas t
       LEFT JOIN store_goal_settings s ON s.store_id = t.store_id
       WHERE t.store_id = $1`,
      [storeId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Config not found' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/goals/:storeId/evaluate', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const result = await evaluateAdvancedGoalsCached(storeId, req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    console.error('[api/goals/evaluate] failed:', error.message);
    return res.status(500).json({ error: 'Failed to evaluate goals' });
  }
});

app.get('/api/admin/products/:storeId/all', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const accessToken = await getStoreAccessToken(storeId);
    if (!accessToken) return res.status(404).json({ error: 'Store token not found' });

    const headers = {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': APP_USER_AGENT,
      'Content-Type': 'application/json',
    };

    const pageSize = 200;
    const maxPages = 20;
    const all = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${apiStoreUrl(storeId, 'products')}?fields=id,name&page=${page}&per_page=${pageSize}`;
      const resp = await axios.get(url, { headers, timeout: 8000 });
      const raw = parseCollection(resp.data, ['products', 'items', 'data']);
      const list = raw.map((p) => ({ id: String(p.id), name: pickLocalizedName(p.name) }));
      all.push(...list);
      if (list.length < pageSize) break;
    }

    return res.status(200).json({ items: all });
  } catch (error) {
    const detail = error.response?.data || error.message;
    return res.status(500).json({ error: 'Load products failed', detail });
  }
});

app.get('/api/admin/categories/:storeId/all', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const accessToken = await getStoreAccessToken(storeId);
    if (!accessToken) return res.status(404).json({ error: 'Store token not found' });

    const headers = {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': APP_USER_AGENT,
      'Content-Type': 'application/json',
    };

    const pageSize = 200;
    const maxPages = 20;
    const all = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${apiStoreUrl(storeId, 'categories')}?fields=id,name&page=${page}&per_page=${pageSize}`;
      const resp = await axios.get(url, { headers, timeout: 8000 });
      const raw = parseCollection(resp.data, ['categories', 'items', 'data']);
      const list = raw.map((c) => ({ id: String(c.id), name: pickLocalizedName(c.name) }));
      all.push(...list);
      if (list.length < pageSize) break;
    }

    return res.status(200).json({ items: all });
  } catch (error) {
    const detail = error.response?.data || error.message;
    return res.status(500).json({ error: 'Load categories failed', detail });
  }
});

registerPortalRoutes(app, pool, { clientId: CLIENT_ID });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] running on port ${PORT}`);
});
