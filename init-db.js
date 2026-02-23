const pool = require('./db');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS tiendas (
    id SERIAL PRIMARY KEY,
    store_id VARCHAR(255) UNIQUE NOT NULL,
    access_token TEXT NOT NULL,
    monto_envio_gratis DECIMAL DEFAULT 50000,
    monto_regalo DECIMAL DEFAULT 100000,
    monto_cuotas DECIMAL DEFAULT 80000,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

async function init() {
    try {
        await pool.query(createTableQuery);
        console.log("✅ Tabla 'tiendas' creada o verificada con éxito.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Error al crear la tabla:", err);
        process.exit(1);
    }
}

init();