const express = require('express');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { authenticate, requireBusiness } = require('../middleware/authenticate');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
}

// ── GET /api/businesses/mine  (business owner) ───────────────────────────────
router.get('/mine', requireBusiness, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM businesses WHERE owner_id = $1 ORDER BY created_at DESC',
    [req.user.sub]
  );
  res.json({ businesses: rows });
});

// ── POST /api/businesses  (any authenticated user can register a business) ───
// Returns the new business record AND a fresh JWT so the app gets the
// upgraded role ('business') immediately — no re-login needed.
router.post('/', authenticate, async (req, res) => {
  const { name, category, address, lat, lng } = req.body;

  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'name, lat, and lng are required.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO businesses (owner_id, name, category, address, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.sub, name, category || 'other', address || null, lat, lng]
    );

    // Upgrade role to 'business' and fetch the updated user row
    const { rows: userRows } = await pool.query(
      `UPDATE users SET role = 'business', last_seen_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.user.sub]
    );

    const updatedUser = userRows[0];

    res.status(201).json({
      business: rows[0],
      // Fresh token with role:'business' so the app doesn't need re-login
      token: signToken(updatedUser),
      role:  updatedUser.role,
    });
  } catch (err) {
    console.error('Create business error:', err.message);
    res.status(500).json({ error: 'Could not create business.' });
  }
});

// ── PATCH /api/businesses/:id  (owner only) ──────────────────────────────────
router.patch('/:id', requireBusiness, async (req, res) => {
  const allowed = ['name', 'category', 'address', 'lat', 'lng'];
  const keys    = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'No valid fields to update.' });

  const setClauses = keys.map((k, i) => `"${k}" = $${i + 3}`).join(', ');
  const values     = keys.map(k => req.body[k]);

  try {
    const { rows } = await pool.query(
      `UPDATE businesses SET ${setClauses}
       WHERE id = $1 AND owner_id = $2
       RETURNING *`,
      [req.params.id, req.user.sub, ...values]
    );
    if (!rows[0]) return res.status(403).json({ error: 'Not found or not authorised.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Could not update business.' });
  }
});

// ── DELETE /api/businesses/:id  (owner only) ─────────────────────────────────
router.delete('/:id', requireBusiness, async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM businesses WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [req.params.id, req.user.sub]
  );
  if (!rows[0]) return res.status(403).json({ error: 'Not found or not authorised.' });
  res.json({ deleted: rows[0].id });
});

module.exports = router;
