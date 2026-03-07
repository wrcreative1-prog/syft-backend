const express = require('express');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');
const { authenticate, requireBusiness } = require('../middleware/authenticate');

const router = express.Router();

// ── How many founding slots exist ────────────────────────────────────────────
const FOUNDING_SLOTS = 20;

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
    `SELECT b.*,
            (SELECT COUNT(*) FROM redemptions r
               JOIN deals d ON r.deal_id = d.id
              WHERE d.business_id = b.id) AS total_redemptions
       FROM businesses b
      WHERE b.owner_id = $1
      ORDER BY b.created_at DESC`,
    [req.user.sub]
  );
  res.json({ businesses: rows });
});

// ── POST /api/businesses  (any authenticated user can register a business) ───
// Auto-assigns founding status to the first FOUNDING_SLOTS businesses.
// Returns the new business record + a fresh JWT with role:'business'.
router.post('/', authenticate, async (req, res) => {
  const { name, category, address, lat, lng } = req.body;

  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'name, lat, and lng are required.' });
  }

  try {
    // Count how many businesses already exist to determine founding status
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) AS n FROM businesses'
    );
    const existing = parseInt(countRows[0].n, 10);

    let plan           = 'free';
    let foundingNumber = null;

    if (existing < FOUNDING_SLOTS) {
      plan           = 'founding';
      foundingNumber = existing + 1;   // 1-based slot number
    }

    const { rows } = await pool.query(
      `INSERT INTO businesses
         (owner_id, name, category, address, lat, lng, plan, founding_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.sub, name, category || 'other', address || null,
       lat, lng, plan, foundingNumber]
    );

    // Upgrade role to 'business'
    const { rows: userRows } = await pool.query(
      `UPDATE users SET role = 'business', last_seen_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.user.sub]
    );

    res.status(201).json({
      business: rows[0],
      token:    signToken(userRows[0]),
      role:     userRows[0].role,
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
