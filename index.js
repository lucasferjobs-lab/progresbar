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
app.use('/static', express.static(path.join(__dirname), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}storefront${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
app.get('/barra.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.sendFile(path.join(__dirname, 'barra.js'));
});
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
      enable_envio_rule BOOLEAN DEFAULT TRUE,
      enable_cuotas_rule BOOLEAN DEFAULT TRUE,
      enable_regalo_rule BOOLEAN DEFAULT TRUE,
      envio_min_amount DECIMAL DEFAULT 0,
      envio_scope VARCHAR(20) DEFAULT 'all',
      envio_category_id VARCHAR(255),
      envio_product_id VARCHAR(255),
      envio_bar_color VARCHAR(32),
      envio_text VARCHAR(255),
      envio_text_prefix VARCHAR(255),
      envio_text_suffix VARCHAR(255),
      envio_text_reached VARCHAR(255),
      cuotas_threshold_amount DECIMAL DEFAULT 0,
      cuotas_scope VARCHAR(20) DEFAULT 'all',
      cuotas_category_id VARCHAR(255),
      cuotas_product_id VARCHAR(255),
      cuotas_bar_color VARCHAR(32),
      cuotas_text VARCHAR(255),
      cuotas_text_prefix VARCHAR(255),
      cuotas_text_suffix VARCHAR(255),
      cuotas_text_reached VARCHAR(255),
      regalo_min_amount DECIMAL DEFAULT 0,
      regalo_mode VARCHAR(32) DEFAULT 'combo_products',
      regalo_primary_product_id VARCHAR(255),
      regalo_secondary_product_id VARCHAR(255),
      regalo_target_type VARCHAR(32) DEFAULT 'same_product_qty',
      regalo_target_qty INTEGER DEFAULT 0,
      regalo_target_product_id VARCHAR(255),
      regalo_target_category_id VARCHAR(255),
      regalo_gift_product_id VARCHAR(255),
      regalo_bar_color VARCHAR(32),
      regalo_text VARCHAR(255),
      regalo_text_prefix VARCHAR(255),
      regalo_text_suffix VARCHAR(255),
      regalo_text_reached VARCHAR(255),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS enable_envio_rule BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS enable_cuotas_rule BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS enable_regalo_rule BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_min_amount DECIMAL DEFAULT 0;`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_scope VARCHAR(20) DEFAULT 'all';`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_category_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_product_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_bar_color VARCHAR(32);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_text VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_text_prefix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_text_suffix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS envio_text_reached VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_scope VARCHAR(20) DEFAULT 'all';`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_bar_color VARCHAR(32);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_text VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_text_prefix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_text_suffix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS cuotas_text_reached VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_mode VARCHAR(32) DEFAULT 'combo_products';`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_target_type VARCHAR(32) DEFAULT 'same_product_qty';`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_target_qty INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_target_product_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_target_category_id VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_bar_color VARCHAR(32);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_text VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_text_prefix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_text_suffix VARCHAR(255);`);
  await pool.query(`ALTER TABLE store_goal_settings ADD COLUMN IF NOT EXISTS regalo_text_reached VARCHAR(255);`);

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
    return { envio: null, cuotas: null, regalo: null, cart_total: norm.total_amount };
  }

  const accessToken = settings.access_token;
  const out = { envio: null, cuotas: null, regalo: null, cart_total: norm.total_amount };
  async function itemMatchesScope(item, scope, productId, categoryId) {
    if (scope === 'all') return true;
    if (scope === 'product') return productId && item.product_id === productId;
    if (scope === 'category') {
      if (!categoryId) return false;
      const localCats = item.categories || [];
      if (localCats.includes(categoryId)) return true;
      if (!accessToken) return false;
      try {
        const remoteCats = await fetchProductCategories(storeId, accessToken, item.product_id);
        return remoteCats.includes(categoryId);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  async function evaluateAmountRule(ruleType) {
    const enabled = settings[`enable_${ruleType}_rule`] !== false;
    const thresholdField = ruleType === 'envio' ? 'envio_min_amount' : 'cuotas_threshold_amount';
    const scope = String(settings[`${ruleType}_scope`] || 'all').trim();
    const productId = String(settings[`${ruleType}_product_id`] || '').trim();
    const categoryId = String(settings[`${ruleType}_category_id`] || '').trim();
    const barColor = String(settings[`${ruleType}_bar_color`] || '').trim();
    const text = String(settings[`${ruleType}_text`] || '').trim();
    const textPrefix = String(settings[`${ruleType}_text_prefix`] || '').trim();
    const textSuffix = String(settings[`${ruleType}_text_suffix`] || '').trim();
    const textReached = String(settings[`${ruleType}_text_reached`] || '').trim();
    const threshold = toNumberOrNull(settings[thresholdField]) || 0;

    if (!enabled || threshold <= 0) return null;

    let eligibleSubtotal = 0;
    let hasMatch = scope === 'all';

    for (const item of norm.items) {
      // eslint-disable-next-line no-await-in-loop
      const matches = await itemMatchesScope(item, scope, productId, categoryId);
      if (!matches) continue;
      hasMatch = true;
      eligibleSubtotal += toNumberOrNull(item.line_total) || 0;
    }

    const missing = Math.max(0, threshold - eligibleSubtotal);
    return {
      enabled: true,
      has_match: hasMatch,
      scope,
      threshold_amount: threshold,
      eligible_subtotal: eligibleSubtotal,
      missing_amount: missing,
      reached: hasMatch && missing <= 0,
      progress: threshold > 0 ? Math.max(0, Math.min(1, eligibleSubtotal / threshold)) : 0,
      target: {
        category_id: categoryId || null,
        product_id: productId || null,
      },
      bar_color: barColor || null,
      text: text || null,
      text_prefix: textPrefix || null,
      text_suffix: textSuffix || null,
      text_reached: textReached || null,
    };
  }

  out.envio = await evaluateAmountRule('envio');
  out.cuotas = await evaluateAmountRule('cuotas');

  const regaloEnabled = settings.enable_regalo_rule !== false;
  const regaloMode = String(settings.regalo_mode || 'combo_products').trim();
  const regaloText = String(settings.regalo_text || '').trim();
  const regaloTextPrefix = String(settings.regalo_text_prefix || '').trim();
  const regaloTextSuffix = String(settings.regalo_text_suffix || '').trim();
  const regaloTextReached = String(settings.regalo_text_reached || '').trim();
  const regaloBarColor = String(settings.regalo_bar_color || '').trim();
  const regaloGift = String(settings.regalo_gift_product_id || '').trim();
  const regaloMin = Math.max(0, toNumberOrNull(settings.regalo_min_amount) || 0);

  if (regaloEnabled) {
    if (regaloMode === 'combo_products') {
      const regaloPrimary = String(settings.regalo_primary_product_id || '').trim();
      const regaloSecondary = String(settings.regalo_secondary_product_id || '').trim();
      const hasPrimary = !!regaloPrimary && norm.items.some((i) => i.product_id === regaloPrimary);
      const hasSecondary = !!regaloSecondary && norm.items.some((i) => i.product_id === regaloSecondary);
      const comboMatched = hasPrimary && hasSecondary;
      const missing = comboMatched ? Math.max(0, regaloMin - norm.total_amount) : regaloMin;
      out.regalo = {
        enabled: true,
        mode: 'combo_products',
        combo_matched: comboMatched,
        has_primary: hasPrimary,
        has_secondary: hasSecondary,
        min_amount: regaloMin,
        missing_amount: missing,
        reached: comboMatched && missing <= 0,
        gift_product_id: regaloGift || null,
        progress: comboMatched && regaloMin > 0 ? Math.max(0, Math.min(1, norm.total_amount / regaloMin)) : (comboMatched ? 1 : 0),
        target: {
          primary_product_id: regaloPrimary || null,
          secondary_product_id: regaloSecondary || null,
        },
        bar_color: regaloBarColor || null,
        text: regaloText || null,
        text_prefix: regaloTextPrefix || null,
        text_suffix: regaloTextSuffix || null,
        text_reached: regaloTextReached || null,
      };
    } else {
      const targetType = String(settings.regalo_target_type || 'same_product_qty').trim();
      const targetQty = Math.max(0, Number(settings.regalo_target_qty || 0));
      const targetProductId = String(settings.regalo_target_product_id || '').trim();
      const targetCategoryId = String(settings.regalo_target_category_id || '').trim();

      let eligibleQty = 0;
      for (const item of norm.items) {
        let matches = false;
        if (targetType === 'same_product_qty') {
          matches = !!targetProductId && item.product_id === targetProductId;
        } else if (targetType === 'category_qty') {
          // eslint-disable-next-line no-await-in-loop
          matches = await itemMatchesScope(item, 'category', '', targetCategoryId);
        }
        if (matches) eligibleQty += Math.max(0, Number(item.quantity || 0));
      }

      const qtyReached = targetQty > 0 ? eligibleQty >= targetQty : false;
      const amountMissing = Math.max(0, regaloMin - norm.total_amount);
      const missingQty = Math.max(0, targetQty - eligibleQty);
      const reached = qtyReached && amountMissing <= 0;
      const progressQty = targetQty > 0 ? Math.max(0, Math.min(1, eligibleQty / targetQty)) : 0;
      const progressAmount = regaloMin > 0 ? Math.max(0, Math.min(1, norm.total_amount / regaloMin)) : 1;

      out.regalo = {
        enabled: true,
        mode: 'target_rule',
        target_type: targetType,
        target_qty: targetQty,
        eligible_qty: eligibleQty,
        missing_qty: missingQty,
        min_amount: regaloMin,
        missing_amount: amountMissing,
        reached,
        gift_product_id: regaloGift || null,
        progress: Math.min(progressQty, progressAmount),
        target: {
          product_id: targetProductId || null,
          category_id: targetCategoryId || null,
        },
        bar_color: regaloBarColor || null,
        text: regaloText || null,
        text_prefix: regaloTextPrefix || null,
        text_suffix: regaloTextSuffix || null,
        text_reached: regaloTextReached || null,
      };
    }
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

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.status(200).send(`<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ProgressBar - Configuracion</title>
    <style>
      :root {
        --bg: #eef3fb;
        --card: #ffffff;
        --text: #0f172a;
        --muted: #475467;
        --line: #d0ddf0;
        --brand: #2563eb;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 20px 12px;
        font-family: "Segoe UI", Arial, sans-serif;
        background: radial-gradient(circle at top left, #ffffff, var(--bg));
        color: var(--text);
      }
      .card {
        width: min(900px, 100%);
        margin: 0 auto;
        background: var(--card);
        border: 1px solid #d9e4f5;
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 10px 28px rgba(9, 30, 66, 0.08);
      }
      h1 { margin: 0 0 12px; font-size: 30px; }
      .settings-shell { border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
      .tabs { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
      .tab-btn {
        border: 1px solid #b7ccef;
        background: #f6f9ff;
        color: #1e293b;
        border-radius: 999px;
        padding: 8px 14px;
        font-weight: 600;
        cursor: pointer;
        width: auto;
        height: auto;
        text-transform: none;
        letter-spacing: 0;
        margin: 0;
      }
      .tab-btn.active { background: #e6efff; border-color: #7aa7ff; color: #0b3d91; }
      .tab-panel { display: none; border: 1px solid #d5e2f5; border-radius: 10px; padding: 12px 10px; }
      .tab-panel.active { display: block; }
      .group { display: grid; gap: 6px; }
      .row { display: grid; gap: 6px; }
      .row label, .inline label { font-size: 14px; font-weight: 600; }
      .inline { display: flex; align-items: center; gap: 8px; }
      input[type="number"], input[type="text"], select {
        width: 100%;
        height: 40px;
        border: 1px solid #c4d3e5;
        border-radius: 8px;
        padding: 0 12px;
        font-size: 14px;
        outline: none;
      }
      input[type="color"] {
        width: 100%;
        height: 40px;
        border: 1px solid #c4d3e5;
        border-radius: 8px;
        background: #fff;
      }
      input[type="number"]:focus, input[type="text"]:focus, select:focus {
        border-color: #8bb8ff;
        box-shadow: 0 0 0 3px rgba(11, 109, 250, 0.12);
      }
      button {
        margin-top: 10px;
        width: 100%;
        height: 44px;
        border: 0;
        border-radius: 10px;
        background: var(--brand);
        color: #fff;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.2px;
        text-transform: uppercase;
        cursor: pointer;
      }
      .meta { margin-top: 12px; color: var(--muted); font-size: 13px; }
      .error { margin-top: 12px; color: #b42318; font-size: 13px; }
      .hidden { display: none; }
      @media (max-width: 680px) {
        body { padding: 12px; }
        .card { padding: 14px; border-radius: 12px; }
        h1 { font-size: 24px; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Panel de Configuracion</h1>

      <form action="/admin/save" method="POST">
        <input type="hidden" name="store_id" id="storeId" value="${safeStoreId}" />

        <section class="settings-shell">
          <div class="tabs">
            <button type="button" class="tab-btn active" data-tab-target="tab-envio">Envio Gratis</button>
            <button type="button" class="tab-btn" data-tab-target="tab-cuotas">Cuotas</button>
            <button type="button" class="tab-btn" data-tab-target="tab-regalo">Regalo</button>
          </div>

          <div id="tab-envio" class="tab-panel active">
            <div class="group">
              <div class="inline">
                <input id="enable_envio_rule" type="checkbox" name="enable_envio_rule" value="1" checked />
                <label for="enable_envio_rule">Activar</label>
              </div>
              <div class="row">
                <label for="envio_min_amount">Desde X monto</label>
                <input id="envio_min_amount" type="number" min="0" name="envio_min_amount" value="50000" />
              </div>
              <div class="row">
                <label for="envio_scope">Aplica a</label>
                <select id="envio_scope" name="envio_scope">
                  <option value="all">Todo el carrito</option>
                  <option value="product">Producto</option>
                  <option value="category">Categoria</option>
                </select>
              </div>
              <div class="row hidden" id="envio_product_wrap">
                <label for="envio_product_id">Producto</label>
                <select id="envio_product_id" name="envio_product_id"><option value="">Seleccionar</option></select>
              </div>
              <div class="row hidden" id="envio_category_wrap">
                <label for="envio_category_id">Categoria</label>
                <select id="envio_category_id" name="envio_category_id"><option value="">Seleccionar</option></select>
              </div>
              <div class="row">
                <label for="envio_text_prefix">Texto inicial</label>
                <input id="envio_text_prefix" type="text" name="envio_text_prefix" />
              </div>
              <div class="row">
                <label for="envio_text_suffix">Texto final</label>
                <input id="envio_text_suffix" type="text" name="envio_text_suffix" />
              </div>
              <div class="row">
                <label for="envio_text_reached">Texto al alcanzar</label>
                <input id="envio_text_reached" type="text" name="envio_text_reached" />
              </div>
              <div class="row">
                <label for="envio_bar_color">Color barra</label>
                <input id="envio_bar_color" type="color" name="envio_bar_color" value="#2563eb" />
              </div>
            </div>
          </div>

          <div id="tab-cuotas" class="tab-panel">
            <div class="group">
              <div class="inline">
                <input id="enable_cuotas_rule" type="checkbox" name="enable_cuotas_rule" value="1" checked />
                <label for="enable_cuotas_rule">Activar</label>
              </div>
              <div class="row">
                <label for="cuotas_threshold_amount">Desde X monto</label>
                <input id="cuotas_threshold_amount" type="number" min="0" name="cuotas_threshold_amount" value="80000" />
              </div>
              <div class="row">
                <label for="cuotas_scope">Aplica a</label>
                <select id="cuotas_scope" name="cuotas_scope">
                  <option value="all">Todo el carrito</option>
                  <option value="product">Producto</option>
                  <option value="category">Categoria</option>
                </select>
              </div>
              <div class="row hidden" id="cuotas_product_wrap">
                <label for="cuotas_product_id">Producto</label>
                <select id="cuotas_product_id" name="cuotas_product_id"><option value="">Seleccionar</option></select>
              </div>
              <div class="row hidden" id="cuotas_category_wrap">
                <label for="cuotas_category_id">Categoria</label>
                <select id="cuotas_category_id" name="cuotas_category_id"><option value="">Seleccionar</option></select>
              </div>
              <div class="row">
                <label for="cuotas_text_prefix">Texto inicial</label>
                <input id="cuotas_text_prefix" type="text" name="cuotas_text_prefix" />
              </div>
              <div class="row">
                <label for="cuotas_text_suffix">Texto final</label>
                <input id="cuotas_text_suffix" type="text" name="cuotas_text_suffix" />
              </div>
              <div class="row">
                <label for="cuotas_text_reached">Texto al alcanzar</label>
                <input id="cuotas_text_reached" type="text" name="cuotas_text_reached" />
              </div>
              <div class="row">
                <label for="cuotas_bar_color">Color barra</label>
                <input id="cuotas_bar_color" type="color" name="cuotas_bar_color" value="#0ea5e9" />
              </div>
            </div>
          </div>

          <div id="tab-regalo" class="tab-panel">
            <div class="group">
              <div class="inline">
                <input id="enable_regalo_rule" type="checkbox" name="enable_regalo_rule" value="1" checked />
                <label for="enable_regalo_rule">Activar</label>
              </div>
              <div class="row">
                <label for="regalo_mode">Modo</label>
                <select id="regalo_mode" name="regalo_mode">
                  <option value="combo_products">Productos juntos</option>
                  <option value="target_rule">Cantidad o categoria</option>
                </select>
              </div>
              <div class="row">
                <label for="regalo_min_amount">Desde X monto</label>
                <input id="regalo_min_amount" type="number" min="0" name="regalo_min_amount" value="100000" />
              </div>

              <div id="regalo_combo_fields">
                <div class="row">
                  <label for="regalo_primary_product_id">Producto 1</label>
                  <select id="regalo_primary_product_id" name="regalo_primary_product_id"><option value="">Seleccionar</option></select>
                </div>
                <div class="row">
                  <label for="regalo_secondary_product_id">Producto 2</label>
                  <select id="regalo_secondary_product_id" name="regalo_secondary_product_id"><option value="">Seleccionar</option></select>
                </div>
              </div>

              <div id="regalo_target_fields" class="hidden">
                <div class="row">
                  <label for="regalo_target_type">Condicion</label>
                  <select id="regalo_target_type" name="regalo_target_type">
                    <option value="same_product_qty">Cantidad de producto</option>
                    <option value="category_qty">Cantidad en categoria</option>
                  </select>
                </div>
                <div class="row">
                  <label for="regalo_target_qty">Cantidad objetivo</label>
                  <input id="regalo_target_qty" type="number" min="0" name="regalo_target_qty" value="0" />
                </div>
                <div class="row" id="regalo_target_product_wrap">
                  <label for="regalo_target_product_id">Producto objetivo</label>
                  <select id="regalo_target_product_id" name="regalo_target_product_id"><option value="">Seleccionar</option></select>
                </div>
                <div class="row hidden" id="regalo_target_category_wrap">
                  <label for="regalo_target_category_id">Categoria objetivo</label>
                  <select id="regalo_target_category_id" name="regalo_target_category_id"><option value="">Seleccionar</option></select>
                </div>
              </div>

              <div class="row">
                <label for="regalo_gift_product_id">Producto regalo</label>
                <select id="regalo_gift_product_id" name="regalo_gift_product_id"><option value="">Seleccionar</option></select>
              </div>
              <div class="row">
                <label for="regalo_text_prefix">Texto inicial</label>
                <input id="regalo_text_prefix" type="text" name="regalo_text_prefix" />
              </div>
              <div class="row">
                <label for="regalo_text_suffix">Texto final</label>
                <input id="regalo_text_suffix" type="text" name="regalo_text_suffix" />
              </div>
              <div class="row">
                <label for="regalo_text_reached">Texto al alcanzar</label>
                <input id="regalo_text_reached" type="text" name="regalo_text_reached" />
              </div>
              <div class="row">
                <label for="regalo_bar_color">Color barra</label>
                <input id="regalo_bar_color" type="color" name="regalo_bar_color" value="#a855f7" />
              </div>
            </div>
          </div>
        </section>

        <button type="submit">Guardar configuracion</button>
      </form>

      <p class="meta">Store ID: <span id="storeLabel">${safeStoreId || 'pendiente'}</span></p>
      <p class="error" id="nexoError" style="display:none;"></p>
    </main>

    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin="anonymous"></script>
    <script>
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
        const initialStoreId = '${safeStoreId}';
        const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
        const tabPanels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));

        const envioScopeInput = document.getElementById('envio_scope');
        const envioProductWrap = document.getElementById('envio_product_wrap');
        const envioCategoryWrap = document.getElementById('envio_category_wrap');
        const cuotasScopeInput = document.getElementById('cuotas_scope');
        const cuotasProductWrap = document.getElementById('cuotas_product_wrap');
        const cuotasCategoryWrap = document.getElementById('cuotas_category_wrap');
        const regaloModeInput = document.getElementById('regalo_mode');
        const regaloTargetTypeInput = document.getElementById('regalo_target_type');
        const regaloComboFields = document.getElementById('regalo_combo_fields');
        const regaloTargetFields = document.getElementById('regalo_target_fields');
        const regaloTargetProductWrap = document.getElementById('regalo_target_product_wrap');
        const regaloTargetCategoryWrap = document.getElementById('regalo_target_category_wrap');

        const selectData = { products: [], categories: [] };
        const preselected = {};

        function toggleScope(scope, productWrap, categoryWrap) {
          productWrap.classList.toggle('hidden', scope !== 'product');
          categoryWrap.classList.toggle('hidden', scope !== 'category');
        }

        function toggleRegaloMode() {
          const mode = regaloModeInput.value;
          const isCombo = mode === 'combo_products';
          regaloComboFields.classList.toggle('hidden', !isCombo);
          regaloTargetFields.classList.toggle('hidden', isCombo);
          toggleRegaloTargetType();
        }

        function toggleRegaloTargetType() {
          const type = regaloTargetTypeInput.value;
          regaloTargetProductWrap.classList.toggle('hidden', type !== 'same_product_qty');
          regaloTargetCategoryWrap.classList.toggle('hidden', type !== 'category_qty');
        }

        function initTabs() {
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

        function fillSelect(selectEl, items) {
          const current = String(selectEl.value || '');
          selectEl.innerHTML = '<option value="">Seleccionar</option>';
          (items || []).forEach(function (item) {
            const opt = document.createElement('option');
            opt.value = String(item.id);
            opt.textContent = String(item.name || 'Sin nombre') + ' (#' + String(item.id) + ')';
            selectEl.appendChild(opt);
          });
          if (current) selectEl.value = current;
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

        try {
          initTabs();
          toggleScope(envioScopeInput.value, envioProductWrap, envioCategoryWrap);
          toggleScope(cuotasScopeInput.value, cuotasProductWrap, cuotasCategoryWrap);
          toggleRegaloMode();
          envioScopeInput.addEventListener('change', function () { toggleScope(envioScopeInput.value, envioProductWrap, envioCategoryWrap); });
          cuotasScopeInput.addEventListener('change', function () { toggleScope(cuotasScopeInput.value, cuotasProductWrap, cuotasCategoryWrap); });
          regaloModeInput.addEventListener('change', toggleRegaloMode);
          regaloTargetTypeInput.addEventListener('change', toggleRegaloTargetType);

          if (window.parent && window.parent !== window) {
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
              dispatchHandshake();
              waitFor(ACTION_CONNECTED, 3500).catch(function () {});
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
          }

          const resolvedStoreId = storeIdInput.value || initialStoreId;
          if (!resolvedStoreId) return;

          try {
            const cfgRes = await fetch('/api/config/' + encodeURIComponent(resolvedStoreId), { cache: 'no-store' });
            if (cfgRes.ok) {
              const cfg = await cfgRes.json();
              if (cfg.enable_envio_rule != null) document.getElementById('enable_envio_rule').checked = !!cfg.enable_envio_rule;
              if (cfg.enable_cuotas_rule != null) document.getElementById('enable_cuotas_rule').checked = !!cfg.enable_cuotas_rule;
              if (cfg.enable_regalo_rule != null) document.getElementById('enable_regalo_rule').checked = !!cfg.enable_regalo_rule;
              if (cfg.envio_min_amount != null) document.getElementById('envio_min_amount').value = Number(cfg.envio_min_amount);
              if (cfg.envio_scope) document.getElementById('envio_scope').value = String(cfg.envio_scope);
              if (cfg.envio_text_prefix != null) document.getElementById('envio_text_prefix').value = String(cfg.envio_text_prefix || '');
              if (cfg.envio_text_suffix != null) document.getElementById('envio_text_suffix').value = String(cfg.envio_text_suffix || '');
              if (cfg.envio_text_reached != null) document.getElementById('envio_text_reached').value = String(cfg.envio_text_reached || '');
              if (cfg.envio_bar_color) document.getElementById('envio_bar_color').value = String(cfg.envio_bar_color);
              if (cfg.cuotas_threshold_amount != null) document.getElementById('cuotas_threshold_amount').value = Number(cfg.cuotas_threshold_amount);
              if (cfg.cuotas_scope) document.getElementById('cuotas_scope').value = String(cfg.cuotas_scope);
              if (cfg.cuotas_text_prefix != null) document.getElementById('cuotas_text_prefix').value = String(cfg.cuotas_text_prefix || '');
              if (cfg.cuotas_text_suffix != null) document.getElementById('cuotas_text_suffix').value = String(cfg.cuotas_text_suffix || '');
              if (cfg.cuotas_text_reached != null) document.getElementById('cuotas_text_reached').value = String(cfg.cuotas_text_reached || '');
              if (cfg.cuotas_bar_color) document.getElementById('cuotas_bar_color').value = String(cfg.cuotas_bar_color);
              if (cfg.regalo_mode) document.getElementById('regalo_mode').value = String(cfg.regalo_mode);
              if (cfg.regalo_min_amount != null) document.getElementById('regalo_min_amount').value = Number(cfg.regalo_min_amount);
              if (cfg.regalo_target_type) document.getElementById('regalo_target_type').value = String(cfg.regalo_target_type);
              if (cfg.regalo_target_qty != null) document.getElementById('regalo_target_qty').value = Number(cfg.regalo_target_qty);
              if (cfg.regalo_text_prefix != null) document.getElementById('regalo_text_prefix').value = String(cfg.regalo_text_prefix || '');
              if (cfg.regalo_text_suffix != null) document.getElementById('regalo_text_suffix').value = String(cfg.regalo_text_suffix || '');
              if (cfg.regalo_text_reached != null) document.getElementById('regalo_text_reached').value = String(cfg.regalo_text_reached || '');
              if (cfg.regalo_bar_color) document.getElementById('regalo_bar_color').value = String(cfg.regalo_bar_color);

              preselected.envio_category_id = String(cfg.envio_category_id || '');
              preselected.envio_product_id = String(cfg.envio_product_id || '');
              preselected.cuotas_category_id = String(cfg.cuotas_category_id || '');
              preselected.cuotas_product_id = String(cfg.cuotas_product_id || '');
              preselected.regalo_primary_product_id = String(cfg.regalo_primary_product_id || '');
              preselected.regalo_secondary_product_id = String(cfg.regalo_secondary_product_id || '');
              preselected.regalo_target_product_id = String(cfg.regalo_target_product_id || '');
              preselected.regalo_target_category_id = String(cfg.regalo_target_category_id || '');
              preselected.regalo_gift_product_id = String(cfg.regalo_gift_product_id || '');
            }
          } catch (_) {}

          toggleScope(envioScopeInput.value, envioProductWrap, envioCategoryWrap);
          toggleScope(cuotasScopeInput.value, cuotasProductWrap, cuotasCategoryWrap);
          toggleRegaloMode();

          const [products, categories] = await Promise.all([
            loadAllProducts(resolvedStoreId),
            loadAllCategories(resolvedStoreId),
          ]);
          selectData.products = products;
          selectData.categories = categories;

          ['envio_product_id', 'cuotas_product_id', 'regalo_primary_product_id', 'regalo_secondary_product_id', 'regalo_target_product_id', 'regalo_gift_product_id']
            .forEach(function (id) { fillSelect(document.getElementById(id), selectData.products); });
          ['envio_category_id', 'cuotas_category_id', 'regalo_target_category_id']
            .forEach(function (id) { fillSelect(document.getElementById(id), selectData.categories); });

          Object.keys(preselected).forEach(function (key) {
            const el = document.getElementById(key);
            if (el && preselected[key]) el.value = preselected[key];
          });
        } catch (err) {
          if (!initialStoreId) {
            nexoError.style.display = 'block';
            nexoError.textContent = 'No se pudo inicializar Nexo.';
          }
        }
      })();
    </script>
  </body>
</html>`);
});

app.post('/admin/save', async (req, res) => {
  const storeId = String(req.body.store_id || '').replace(/[^0-9]/g, '');
  const enableEnvioRule = req.body.enable_envio_rule === '1';
  const enableCuotasRule = req.body.enable_cuotas_rule === '1';
  const enableRegaloRule = req.body.enable_regalo_rule === '1';

  const envioMinAmount = Number(req.body.envio_min_amount || 0);
  const envioScope = String(req.body.envio_scope || 'all').trim();
  const envioCategoryId = String(req.body.envio_category_id || '').trim();
  const envioProductId = String(req.body.envio_product_id || '').trim();
  const envioTextPrefix = String(req.body.envio_text_prefix || '').trim();
  const envioTextSuffix = String(req.body.envio_text_suffix || '').trim();
  const envioTextReached = String(req.body.envio_text_reached || '').trim();
  const envioBarColor = String(req.body.envio_bar_color || '').trim();

  const cuotasThresholdAmount = Number(req.body.cuotas_threshold_amount || 0);
  const cuotasScope = String(req.body.cuotas_scope || 'all').trim();
  const cuotasCategoryId = String(req.body.cuotas_category_id || '').trim();
  const cuotasProductId = String(req.body.cuotas_product_id || '').trim();
  const cuotasTextPrefix = String(req.body.cuotas_text_prefix || '').trim();
  const cuotasTextSuffix = String(req.body.cuotas_text_suffix || '').trim();
  const cuotasTextReached = String(req.body.cuotas_text_reached || '').trim();
  const cuotasBarColor = String(req.body.cuotas_bar_color || '').trim();

  const regaloMode = String(req.body.regalo_mode || 'combo_products').trim();
  const regaloMinAmount = Number(req.body.regalo_min_amount || 0);
  const regaloPrimaryProductId = String(req.body.regalo_primary_product_id || '').trim();
  const regaloSecondaryProductId = String(req.body.regalo_secondary_product_id || '').trim();
  const regaloTargetType = String(req.body.regalo_target_type || 'same_product_qty').trim();
  const regaloTargetQty = Number(req.body.regalo_target_qty || 0);
  const regaloTargetProductId = String(req.body.regalo_target_product_id || '').trim();
  const regaloTargetCategoryId = String(req.body.regalo_target_category_id || '').trim();
  const regaloGiftProductId = String(req.body.regalo_gift_product_id || '').trim();
  const regaloTextPrefix = String(req.body.regalo_text_prefix || '').trim();
  const regaloTextSuffix = String(req.body.regalo_text_suffix || '').trim();
  const regaloTextReached = String(req.body.regalo_text_reached || '').trim();
  const regaloBarColor = String(req.body.regalo_bar_color || '').trim();

  if (!storeId) return res.status(400).send('Missing store_id');
  if ([envioMinAmount, cuotasThresholdAmount, regaloMinAmount, regaloTargetQty].some((n) => Number.isNaN(n) || n < 0)) {
    return res.status(400).send('Invalid numeric values');
  }

  try {
    await ensureGoalSettingsTable();

    await pool.query(
      `UPDATE tiendas SET monto_envio_gratis = $1, monto_cuotas = $2, monto_regalo = $3 WHERE store_id = $4`,
      [envioMinAmount, cuotasThresholdAmount, regaloMinAmount, storeId]
    );

    await pool.query(
      `INSERT INTO store_goal_settings (
         store_id,
         enable_envio_rule,
         enable_cuotas_rule,
         enable_regalo_rule,
         envio_min_amount,
         envio_scope,
         envio_category_id,
         envio_product_id,
         envio_bar_color,
         envio_text_prefix,
         envio_text_suffix,
         envio_text_reached,
         cuotas_threshold_amount,
         cuotas_scope,
         cuotas_category_id,
         cuotas_product_id,
         cuotas_bar_color,
         cuotas_text_prefix,
         cuotas_text_suffix,
         cuotas_text_reached,
         regalo_min_amount,
         regalo_mode,
         regalo_primary_product_id,
         regalo_secondary_product_id,
         regalo_target_type,
         regalo_target_qty,
         regalo_target_product_id,
         regalo_target_category_id,
         regalo_gift_product_id,
         regalo_bar_color,
         regalo_text_prefix,
         regalo_text_suffix,
         regalo_text_reached,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13, $14, NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''), NULLIF($18, ''), NULLIF($19, ''), $20, $21, NULLIF($22, ''), NULLIF($23, ''), $24, $25, $26, NULLIF($27, ''), $28, $29, NULLIF($30, ''), NULLIF($31, ''), NULLIF($32, ''), NULLIF($33, ''), CURRENT_TIMESTAMP)
       ON CONFLICT (store_id)
       DO UPDATE SET
         enable_envio_rule = EXCLUDED.enable_envio_rule,
         enable_cuotas_rule = EXCLUDED.enable_cuotas_rule,
         enable_regalo_rule = EXCLUDED.enable_regalo_rule,
         envio_min_amount = EXCLUDED.envio_min_amount,
         envio_scope = EXCLUDED.envio_scope,
         envio_category_id = EXCLUDED.envio_category_id,
         envio_product_id = EXCLUDED.envio_product_id,
         envio_bar_color = EXCLUDED.envio_bar_color,
         envio_text_prefix = EXCLUDED.envio_text_prefix,
         envio_text_suffix = EXCLUDED.envio_text_suffix,
         envio_text_reached = EXCLUDED.envio_text_reached,
         cuotas_threshold_amount = EXCLUDED.cuotas_threshold_amount,
         cuotas_scope = EXCLUDED.cuotas_scope,
         cuotas_category_id = EXCLUDED.cuotas_category_id,
         cuotas_product_id = EXCLUDED.cuotas_product_id,
         cuotas_bar_color = EXCLUDED.cuotas_bar_color,
         cuotas_text_prefix = EXCLUDED.cuotas_text_prefix,
         cuotas_text_suffix = EXCLUDED.cuotas_text_suffix,
         cuotas_text_reached = EXCLUDED.cuotas_text_reached,
         regalo_min_amount = EXCLUDED.regalo_min_amount,
         regalo_mode = EXCLUDED.regalo_mode,
         regalo_primary_product_id = EXCLUDED.regalo_primary_product_id,
         regalo_secondary_product_id = EXCLUDED.regalo_secondary_product_id,
         regalo_target_type = EXCLUDED.regalo_target_type,
         regalo_target_qty = EXCLUDED.regalo_target_qty,
         regalo_target_product_id = EXCLUDED.regalo_target_product_id,
         regalo_target_category_id = EXCLUDED.regalo_target_category_id,
         regalo_gift_product_id = EXCLUDED.regalo_gift_product_id,
         regalo_bar_color = EXCLUDED.regalo_bar_color,
         regalo_text_prefix = EXCLUDED.regalo_text_prefix,
         regalo_text_suffix = EXCLUDED.regalo_text_suffix,
         regalo_text_reached = EXCLUDED.regalo_text_reached,
         updated_at = CURRENT_TIMESTAMP`,
      [
        storeId,
        enableEnvioRule,
        enableCuotasRule,
        enableRegaloRule,
        envioMinAmount,
        envioScope,
        envioCategoryId,
        envioProductId,
        envioBarColor,
        envioTextPrefix,
        envioTextSuffix,
        envioTextReached,
        cuotasThresholdAmount,
        cuotasScope,
        cuotasCategoryId,
        cuotasProductId,
        cuotasBarColor,
        cuotasTextPrefix,
        cuotasTextSuffix,
        cuotasTextReached,
        regaloMinAmount,
        regaloMode,
        regaloPrimaryProductId,
        regaloSecondaryProductId,
        regaloTargetType,
        regaloTargetQty,
        regaloTargetProductId,
        regaloTargetCategoryId,
        regaloGiftProductId,
        regaloBarColor,
        regaloTextPrefix,
        regaloTextSuffix,
        regaloTextReached,
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    await ensureGoalSettingsTable();

    const result = await pool.query(
      `SELECT t.store_id,
              t.monto_envio_gratis,
              t.monto_cuotas,
              t.monto_regalo,
              s.enable_envio_rule,
              s.enable_cuotas_rule,
              s.enable_regalo_rule,
              s.envio_min_amount,
              s.envio_scope,
              s.envio_category_id,
              s.envio_product_id,
              s.envio_bar_color,
              s.envio_text,
              s.envio_text_prefix,
              s.envio_text_suffix,
              s.envio_text_reached,
              s.cuotas_threshold_amount,
              s.cuotas_scope,
              s.cuotas_category_id,
              s.cuotas_product_id,
              s.cuotas_bar_color,
              s.cuotas_text,
              s.cuotas_text_prefix,
              s.cuotas_text_suffix,
              s.cuotas_text_reached,
              s.regalo_min_amount,
              s.regalo_mode,
              s.regalo_primary_product_id,
              s.regalo_secondary_product_id,
              s.regalo_target_type,
              s.regalo_target_qty,
              s.regalo_target_product_id,
              s.regalo_target_category_id,
              s.regalo_gift_product_id,
              s.regalo_bar_color,
              s.regalo_text,
              s.regalo_text_prefix,
              s.regalo_text_suffix,
              s.regalo_text_reached
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

