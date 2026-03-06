const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool     = require('../db/pool');
const { authenticate } = require('../middleware/authenticate');

const router = express.Router();
const SALT_ROUNDS = 12;

// ── Helpers ───────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
}

function userPayload(user) {
  return {
    id:           user.id,
    email:        user.email,
    displayName:  user.display_name,
    role:         user.role,
    token:        signToken(user),
  };
}

// ── POST /auth/signup  (email + password) ─────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { email, password, displayName } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [email.toLowerCase().trim(), hash, displayName || null]
    );
    res.status(201).json(userPayload(rows[0]));
  } catch (err) {
    if (err.code === '23505') {   // unique_violation
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

// ── POST /auth/login  (email + password) ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
    res.json(userPayload(user));
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// ── POST /auth/apple ──────────────────────────────────────────────────────────
// The iOS app sends the identityToken it got from ASAuthorizationAppleIDCredential.
router.post('/apple', async (req, res) => {
  const { identityToken, displayName } = req.body;

  if (!identityToken) {
    return res.status(400).json({ error: 'identityToken is required.' });
  }

  try {
    const appleSignin = require('apple-signin-auth');
    const payload = await appleSignin.verifyIdToken(identityToken, {
      audience:       process.env.APPLE_CLIENT_ID,
      ignoreExpiration: false,
    });

    const appleSub = payload.sub;
    const email    = payload.email || null;

    // Find or create user
    let { rows } = await pool.query(
      'SELECT * FROM users WHERE apple_sub = $1',
      [appleSub]
    );

    let user = rows[0];

    if (!user) {
      // First Apple login — create the user
      const result = await pool.query(
        `INSERT INTO users (apple_sub, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET apple_sub = EXCLUDED.apple_sub
         RETURNING *`,
        [appleSub, email, displayName || null]
      );
      user = result.rows[0];
    } else {
      await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
    }

    res.json(userPayload(user));
  } catch (err) {
    console.error('Apple auth error:', err.message);
    res.status(401).json({ error: 'Apple sign-in failed. Token may be invalid or expired.' });
  }
});

// ── POST /auth/google ─────────────────────────────────────────────────────────
// The iOS app sends the idToken it received from Google Sign-In.
router.post('/google', async (req, res) => {
  const { idToken, displayName } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'idToken is required.' });
  }

  try {
    const { OAuth2Client } = require('google-auth-library');
    const client  = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket  = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload   = ticket.getPayload();
    const googleSub = payload.sub;
    const email     = payload.email || null;
    const name      = displayName || payload.name || null;

    let { rows } = await pool.query(
      'SELECT * FROM users WHERE google_sub = $1',
      [googleSub]
    );

    let user = rows[0];

    if (!user) {
      const result = await pool.query(
        `INSERT INTO users (google_sub, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub
         RETURNING *`,
        [googleSub, email, name]
      );
      user = result.rows[0];
    } else {
      await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);
    }

    res.json(userPayload(user));
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Google sign-in failed. Token may be invalid or expired.' });
  }
});

// ── GET /auth/me  (protected) ─────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, display_name, role, created_at FROM users WHERE id = $1',
      [req.user.sub]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch user.' });
  }
});

// ── PATCH /auth/me  (protected) — update display name / role ─────────────────
router.patch('/me', authenticate, async (req, res) => {
  const { displayName, role } = req.body;
  const allowed = ['user', 'business'];

  if (role && !allowed.includes(role)) {
    return res.status(400).json({ error: 'Invalid role.' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET display_name  = COALESCE($1, display_name),
           role          = COALESCE($2, role),
           last_seen_at  = NOW()
       WHERE id = $3
       RETURNING id, email, display_name, role`,
      [displayName || null, role || null, req.user.sub]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Update failed.' });
  }
});

module.exports = router;
