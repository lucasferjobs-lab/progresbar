const {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  hashToken,
  parseCookies,
  isValidEmail,
} = require('./auth');
const crypto = require('crypto');

let portalCouponTablesReady = false;

async function ensureBillingCouponTables(pool) {
  if (portalCouponTablesReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_coupons (
      code VARCHAR(32) PRIMARY KEY,
      free_days INTEGER NOT NULL CHECK (free_days > 0 AND free_days <= 365),
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
      used_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_coupon_redemptions (
      id SERIAL PRIMARY KEY,
      coupon_code VARCHAR(32) NOT NULL REFERENCES billing_coupons(code) ON DELETE CASCADE,
      store_id VARCHAR(255) NOT NULL REFERENCES tiendas(store_id) ON DELETE CASCADE,
      free_days INTEGER NOT NULL,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      override_until TIMESTAMP,
      UNIQUE (coupon_code, store_id)
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS billing_coupon_redemptions_store_id_idx ON billing_coupon_redemptions (store_id);`);

  portalCouponTablesReady = true;
}

function normalizeCouponCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 32);
}

function generateCouponCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setSessionCookie(res, token, maxAgeMs) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = Math.max(1, Math.floor(maxAgeMs / 1000));
  res.setHeader('Set-Cookie', `pb_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `pb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function loginView(title, message) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f6f8fb; margin:0; padding:24px; color:#111827; }
    .card { max-width:420px; margin:40px auto; background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:20px; }
    label { display:block; font-size:14px; margin:10px 0 6px; }
    input { width:100%; height:40px; border:1px solid #d1d5db; border-radius:8px; padding:0 10px; }
    button { width:100%; height:42px; margin-top:14px; border:0; border-radius:8px; background:#1663e6; color:#fff; font-weight:700; cursor:pointer; }
    .msg { margin:10px 0; color:#b42318; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${esc(title)}</h2>
    ${message ? `<p class="msg">${esc(message)}</p>` : ''}
    <form method="POST">
      <label>Email</label>
      <input type="email" name="email" required />
      <label>Contrase\u00f1a</label>
      <input type="password" name="password" required />
      <button type="submit">Ingresar</button>
    </form>
  </div>
</body>
</html>`;
}

function shellView(title, contentHtml) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; background:#f6f8fb; margin:0; color:#111827; }
    header { background:#0f172a; color:#fff; padding:14px 18px; }
    main { padding:20px; max-width:1100px; margin:0 auto; }
    .grid { display:grid; gap:16px; grid-template-columns:1fr 1fr; }
    .card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:16px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    input, select { height:36px; border:1px solid #d1d5db; border-radius:8px; padding:0 10px; }
    button { height:36px; border:0; border-radius:8px; background:#1663e6; color:#fff; font-weight:700; padding:0 12px; cursor:pointer; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { border-bottom:1px solid #e5e7eb; text-align:left; padding:8px 4px; }
    .muted { color:#6b7280; font-size:13px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  ${contentHtml}
</body>
</html>`;
}

async function createSession(pool, userId) {
  const ttlMs = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
  const token = generateSessionToken();
  const tokenHash = hashToken(token);

  await pool.query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3::bigint * INTERVAL '1 millisecond'))`,
    [userId, tokenHash, ttlMs]
  );

  return { token, ttlMs };
}

async function resolveSessionUser(pool, req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.pb_session;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT u.id, u.email, u.is_super_admin, u.is_active
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

function registerPortalRoutes(app, pool, opts) {
  const clientId = opts.clientId;

  app.get('/sa/login', async (req, res) => {
    const user = await resolveSessionUser(pool, req).catch(() => null);
    if (user && user.is_super_admin) return res.redirect(302, '/sa');
    return res.status(200).send(loginView('Super Admin Login', ''));
  });

  app.post('/sa/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    try {
      const result = await pool.query(
        `SELECT id, email, password_hash, is_super_admin, is_active
         FROM users
         WHERE lower(email) = lower($1)
         LIMIT 1`,
        [email]
      );
      const user = result.rows[0];

      if (!user || !user.is_active || !user.is_super_admin || !verifyPassword(password, user.password_hash)) {
        return res.status(401).send(loginView('Super Admin Login', 'Credenciales inválidas'));
      }

      const { token, ttlMs } = await createSession(pool, user.id);
      setSessionCookie(res, token, ttlMs);
      return res.redirect(302, '/sa');
    } catch {
      return res.status(500).send(loginView('Super Admin Login', 'Error interno'));
    }
  });

  app.get('/panel/login', async (req, res) => {
    const user = await resolveSessionUser(pool, req).catch(() => null);
    if (user) return res.redirect(302, '/panel');
    return res.status(200).send(loginView('Panel de Usuario', ''));
  });

  app.post('/panel/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    try {
      const result = await pool.query(
        `SELECT id, email, password_hash, is_super_admin, is_active
         FROM users
         WHERE lower(email) = lower($1)
         LIMIT 1`,
        [email]
      );
      const user = result.rows[0];

      if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
        return res.status(401).send(loginView('Panel de Usuario', 'Credenciales inválidas'));
      }

      const { token, ttlMs } = await createSession(pool, user.id);
      setSessionCookie(res, token, ttlMs);
      return res.redirect(302, '/panel');
    } catch {
      return res.status(500).send(loginView('Panel de Usuario', 'Error interno'));
    }
  });

  app.get('/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.pb_session;
    if (token) {
      await pool.query('DELETE FROM user_sessions WHERE token_hash = $1', [hashToken(token)]).catch(() => {});
    }
    clearSessionCookie(res);
    return res.redirect(302, '/panel/login');
  });

  app.use('/sa', async (req, res, next) => {
    if (req.path === '/login') return next();

    const user = await resolveSessionUser(pool, req).catch(() => null);
    if (!user || !user.is_super_admin) {
      return res.redirect(302, '/sa/login');
    }

    req.sessionUser = user;
    next();
  });

  app.use('/panel', async (req, res, next) => {
    if (req.path === '/login') return next();

    const user = await resolveSessionUser(pool, req).catch(() => null);
    if (!user) {
      return res.redirect(302, '/panel/login');
    }

    req.sessionUser = user;
    next();
  });

  app.get('/sa', async (req, res) => {
    await ensureBillingCouponTables(pool);

    const users = await pool.query(
      `SELECT id, email, is_super_admin, is_active, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 200`
    );

    const stores = await pool.query(
      `SELECT t.store_id,
              t.monto_envio_gratis,
              t.monto_cuotas,
              t.monto_regalo,
              t.created_at,
              COALESCE(string_agg(u.email || ' (' || m.role || ')', ', ' ORDER BY u.email), '') AS members
       FROM tiendas t
       LEFT JOIN store_memberships m ON m.store_id = t.store_id
       LEFT JOIN users u ON u.id = m.user_id
       GROUP BY t.store_id, t.monto_envio_gratis, t.monto_cuotas, t.monto_regalo, t.created_at
       ORDER BY t.created_at DESC
       LIMIT 300`
    );

    const coupons = await pool.query(
      `SELECT code, free_days, max_uses, used_count, is_active, created_at
       FROM billing_coupons
       ORDER BY created_at DESC
       LIMIT 200`
    );

    const userRows = users.rows.map((u) => `<tr><td>${u.id}</td><td>${esc(u.email)}</td><td>${u.is_super_admin ? 'si' : 'no'}</td><td>${u.is_active ? 'activo' : 'inactivo'}</td></tr>`).join('');
    const storeRows = stores.rows.map((s) => `<tr><td>${esc(s.store_id)}</td><td>${esc(s.members || '-')}</td><td>${Number(s.monto_envio_gratis)}</td><td>${Number(s.monto_regalo)}</td><td><a href="https://admin.tiendanube.com/apps/${esc(clientId)}/admin?store_id=${esc(s.store_id)}" target="_blank" rel="noreferrer">Abrir app</a></td></tr>`).join('');
    const couponRows = coupons.rows.map((c) => {
      const maxUses = c.max_uses == null ? '-' : Number(c.max_uses);
      const used = Number(c.used_count || 0);
      const active = c.is_active !== false;
      return `<tr><td><code>${esc(c.code)}</code></td><td>${Number(c.free_days)}</td><td>${esc(maxUses)}</td><td>${used}</td><td>${active ? 'si' : 'no'}</td><td>
        <form method="POST" action="/sa/coupons/${encodeURIComponent(String(c.code))}/toggle">
          <button type="submit">${active ? 'Desactivar' : 'Activar'}</button>
        </form>
      </td></tr>`;
    }).join('');

    const html = shellView('Super Admin', `
<header><strong>Super Admin</strong> - ${esc(req.sessionUser.email)} - <a style="color:#93c5fd" href="/auth/logout">Salir</a></header>
<main>
  <div class="grid">
    <section class="card">
      <h3>Crear Usuario</h3>
      <form method="POST" action="/sa/users" class="row">
        <input type="email" name="email" placeholder="email" required />
        <input type="password" name="password" placeholder="password" required />
        <label class="row"><input type="checkbox" name="is_super_admin" value="1" /> super admin</label>
        <button type="submit">Crear</button>
      </form>
      <p class="muted">Para usuarios normales, usa esta cuenta para entrar en <code>/panel/login</code>.</p>
    </section>
    <section class="card">
      <h3>Asignar Tienda a Usuario</h3>
      <form method="POST" action="/sa/memberships" class="row">
        <input name="store_id" placeholder="store_id" required />
        <input type="email" name="user_email" placeholder="email usuario" required />
        <select name="role" required>
          <option value="owner">owner</option>
          <option value="admin">admin</option>
          <option value="viewer">viewer</option>
        </select>
        <button type="submit">Asignar</button>
      </form>
      <p class="muted">Si la tienda no existe en DB, se crea placeholder automáticamente.</p>
    </section>
    <section class="card">
      <h3>Cupones</h3>
      <form method="POST" action="/sa/coupons" class="row">
        <input name="code" placeholder="codigo (opcional)" />
        <input type="number" min="1" max="365" name="free_days" placeholder="dias" required />
        <input type="number" min="1" name="max_uses" placeholder="max usos (opcional)" />
        <button type="submit">Crear</button>
      </form>
    </section>
  </div>

  <section class="card">
    <h3>Usuarios</h3>
    <table>
      <thead><tr><th>ID</th><th>Email</th><th>Super Admin</th><th>Estado</th></tr></thead>
      <tbody>${userRows || '<tr><td colspan="4">Sin usuarios</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h3>Tiendas</h3>
    <table>
      <thead><tr><th>Store</th><th>Miembros</th><th>Envio</th><th>Regalo</th><th>Accion</th></tr></thead>
      <tbody>${storeRows || '<tr><td colspan="5">Sin tiendas</td></tr>'}</tbody>
    </table>
  </section>

  <section class="card">
    <h3>Cupones</h3>
    <table>
      <thead><tr><th>Codigo</th><th>Dias</th><th>Max usos</th><th>Usados</th><th>Activo</th><th>Accion</th></tr></thead>
      <tbody>${couponRows || '<tr><td colspan="6">Sin cupones</td></tr>'}</tbody>
    </table>
  </section>
</main>`);

    return res.status(200).send(html);
  });

  app.post('/sa/coupons', async (req, res) => {
    await ensureBillingCouponTables(pool);

    let code = normalizeCouponCode(req.body.code);
    if (!code) code = generateCouponCode();

    const freeDays = Math.round(Number(req.body.free_days || 0));
    const maxUsesRaw = req.body.max_uses;
    const maxUses = maxUsesRaw == null || String(maxUsesRaw).trim() === '' ? null : Math.round(Number(maxUsesRaw));

    if (!code || code.length < 6) return res.status(400).send('Codigo invalido');
    if (!Number.isFinite(freeDays) || freeDays < 1 || freeDays > 365) return res.status(400).send('Dias invalidos');
    if (maxUses != null && (!Number.isFinite(maxUses) || maxUses < 1)) return res.status(400).send('Max usos invalido');

    const insert = await pool.query(
      `INSERT INTO billing_coupons (code, free_days, max_uses, used_count, is_active)
       VALUES ($1, $2, $3, 0, TRUE)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [code, freeDays, maxUses]
    );
    if (!insert.rows[0]) return res.status(409).send('Cupon ya existe');

    console.info('[billing] coupon_created', { code, free_days: freeDays, max_uses: maxUses });
    return res.redirect(302, '/sa');
  });

  app.post('/sa/coupons/:code/toggle', async (req, res) => {
    await ensureBillingCouponTables(pool);

    const code = normalizeCouponCode(req.params.code);
    if (!code) return res.status(400).send('Codigo invalido');

    const result = await pool.query(
      `UPDATE billing_coupons
       SET is_active = NOT is_active
       WHERE code = $1
       RETURNING code, is_active`,
      [code]
    );
    if (!result.rows[0]) return res.status(404).send('Cupon no encontrado');

    console.info('[billing] coupon_toggled', { code, is_active: result.rows[0].is_active });
    return res.redirect(302, '/sa');
  });

  app.post('/sa/users', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const isSuperAdmin = req.body.is_super_admin === '1';

    if (!isValidEmail(email) || password.length < 8) {
      return res.status(400).send('Email invalido o password < 8 caracteres');
    }

    try {
      const passwordHash = hashPassword(password);
      await pool.query(
        `INSERT INTO users (email, password_hash, is_super_admin, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT ((lower(email))) DO NOTHING`,
        [email, passwordHash, isSuperAdmin]
      );
      return res.redirect(302, '/sa');
    } catch {
      return res.status(500).send('No se pudo crear el usuario');
    }
  });

  app.post('/sa/memberships', async (req, res) => {
    const storeId = String(req.body.store_id || '').replace(/[^0-9]/g, '');
    const userEmail = String(req.body.user_email || '').trim().toLowerCase();
    const role = String(req.body.role || '').trim();

    if (!storeId || !isValidEmail(userEmail) || !['owner', 'admin', 'viewer'].includes(role)) {
      return res.status(400).send('Parametros invalidos');
    }

    try {
      const userResult = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [userEmail]);
      const user = userResult.rows[0];
      if (!user) return res.status(404).send('Usuario no encontrado');

      await pool.query(
        `INSERT INTO tiendas (store_id, access_token)
         VALUES ($1, COALESCE((SELECT access_token FROM tiendas WHERE store_id = $1), ''))
         ON CONFLICT (store_id) DO NOTHING`,
        [storeId]
      ).catch(async () => {
        const existing = await pool.query('SELECT 1 FROM tiendas WHERE store_id = $1', [storeId]);
        if (!existing.rows[0]) {
          await pool.query(
            `INSERT INTO tiendas (store_id, access_token, monto_envio_gratis, monto_cuotas, monto_regalo)
             VALUES ($1, $2, 50000, 80000, 100000)
             ON CONFLICT (store_id) DO NOTHING`,
            [storeId, 'pending']
          );
        }
      });

      await pool.query(
        `INSERT INTO store_memberships (store_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (store_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [storeId, user.id, role]
      );

      return res.redirect(302, '/sa');
    } catch {
      return res.status(500).send('No se pudo asignar membresia');
    }
  });

  app.get('/panel', async (req, res) => {
    const user = req.sessionUser;

    const memberships = user.is_super_admin
      ? await pool.query(
          `SELECT t.store_id, 'owner'::text AS role, t.monto_envio_gratis, t.monto_cuotas, t.monto_regalo
           FROM tiendas t
           ORDER BY t.store_id`
        )
      : await pool.query(
          `SELECT t.store_id, m.role, t.monto_envio_gratis, t.monto_cuotas, t.monto_regalo
           FROM store_memberships m
           JOIN tiendas t ON t.store_id = m.store_id
           WHERE m.user_id = $1
           ORDER BY t.store_id`,
          [user.id]
        );

    const rows = memberships.rows.map((s) => {
      const canEdit = user.is_super_admin || s.role === 'owner' || s.role === 'admin';
      return `<tr>
        <td>${esc(s.store_id)}</td>
        <td>${esc(s.role)}</td>
        <td>${Number(s.monto_envio_gratis)}</td>
        <td>${Number(s.monto_regalo)}</td>
        <td><a href="/panel/store/${esc(s.store_id)}">Abrir</a></td>
        <td><a href="https://admin.tiendanube.com/apps/${esc(clientId)}/admin?store_id=${esc(s.store_id)}" target="_blank" rel="noreferrer">Admin TN</a></td>
        <td>${canEdit ? 'edita' : 'solo lectura'}</td>
      </tr>`;
    }).join('');

    return res.status(200).send(shellView('Panel Usuario', `
<header><strong>Panel Usuario</strong> - ${esc(user.email)} - <a style="color:#93c5fd" href="/auth/logout">Salir</a> ${user.is_super_admin ? '| <a style="color:#93c5fd" href="/sa">Super Admin</a>' : ''}</header>
<main>
  <section class="card">
    <h3>Tus tiendas</h3>
    <table>
      <thead><tr><th>Store</th><th>Rol</th><th>Envio</th><th>Regalo</th><th>Panel</th><th>App TN</th><th>Permisos</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">Sin tiendas asignadas</td></tr>'}</tbody>
    </table>
  </section>
</main>`));
  });

  app.get('/panel/store/:storeId', async (req, res) => {
    const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
    if (!storeId) return res.status(400).send('Store invalida');

    const user = req.sessionUser;
    const member = user.is_super_admin
      ? { role: 'owner' }
      : (await pool.query('SELECT role FROM store_memberships WHERE store_id = $1 AND user_id = $2 LIMIT 1', [storeId, user.id])).rows[0];

    if (!member) return res.status(403).send('Sin acceso a esta tienda');

    const cfg = await pool.query(
      `SELECT store_id, monto_envio_gratis, monto_cuotas, monto_regalo
       FROM tiendas WHERE store_id = $1 LIMIT 1`,
      [storeId]
    );
    const row = cfg.rows[0] || { store_id: storeId, monto_envio_gratis: 50000, monto_cuotas: 80000, monto_regalo: 100000 };

    const canEdit = user.is_super_admin || member.role === 'owner' || member.role === 'admin';

    return res.status(200).send(shellView(`Tienda ${storeId}`, `
<header><strong>Tienda ${esc(storeId)}</strong> - <a style="color:#93c5fd" href="/panel">Volver</a></header>
<main>
  <section class="card">
    <p>Rol: <strong>${esc(member.role)}</strong></p>
    <form method="POST" action="/panel/store/${esc(storeId)}" ${canEdit ? '' : 'onsubmit="return false;"'}>
      <div class="row">
        <label>Envio gratis</label>
        <input type="number" min="0" name="envio" value="${Number(row.monto_envio_gratis)}" ${canEdit ? '' : 'disabled'} required />
      </div>
      <div class="row">
        <label>Cuotas</label>
        <input type="number" min="0" name="cuotas" value="${Number(row.monto_cuotas)}" ${canEdit ? '' : 'disabled'} required />
      </div>
      <div class="row">
        <label>Regalo</label>
        <input type="number" min="0" name="regalo" value="${Number(row.monto_regalo)}" ${canEdit ? '' : 'disabled'} required />
      </div>
      ${canEdit ? '<button type="submit">Guardar</button>' : '<p class="muted">No tienes permisos de edición.</p>'}
    </form>
  </section>
</main>`));
  });

  app.post('/panel/store/:storeId', async (req, res) => {
    const storeId = String(req.params.storeId || '').replace(/[^0-9]/g, '');
    if (!storeId) return res.status(400).send('Store invalida');

    const user = req.sessionUser;
    const member = user.is_super_admin
      ? { role: 'owner' }
      : (await pool.query('SELECT role FROM store_memberships WHERE store_id = $1 AND user_id = $2 LIMIT 1', [storeId, user.id])).rows[0];

    const canEdit = !!member && (user.is_super_admin || member.role === 'owner' || member.role === 'admin');
    if (!canEdit) return res.status(403).send('Sin permisos');

    const envio = Number(req.body.envio);
    const cuotas = Number(req.body.cuotas);
    const regalo = Number(req.body.regalo);
    if ([envio, cuotas, regalo].some((n) => Number.isNaN(n) || n < 0)) {
      return res.status(400).send('Valores invalidos');
    }

    await pool.query(
      `UPDATE tiendas
       SET monto_envio_gratis = $1, monto_cuotas = $2, monto_regalo = $3
       WHERE store_id = $4`,
      [envio, cuotas, regalo, storeId]
    );

    return res.redirect(302, `/panel/store/${storeId}`);
  });
}

module.exports = { registerPortalRoutes };
