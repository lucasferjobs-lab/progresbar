require('dotenv').config();

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const pool = require('./db');

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

const ADMIN_ALLOWED_ORIGINS = [
  'https://admin.tiendanube.com',
  'https://admin.nuvemshop.com.br',
  'https://admin.lojavirtualnuvem.com.br',
];

const oauthStateStore = new Map();

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

// CORS for storefront script config fetches from merchant domains.
app.use('/api/config', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
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
  const endpoint = `https://api.tiendanube.com/v1/${storeId}/scripts`;
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
    return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <title>Redirigiendo...</title>
  </head>
  <body>
    <script>
      try {
        window.top.location.replace(${JSON.stringify(adminUrl)});
      } catch (_) {
        window.location.replace(${JSON.stringify(adminUrl)});
      }
    </script>
    <noscript><a href="${adminUrl}">Continuar</a></noscript>
  </body>
</html>`);
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
        --bg: #f6f8fa;
        --card: #ffffff;
        --text: #15202b;
        --muted: #6a7785;
        --line: #e5e9ef;
        --brand: #1663e6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      .card {
        max-width: 720px;
        margin: 0 auto;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p { margin: 0 0 16px; color: var(--muted); }
      .grid {
        display: grid;
        gap: 16px;
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-weight: 600;
      }
      input[type="number"] {
        width: 100%;
        height: 42px;
        padding: 10px 12px;
        border: 1px solid #cfd6e0;
        border-radius: 8px;
      }
      button {
        margin-top: 8px;
        width: 100%;
        height: 44px;
        border: 0;
        border-radius: 8px;
        background: var(--brand);
        color: #fff;
        font-weight: 700;
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
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Barra de Progreso</h1>
      <p>Configura los montos para mostrar beneficios en el carrito.</p>

      <form action="/admin/save" method="POST" class="grid">
        <input type="hidden" name="store_id" id="storeId" value="${safeStoreId}" />

        <div>
          <label for="envio">Monto para envío gratis</label>
          <input id="envio" type="number" min="0" name="envio" value="${Number(defaultConfig.monto_envio_gratis)}" required />
        </div>

        <div>
          <label for="cuotas">Monto para cuotas sin interés</label>
          <input id="cuotas" type="number" min="0" name="cuotas" value="${Number(defaultConfig.monto_cuotas)}" required />
        </div>

        <div>
          <label for="regalo">Monto para regalo</label>
          <input id="regalo" type="number" min="0" name="regalo" value="${Number(defaultConfig.monto_regalo)}" required />
        </div>

        <button type="submit">Guardar configuración</button>
      </form>

      <p class="meta">Store ID: <span id="storeLabel">${safeStoreId || 'pendiente'}</span></p>
      <p class="error" id="nexoError" style="display:none;"></p>
    </main>

    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin="anonymous"></script>
    <script>window.react = window.React;</script>
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
              }
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

  if (!storeId) return res.status(400).send('Missing store_id');
  if ([envio, cuotas, regalo].some((n) => Number.isNaN(n) || n < 0)) {
    return res.status(400).send('Invalid numeric values');
  }

  try {
    await pool.query(
      `UPDATE tiendas SET monto_envio_gratis = $1, monto_cuotas = $2, monto_regalo = $3 WHERE store_id = $4`,
      [envio, cuotas, regalo, storeId]
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
      `SELECT store_id, monto_envio_gratis, monto_cuotas, monto_regalo
       FROM tiendas
       WHERE store_id = $1`,
      [storeId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Config not found' });
    return res.status(200).json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] running on port ${PORT}`);
});
