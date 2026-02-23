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

        <div class="goal">
          <p class="goal-title"><span class="ico ico-cuotas">C</span> Regla Avanzada de Cuotas</p>
          <p class="goal-note">Configura categoria o producto objetivo para cuotas.</p>
          <input id="cuotas_threshold_amount" type="number" min="0" name="cuotas_threshold_amount" placeholder="Monto objetivo para cuotas (ej: 50000)" />
          <input id="cuotas_category_id" type="text" name="cuotas_category_id" placeholder="ID categoria (ej: 123456)" />
          <input id="cuotas_product_id" type="text" name="cuotas_product_id" placeholder="ID producto (opcional, prioriza sobre categoria)" />
        </div>

        <div class="goal">
          <p class="goal-title"><span class="ico ico-regalo">R</span> Regla Avanzada de Regalo Combo</p>
          <p class="goal-note">Ejemplo: remera azul + pantalon azul + monto minimo para entregar regalo.</p>
          <input id="regalo_min_amount" type="number" min="0" name="regalo_min_amount" placeholder="Monto minimo carrito para regalo" />
          <input id="regalo_primary_product_id" type="text" name="regalo_primary_product_id" placeholder="ID producto principal (ej: remera azul)" />
          <input id="regalo_secondary_product_id" type="text" name="regalo_secondary_product_id" placeholder="ID producto secundario (ej: pantalon azul)" />
          <input id="regalo_gift_product_id" type="text" name="regalo_gift_product_id" placeholder="ID producto regalo" />
        </div>

        <div class="goal">
          <p class="goal-title"><span class="ico ico-cuotas">ID</span> Buscador de IDs</p>
          <p class="goal-note">Busca productos/categorias por nombre y selecciona su ID.</p>
          <select id="search_product_target">
            <option value="cuotas_product_id">Destino producto: Cuotas</option>
            <option value="regalo_primary_product_id">Destino producto: Regalo principal</option>
            <option value="regalo_secondary_product_id">Destino producto: Regalo secundario</option>
            <option value="regalo_gift_product_id">Destino producto: Producto regalo</option>
          </select>
          <input id="search_product_q" type="text" placeholder="Buscar producto (ej: pantalon azul)" />
          <div id="search_product_results" class="goal-note"></div>
          <select id="search_category_target">
            <option value="cuotas_category_id">Destino categoria: Cuotas</option>
          </select>
          <input id="search_category_q" type="text" placeholder="Buscar categoria (ej: pantalon)" />
          <div id="search_category_results" class="goal-note"></div>
        </div>

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
        const regaloMinAmountInput = document.getElementById('regalo_min_amount');
        const regaloPrimaryProductIdInput = document.getElementById('regalo_primary_product_id');
        const regaloSecondaryProductIdInput = document.getElementById('regalo_secondary_product_id');
        const regaloGiftProductIdInput = document.getElementById('regalo_gift_product_id');
        const searchProductQInput = document.getElementById('search_product_q');
        const searchProductResults = document.getElementById('search_product_results');
        const searchProductTargetInput = document.getElementById('search_product_target');
        const searchCategoryQInput = document.getElementById('search_category_q');
        const searchCategoryResults = document.getElementById('search_category_results');
        const searchCategoryTargetInput = document.getElementById('search_category_target');
        const initialStoreId = '${safeStoreId}';

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

        function debounce(fn, delay) {
          let t = null;
          return function () {
            const args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(null, args); }, delay);
          };
        }

        async function copyToClipboard(text) {
          try {
            await navigator.clipboard.writeText(String(text));
          } catch (_) {}
        }

        function renderSearchResults(container, items, onPick) {
          container.innerHTML = '';
          if (!Array.isArray(items) || !items.length) {
            container.textContent = 'Sin resultados';
            return;
          }
          items.forEach(function (item) {
            const row = document.createElement('div');
            row.className = 'search-item';
            row.innerHTML = '<span>' + String(item.name || 'Sin nombre') + ' <strong>#' + String(item.id) + '</strong></span><div class=\"search-actions\"><button type=\"button\" class=\"btn-use\">Usar</button><button type=\"button\" class=\"btn-copy\">Copiar</button></div>';
            row.querySelector('.btn-use').addEventListener('click', function () {
              onPick(item);
            });
            row.querySelector('.btn-copy').addEventListener('click', function () {
              copyToClipboard(item.id);
            });
            container.appendChild(row);
          });
        }

        async function searchProducts(storeId, q) {
          if (!storeId || !q) {
            searchProductResults.textContent = '';
            return;
          }
          const r = await fetch('/api/admin/products/' + encodeURIComponent(storeId) + '/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
          if (!r.ok) return;
          const data = await r.json();
          renderSearchResults(searchProductResults, data.items || [], function (item) {
            const target = String(searchProductTargetInput.value || 'cuotas_product_id');
            if (target === 'cuotas_product_id') cuotasProductIdInput.value = String(item.id);
            else if (target === 'regalo_primary_product_id') regaloPrimaryProductIdInput.value = String(item.id);
            else if (target === 'regalo_secondary_product_id') regaloSecondaryProductIdInput.value = String(item.id);
            else if (target === 'regalo_gift_product_id') regaloGiftProductIdInput.value = String(item.id);
          });
        }

        async function searchCategories(storeId, q) {
          if (!storeId || !q) {
            searchCategoryResults.textContent = '';
            return;
          }
          const r = await fetch('/api/admin/categories/' + encodeURIComponent(storeId) + '/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
          if (!r.ok) return;
          const data = await r.json();
          renderSearchResults(searchCategoryResults, data.items || [], function (item) {
            const target = String(searchCategoryTargetInput.value || 'cuotas_category_id');
            if (target === 'cuotas_category_id') cuotasCategoryIdInput.value = String(item.id);
          });
        }

        try {
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

            const debouncedProductSearch = debounce(function (value) {
              searchProducts(resolvedStoreId, value).catch(function () {});
            }, 300);
            const debouncedCategorySearch = debounce(function (value) {
              searchCategories(resolvedStoreId, value).catch(function () {});
            }, 300);

            searchProductQInput.addEventListener('input', function () {
              debouncedProductSearch(searchProductQInput.value.trim());
            });
            searchCategoryQInput.addEventListener('input', function () {
              debouncedCategorySearch(searchCategoryQInput.value.trim());
            });
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
    return res.status(500).send('Save failed');
  }
});

app.get('/api/config/:storeId', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
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

app.get('/api/admin/products/:storeId/search', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = Math.min(50, Math.max(1, Number(req.query.per_page || 30)));
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const accessToken = await getStoreAccessToken(storeId);
    if (!accessToken) return res.status(404).json({ error: 'Store token not found' });

    const headers = {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': APP_USER_AGENT,
      'Content-Type': 'application/json',
    };

    const url = `${apiStoreUrl(storeId, 'products')}?fields=id,name&page=${page}&per_page=${perPage}`;
    const resp = await axios.get(url, { headers, timeout: 8000 });
    const raw = parseCollection(resp.data, ['products', 'items', 'data']);

    const items = raw
      .map((p) => ({ id: String(p.id), name: pickLocalizedName(p.name) }))
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .slice(0, 20);

    return res.status(200).json({ items, page, per_page: perPage });
  } catch (error) {
    const detail = error.response?.data || error.message;
    return res.status(500).json({ error: 'Search products failed', detail });
  }
});

app.get('/api/admin/categories/:storeId/search', async (req, res) => {
  const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = Math.min(200, Math.max(1, Number(req.query.per_page || 100)));
  if (!storeId) return res.status(400).json({ error: 'Invalid store id' });

  try {
    const accessToken = await getStoreAccessToken(storeId);
    if (!accessToken) return res.status(404).json({ error: 'Store token not found' });

    const headers = {
      Authentication: `bearer ${accessToken}`,
      'User-Agent': APP_USER_AGENT,
      'Content-Type': 'application/json',
    };

    const url = `${apiStoreUrl(storeId, 'categories')}?fields=id,name&page=${page}&per_page=${perPage}`;
    const resp = await axios.get(url, { headers, timeout: 8000 });
    const raw = parseCollection(resp.data, ['categories', 'items', 'data']);

    const items = raw
      .map((c) => ({ id: String(c.id), name: pickLocalizedName(c.name) }))
      .filter((c) => (q ? c.name.toLowerCase().includes(q) : true))
      .slice(0, 20);

    return res.status(200).json({ items, page, per_page: perPage });
  } catch (error) {
    const detail = error.response?.data || error.message;
    return res.status(500).json({ error: 'Search categories failed', detail });
  }
});

registerPortalRoutes(app, pool, { clientId: CLIENT_ID });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] running on port ${PORT}`);
});
