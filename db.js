const { Pool } = require('pg');
require('dotenv').config();

/**
 * Configuramos el Pool de conexión.
 * Usamos 'connectionString' que es el estándar para bases de datos en la nube.
 */
const pool = new Pool({
    // Si existe DATABASE_URL (en Render), la usa. 
    // Si no (en tu PC), arma la conexión con las variables individuales.
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
    
    // El parámetro SSL es obligatorio para Render
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    // Evita requests colgadas indefinidamente cuando la DB está lenta/no disponible
    connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 5000),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
});

// Manejador de errores para no tumbar el servidor si falla la DB
pool.on('error', (err) => {
    console.error('Error inesperado en el pool de PostgreSQL', err);
});

module.exports = pool;
