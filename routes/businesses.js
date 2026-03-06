const express = require('express');
const pool    = require('../db/pool');
const { authenticate, requireBusiness } = require('../middleware/authenticate');

const router = express.Router();

// ── GET /api/businesses/mine  (business owner) ───────────────────────────────
router.get('/mine', requireBusiness, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM businesses WHERE owner_id = $1 ORDER BY created_at DESC',
    [req.user.sub]
  );
  res.json({ businesses: rows });
});

// ── POST /api/businesses  (any authenticated user can register a business) ───
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

    // Upgrade user role to 'business' if they aren't already
    await pool.query(
      `UPDATE users SET role = 'business' WHERE id = $1 AND role = 'user'`,
      [req.user.sub]
    );

    res.status(201).json(rows[0]);
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

module.exports = router;
