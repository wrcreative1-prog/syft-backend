/**
 * Admin routes — protected by the ADMIN_SECRET environment variable.
 * Pass it as:  Authorization: Admin <secret>
 *
 * Routes:
 *   POST /admin/promote       — set a user's role (user / business / admin)
 *   GET  /admin/users         — list all users
 *   GET  /admin/stats         — platform counts
 *   POST /admin/seed          — insert seed businesses + deals
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

const router = express.Router();

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] || '';
  const secret = header.startsWith('Admin ') ? header.slice(6) : null;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin access denied.' });
  }
  next();
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.display_name },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );
}

// ── POST /admin/promote ───────────────────────────────────────────────────────
// Body: { email, role }   role: 'user' | 'business' | 'admin'
router.post('/promote', requireAdmin, async (req, res) => {
  const { email, role } = req.body;
  const allowed = ['user', 'business', 'admin'];

  if (!email || !role || !allowed.includes(role)) {
    return res.status(400).json({ error: 'email and role (user|business|admin) are required.' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users SET role = $1, last_seen_at = NOW()
       WHERE email = $2
       RETURNING id, email, display_name, role`,
      [role, email.toLowerCase().trim()]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    res.json({
      user:  rows[0],
      token: signToken(rows[0]),
      message: `${rows[0].email} promoted to ${role}.`,
    });
  } catch (err) {
    console.error('Promote error:', err.message);
    res.status(500).json({ error: 'Could not update role.' });
  }
});

// ── GET /admin/users ──────────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, created_at, last_seen_at
     FROM users ORDER BY created_at DESC LIMIT 100`
  );
  res.json({ users: rows });
});

// ── GET /admin/stats ──────────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  const [users, businesses, deals, redemptions] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM users'),
    pool.query('SELECT COUNT(*) FROM businesses'),
    pool.query('SELECT COUNT(*) FROM deals'),
    pool.query('SELECT COUNT(*) FROM redemptions'),
  ]);
  res.json({
    users:        parseInt(users.rows[0].count),
    businesses:   parseInt(businesses.rows[0].count),
    deals:        parseInt(deals.rows[0].count),
    redemptions:  parseInt(redemptions.rows[0].count),
  });
});

// ── POST /admin/seed ──────────────────────────────────────────────────────────
// Body: { lat, lng, ownerEmail }
// Inserts a handful of demo businesses + deals centred on lat/lng.
// ownerEmail must already exist in the users table.
router.post('/seed', requireAdmin, async (req, res) => {
  const { lat, lng, ownerEmail } = req.body;

  if (!lat || !lng || !ownerEmail) {
    return res.status(400).json({ error: 'lat, lng and ownerEmail are required.' });
  }

  try {
    // Get owner
    const { rows: ownerRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [ownerEmail.toLowerCase().trim()]
    );
    if (!ownerRows[0]) return res.status(404).json({ error: 'ownerEmail not found in users table.' });
    const ownerId = ownerRows[0].id;

    // Upgrade owner to business role
    await pool.query(`UPDATE users SET role = 'business' WHERE id = $1`, [ownerId]);

    // Seed businesses with small lat/lng offsets (~100-500m away)
    const businesses = [
      { name: 'The Daily Grind Coffee',  category: 'food',          address: '12 Main St',      dLat:  0.0008, dLng:  0.0012 },
      { name: 'Slice & Dice Pizzeria',   category: 'food',          address: '45 Oak Ave',      dLat: -0.0015, dLng:  0.0005 },
      { name: 'FitZone Gym',             category: 'fitness',       address: '88 Park Blvd',    dLat:  0.0020, dLng: -0.0010 },
      { name: 'Neon Nails Studio',       category: 'beauty',        address: '3 Bloom Lane',    dLat: -0.0005, dLng: -0.0018 },
      { name: 'The Bookish Corner',      category: 'retail',        address: '200 River Rd',    dLat:  0.0030, dLng:  0.0022 },
      { name: 'Taco Loco',               category: 'food',          address: '17 Fiesta Way',   dLat: -0.0025, dLng:  0.0030 },
      { name: 'Zen Spa & Wellness',      category: 'beauty',        address: '9 Lotus Court',   dLat:  0.0010, dLng: -0.0025 },
      { name: 'Burger Republic',         category: 'food',          address: '55 Liberty St',   dLat: -0.0040, dLng: -0.0005 },
    ];

    const deals = [
      { bizIdx: 0, emoji: '☕', title: '20% off any coffee',          desc: 'All sizes, all day.',                  type: 'percent',   value: 20, days: 14 },
      { bizIdx: 0, emoji: '🥐', title: 'Free pastry with any drink',  desc: 'Selected pastries only.',              type: 'free_item', value: 1,  days: 7  },
      { bizIdx: 1, emoji: '🍕', title: 'Buy one pizza, get one 50%',  desc: 'Same or lesser value.',                type: 'percent',   value: 50, days: 10 },
      { bizIdx: 2, emoji: '💪', title: 'Free day pass',               desc: 'One visit, no strings.',               type: 'free_item', value: 1,  days: 30 },
      { bizIdx: 2, emoji: '🏋️', title: '30% off first month',         desc: 'New members only.',                   type: 'percent',   value: 30, days: 21 },
      { bizIdx: 3, emoji: '💅', title: '$10 off any manicure',        desc: 'Book in-store or by phone.',           type: 'fixed',     value: 10, days: 14 },
      { bizIdx: 4, emoji: '📚', title: '15% off all paperbacks',      desc: 'Weekends only.',                       type: 'percent',   value: 15, days: 60 },
      { bizIdx: 5, emoji: '🌮', title: '3 tacos for the price of 2',  desc: 'Any filling, any day.',                type: 'free_item', value: 1,  days: 7  },
      { bizIdx: 6, emoji: '🧖', title: '25% off any massage',         desc: '60 or 90 minute sessions.',            type: 'percent',   value: 25, days: 21 },
      { bizIdx: 7, emoji: '🍔', title: 'Free upgrade to large combo', desc: 'With any burger purchase.',            type: 'free_item', value: 1,  days: 5  },
    ];

    const insertedBiz = [];
    for (const b of businesses) {
      const { rows } = await pool.query(
        `INSERT INTO businesses (owner_id, name, category, address, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ownerId, b.name, b.category, b.address, lat + b.dLat, lng + b.dLng]
      );
      insertedBiz.push(rows[0]);
    }

    const now = new Date();
    const insertedDeals = [];
    for (const d of deals) {
      const expires = new Date(now.getTime() + d.days * 24 * 60 * 60 * 1000);
      const { rows } = await pool.query(
        `INSERT INTO deals
           (business_id, title, description, emoji, category, discount_type,
            discount_value, expires_at, active, remaining_redemptions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,NULL) RETURNING *`,
        [
          insertedBiz[d.bizIdx].id,
          d.title, d.desc, d.emoji,
          insertedBiz[d.bizIdx].category,
          d.type, d.value,
          expires.toISOString(),
        ]
      );
      insertedDeals.push(rows[0]);
    }

    res.status(201).json({
      message:    `Seeded ${insertedBiz.length} businesses and ${insertedDeals.length} deals.`,
      businesses: insertedBiz.length,
      deals:      insertedDeals.length,
    });
  } catch (err) {
    console.error('Seed error:', err.message);
    res.status(500).json({ error: 'Seeding failed: ' + err.message });
  }
});

module.exports = router;
