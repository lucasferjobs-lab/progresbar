const pool = require('./db');
const { hashPassword } = require('./auth');

const schemaQueries = [
  `CREATE TABLE IF NOT EXISTS tiendas (
      id SERIAL PRIMARY KEY,
      store_id VARCHAR(255) UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      monto_envio_gratis DECIMAL DEFAULT 50000,
      monto_regalo DECIMAL DEFAULT 100000,
      monto_cuotas DECIMAL DEFAULT 80000,
      billing_active BOOLEAN DEFAULT TRUE,
      billing_reason VARCHAR(64),
      billing_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      billing_checked_at TIMESTAMP,
      billing_override_until TIMESTAMP,
      billing_override_reason VARCHAR(64),
      billing_override_code VARCHAR(64),
      billing_override_updated_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_super_admin BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users ((lower(email)));`,

  `CREATE TABLE IF NOT EXISTS store_memberships (
      id SERIAL PRIMARY KEY,
      store_id VARCHAR(255) NOT NULL REFERENCES tiendas(store_id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (store_id, user_id)
  );`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS store_goal_settings (
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
      ui_bg_color VARCHAR(32),
      ui_border_color VARCHAR(32),
      ui_track_color VARCHAR(32),
      ui_text_color VARCHAR(32),
      ui_bar_height INTEGER DEFAULT 10,
      ui_radius INTEGER DEFAULT 14,
      ui_shadow BOOLEAN DEFAULT TRUE,
      ui_animation BOOLEAN DEFAULT TRUE,
      ui_compact BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS billing_coupons (
      code VARCHAR(32) PRIMARY KEY,
      free_days INTEGER NOT NULL CHECK (free_days > 0 AND free_days <= 365),
      max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
      used_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );`,

  `CREATE TABLE IF NOT EXISTS billing_coupon_redemptions (
      id SERIAL PRIMARY KEY,
      coupon_code VARCHAR(32) NOT NULL REFERENCES billing_coupons(code) ON DELETE CASCADE,
      store_id VARCHAR(255) NOT NULL REFERENCES tiendas(store_id) ON DELETE CASCADE,
      free_days INTEGER NOT NULL,
      redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      override_until TIMESTAMP,
      UNIQUE (coupon_code, store_id)
  );`,

  `CREATE INDEX IF NOT EXISTS billing_coupon_redemptions_store_id_idx ON billing_coupon_redemptions (store_id);`,

  `CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions (user_id);`,
  `CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx ON user_sessions (expires_at);`,
];

async function bootstrapSuperAdmin() {
  const email = String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SUPERADMIN_PASSWORD || '');

  if (!email || !password) {
    console.log('INFO: SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD not set. Skipping bootstrap.');
    return;
  }

  if (password.length < 8) {
    console.log('WARN: SUPERADMIN_PASSWORD must have at least 8 chars. Skipping bootstrap.');
    return;
  }

  const passwordHash = hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, password_hash, is_super_admin, is_active)
     VALUES ($1, $2, TRUE, TRUE)
     ON CONFLICT ((lower(email)))
     DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       is_super_admin = TRUE,
       is_active = TRUE`,
    [email, passwordHash]
  );

  console.log(`OK: super admin ready for ${email}`);
}

async function init() {
  try {
    for (const query of schemaQueries) {
      await pool.query(query);
    }

    await bootstrapSuperAdmin();
    console.log("OK: schema ready (tiendas/users/memberships/sessions)");
    process.exit(0);
  } catch (err) {
    console.error('ERROR: schema migration failed:', err);
    process.exit(1);
  }
}

init();
