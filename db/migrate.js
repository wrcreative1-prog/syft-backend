// Run with: node db/migrate.js
// Applies schema.sql against the DATABASE_URL in your .env
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('./pool');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅  Schema applied successfully.');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
