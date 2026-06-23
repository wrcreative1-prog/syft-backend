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

// ── POST /api/businesses/verify-code  (owner — merchant types in consumer code) ─
router.post('/verify-code', requireBusiness, async (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Please enter a code.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT rc.id, rc.deal_id, rc.user_id, rc.expires_at, rc.used_at,
              d.title AS deal_title, d.emoji AS deal_emoji,
              d.remaining_redemptions,
              u.display_name AS customer_name, u.email AS customer_email
       FROM redemption_codes rc
       JOIN deals      d  ON rc.deal_id    = d.id
       JOIN businesses b  ON d.business_id = b.id
       JOIN users      u  ON rc.user_id    = u.id
       WHERE rc.code = $1 AND b.owner_id = $2
       FOR UPDATE OF rc`,
      [code, req.user.sub]
    );

    const r = rows[0];
    if (!r) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Code not found. Double-check and try again.' });
    }
    if (r.used_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This code has already been used.' });
    }
    if (new Date(r.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Code expired — customer needs to generate a new one.' });
    }

    await client.query('UPDATE redemption_codes SET used_at = NOW() WHERE id = $1', [r.id]);
    await client.query(
      'INSERT INTO redemptions (deal_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [r.deal_id, r.user_id]
    );
    if (r.remaining_redemptions !== null) {
      await client.query(
        'UPDATE deals SET remaining_redemptions = remaining_redemptions - 1 WHERE id = $1',
        [r.deal_id]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok:       true,
      deal:     { id: r.deal_id, title: r.deal_title, emoji: r.deal_emoji },
      customer: { name: r.customer_name || 'Customer', email: r.customer_email },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Already redeemed.' });
    console.error('Verify code error:', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  } finally {
    client.release();
  }
});

// ── GET /api/businesses/analytics  (owner — macro funnel across all deals) ────
// Query param: period = '7d' | '30d' | 'all'  (default 'all')
router.get('/analytics', requireBusiness, async (req, res) => {
  const period = req.query.period || 'all';
  const since  = period === '7d'  ? "NOW() - INTERVAL '7 days'"
               : period === '30d' ? "NOW() - INTERVAL '30 days'"
               : "'-infinity'::timestamptz";

  try {
    // Per-deal funnel + rating summary
    const { rows: deals } = await pool.query(
      `SELECT
         d.id,
         d.title,
         d.emoji,
         d.active,
         d.expires_at,
         d.discount_type,
         d.discount_value,
         d.created_at,
         COUNT(DISTINCT CASE WHEN de.event_type='seen'   AND de.occurred_at >= ${since} THEN de.id END)::int  AS seen_count,
         COUNT(DISTINCT CASE WHEN de.event_type='opened' AND de.occurred_at >= ${since} THEN de.id END)::int  AS opened_count,
         COUNT(DISTINCT CASE WHEN sd.saved_at  >= ${since} THEN sd.user_id END)::int                          AS clipped_count,
         COUNT(DISTINCT CASE WHEN r.redeemed_at >= ${since} THEN r.user_id END)::int                          AS redeemed_count,
         ROUND(AVG(dr.rating), 1)::float                  AS avg_rating,
         COUNT(DISTINCT dr.id)::int                       AS rating_count
       FROM deals d
       JOIN businesses b ON d.business_id = b.id
       LEFT JOIN deal_events  de ON de.deal_id  = d.id
       LEFT JOIN saved_deals  sd ON sd.deal_id  = d.id
       LEFT JOIN redemptions  r  ON r.deal_id   = d.id
       LEFT JOIN deal_ratings dr ON dr.deal_id  = d.id
       WHERE b.owner_id = $1
       GROUP BY d.id
       ORDER BY d.created_at DESC`,
      [req.user.sub]
    );

    // Totals across all deals
    const totals = deals.reduce((acc, d) => ({
      seen:      acc.seen      + d.seen_count,
      opened:    acc.opened    + d.opened_count,
      clipped:   acc.clipped   + d.clipped_count,
      redeemed:  acc.redeemed  + d.redeemed_count,
    }), { seen: 0, opened: 0, clipped: 0, redeemed: 0 });

    res.json({ totals, deals });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: 'Could not load analytics.' });
  }
});

// ── GET /api/businesses/analytics/:dealId  (owner — micro funnel for one deal) ─
router.get('/analytics/:dealId', requireBusiness, async (req, res) => {
  const period = req.query.period || 'all';
  const since  = period === '7d'  ? "NOW() - INTERVAL '7 days'"
               : period === '30d' ? "NOW() - INTERVAL '30 days'"
               : "'-infinity'::timestamptz";

  try {
    // Verify ownership
    const { rows: own } = await pool.query(
      `SELECT d.id FROM deals d JOIN businesses b ON d.business_id = b.id
       WHERE d.id = $1 AND b.owner_id = $2`,
      [req.params.dealId, req.user.sub]
    );
    if (!own[0]) return res.status(403).json({ error: 'Not found or not authorised.' });

    const { rows: funnel } = await pool.query(
      `SELECT
         COUNT(DISTINCT CASE WHEN de.event_type='seen'   AND de.occurred_at >= ${since} THEN de.id END)::int  AS seen_count,
         COUNT(DISTINCT CASE WHEN de.event_type='opened' AND de.occurred_at >= ${since} THEN de.id END)::int  AS opened_count,
         COUNT(DISTINCT CASE WHEN sd.saved_at  >= ${since} THEN sd.user_id END)::int                          AS clipped_count,
         COUNT(DISTINCT CASE WHEN r.redeemed_at >= ${since} THEN r.user_id END)::int                          AS redeemed_count
       FROM deals d
       LEFT JOIN deal_events  de ON de.deal_id  = d.id
       LEFT JOIN saved_deals  sd ON sd.deal_id  = d.id
       LEFT JOIN redemptions  r  ON r.deal_id   = d.id
       WHERE d.id = $1`,
      [req.params.dealId]
    );

    // Ratings breakdown
    const { rows: ratings } = await pool.query(
      `SELECT
         ROUND(AVG(rating), 1)::float                      AS avg_rating,
         COUNT(*)::int                                      AS total,
         COUNT(CASE WHEN rating=5 THEN 1 END)::int         AS five,
         COUNT(CASE WHEN rating=4 THEN 1 END)::int         AS four,
         COUNT(CASE WHEN rating=3 THEN 1 END)::int         AS three,
         COUNT(CASE WHEN rating=2 THEN 1 END)::int         AS two,
         COUNT(CASE WHEN rating=1 THEN 1 END)::int         AS one
       FROM deal_ratings WHERE deal_id = $1`,
      [req.params.dealId]
    );

    const { rows: comments } = await pool.query(
      `SELECT rating, comment, rated_at FROM deal_ratings
       WHERE deal_id = $1 AND comment IS NOT NULL AND comment <> ''
       ORDER BY rated_at DESC LIMIT 10`,
      [req.params.dealId]
    );

    res.json({ funnel: funnel[0], ratings: { ...ratings[0], comments } });
  } catch (err) {
    console.error('Micro analytics error:', err.message);
    res.status(500).json({ error: 'Could not load deal analytics.' });
  }
});

module.exports = router;
