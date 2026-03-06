const { Pool } = require('pg');

// Railway (and most PG hosts) provide DATABASE_URL.
// SSL is required on Railway — reject unauthorised certs only in prod.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

module.exports = pool;
