// v2 - Postgres online
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const authRouter       = require('./routes/auth');
const dealsRouter      = require('./routes/deals');
const businessesRouter = require('./routes/businesses');
const adminRouter      = require('./routes/admin');

// ââ Sanity-check required env vars âââââââââââââââââââââââââââââââââââââââââââ
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
REQUIRED_ENV.forEach(key => {
  if (!process.env[key]) {
    console.error(`â  Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

const app  = express();
const PORT = process.env.PORT || 3000;

// ââ Trust Railways proxy (fixes X-Forwarded-For / rate-limit warning) ââââââââ
app.set('trust proxy', 1);

// ââ Security & parsing middleware âââââââââââââââââââââââââââââââââââââââââââââ
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '256kb' }));

// ââ Rate limiting âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ââ Routes ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use('/auth',           authLimiter, authRouter);
app.use('/api/deals',      apiLimiter,  dealsRouter);
app.use('/api/businesses', apiLimiter,  businessesRouter);
app.use('/admin',          adminRouter);

// ââ Health check ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', async (req, res) => {
  try {
    const pool = require('./db/pool');
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database unreachable.' });
  }
});

// ââ Root ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (req, res) => {
  res.json({ name: 'Syft API', version: '1.0.0', status: 'running' });
});

// ââ Consumer mobile app âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/app', (req, res) => {
  res.setHeader(
    'Content-Security-Policy', 
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com; connect-src 'self' https:;"
  );
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// ââ Business portal (standalone web app) ââââââââââââââââââââââââââââââââââââââ
app.get('/business', (req, res) => {
  // Override helmet's CSP to allow the portal's inline scripts/styles
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;"
  );
  res.sendFile(path.join(__dirname, 'public', 'business.html'));
});

// ââ 404 catch-all âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ââ Global error handler ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ââ Start server ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ââ Run schema migration then start ââââââââââââââââââââââââââââââââââââââââââ
(async () => {
  const fs   = require('fs');
  const path = require('path');
  const pool = require('./db/pool');

  // Split schema into individual statements and run each one separately
  // so a single failure doesn't prevent the rest from running.
  // Strip comment lines first so that CREATE TABLE statements preceded by
  // block comments (-- ââ ...) aren't accidentally filtered out.
  const raw = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  const sql = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  let ok = 0, warn = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (err) {
      // "already exists" errors are expected on re-deploy â log but continue
      if (err.code === '42P07' || err.code === '42710' || err.message.includes('already exists')) {
        warn++;
      } else {
        console.error('â ï¸  Migration warning:', err.message);
        warn++;
      }
    }
  }
  console.log(`â  Database schema ready. (${ok} ok, ${warn} skipped)`);

  app.listen(PORT, () => {
    console.log(`ð  Syft API running on port ${PORT}`);
    console.log(`    Environment: ${process.env.NODE_ENV || 'development'}`);
  });
})();
// deploy: mobile.html fix applied
