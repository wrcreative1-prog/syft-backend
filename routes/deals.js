const express  = require('express');
const pool     = require('../db/pool');
const { authenticate, requireBusiness } = require('../middleware/authenticate');

const router = express.Router();

// ── GET /api/deals/nearby ─────────────────────────────────────────────────────
router.get('/nearby', async (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = Math.min(parseFloat(req.query.radius) || 2000, 10000);
  const limit  = Math.min(parseInt(req.query.limit)   || 50,   100);

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng query params are required.' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         d.id,
         d.title,
         d.description,
         d.emoji,
         d.category,
         d.discount_type,
         d.discount_value,
         d.walk_in_upsell_message,
         d.expires_at,
         d.remaining_redemptions,
         b.id            AS business_id,
         b.name          AS business_name,
         b.address,
         b.lat,
         b.lng,
         ROUND(
           6371000 * acos(
             LEAST(1.0,
               cos(radians($1)) * cos(radians(b.lat))
               * cos(radians(b.lng) - radians($2))
               + sin(radians($1)) * sin(radians(b.lat))
             )
           )
         )::int          AS distance_m
       FROM deals d
       JOIN businesses b ON d.business_id = b.id
       WHERE d.active    = TRUE
         AND d.expires_at > NOW()
         AND (d.remaining_redemptions IS NULL OR d.remaining_redemptions > 0)
         AND b.lat BETWEEN $1 - ($3 / 111000.0) AND $1 + ($3 / 111000.0)
         AND b.lng BETWEEN $2 - ($3 / (111000.0 * cos(radians($1)))) AND $2 + ($3 / (111000.0 * cos(radians($1))))
       ORDER BY distance_m ASC
       LIMIT $4`,
      [lat, lng, radius, limit]
    );

    res.json({ deals: rows, count: rows.length });
  } catch (err) {
    console.error('Nearby deals error:', err.message);
    res.status(500).json({ error: 'Could not fetch deals.' });
  }
});

// ── GET /api/deals/mine  (business owner — all deals for my businesses) ──────
router.get('/mine', requireBusiness, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, b.name AS business_name
       FROM deals d
       JOIN businesses b ON d.business_id = b.id
       WHERE b.owner_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.sub]
    );
    res.json({ deals: rows });
  } catch (err) {
    console.error('Get my deals error:', err.message);
    res.status(500).json({ error: 'Could not fetch your deals.' });
  }
});

// ── GET /api/deals/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, b.name AS business_name, b.address, b.lat, b.lng
       FROM deals d JOIN businesses b ON d.business_id = b.id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Deal not found.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch deal.' });
  }
});

// ── POST /api/deals  (business only) ─────────────────────────────────────────
router.post('/', requireBusiness, async (req, res) => {
  const {
    businessId, title, description, emoji, category,
    discountType, discountValue, walkInUpsellMessage,
    expiresAt, remainingRedemptions,
  } = req.body;

  if (!businessId || !title || !discountType || !discountValue || !expiresAt) {
    return res.status(400).json({ error: 'businessId, title, discountType, discountValue, and expiresAt are required.' });
  }

  const bizCheck = await pool.query(
    'SELECT id FROM businesses WHERE id = $1 AND owner_id = $2',
    [businessId, req.user.sub]
  );
  if (!bizCheck.rows[0]) {
    return res.status(403).json({ error: 'You do not own this business.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO deals
         (business_id, title, description, emoji, category, discount_type,
          discount_value, walk_in_upsell_message, expires_at, remaining_redemptions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        businessId, title, description || null, emoji || '🏷️',
        category || 'other', discountType, discountValue,
        walkInUpsellMessage || null, expiresAt,
        remainingRedemptions || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create deal error:', err.message);
    res.status(500).json({ error: 'Could not create deal.' });
  }
});

// ── PATCH /api/deals/:id  (business only) ────────────────────────────────────
router.patch('/:id', requireBusiness, async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT d.id FROM deals d
     JOIN businesses b ON d.business_id = b.id
     WHERE d.id = $1 AND b.owner_id = $2`,
    [req.params.id, req.user.sub]
  );
  if (!existing[0]) return res.status(403).json({ error: 'Not authorised to edit this deal.' });

  const fields = ['title','description','emoji','category','discount_type',
                  'discount_value','walk_in_upsell_message','expires_at',
                  'remaining_redemptions','active'];
  const keys   = Object.keys(req.body).filter(k => fields.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'No valid fields to update.' });

  const setClauses = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
  const values     = keys.map(k => req.body[k]);

  try {
    const { rows } = await pool.query(
      `UPDATE deals SET ${setClauses} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Update deal error:', err.message);
    res.status(500).json({ error: 'Could not update deal.' });
  }
});

// ── DELETE /api/deals/:id  (business only) ───────────────────────────────────
router.delete('/:id', requireBusiness, async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM deals USING businesses
     WHERE deals.id = $1
       AND deals.business_id = businesses.id
       AND businesses.owner_id = $2
     RETURNING deals.id`,
    [req.params.id, req.user.sub]
  );
  if (!rows[0]) return res.status(403).json({ error: 'Not authorised or deal not found.' });
  res.json({ deleted: rows[0].id });
});

// ── POST /api/deals/:id/redeem  (authenticated users) ────────────────────────
router.post('/:id/redeem', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: dealRows } = await client.query(
      `SELECT id, remaining_redemptions FROM deals
       WHERE id = $1 AND active = TRUE AND expires_at > NOW()
       FOR UPDATE`,
      [req.params.id]
    );
    const deal = dealRows[0];
    if (!deal) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Deal not found or no longer active.' });
    }
    if (deal.remaining_redemptions !== null && deal.remaining_redemptions <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This deal has no redemptions remaining.' });
    }
    await client.query(
      'INSERT INTO redemptions (deal_id, user_id) VALUES ($1, $2)',
      [req.params.id, req.user.sub]
    );
    if (deal.remaining_redemptions !== null) {
      await client.query(
        'UPDATE deals SET remaining_redemptions = remaining_redemptions - 1 WHERE id = $1',
        [req.params.id]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, dealId: req.params.id });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already redeemed this deal.' });
    }
    console.error('Redeem error:', err.message);
    res.status(500).json({ error: 'Redemption failed.' });
  } finally {
    client.release();
  }
});

// ── GET /api/deals/saved/list  (authenticated) ────────────────────────────────
router.get('/saved/list', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, b.name AS business_name, b.lat, b.lng, s.saved_at
       FROM saved_deals s
       JOIN deals d ON s.deal_id = d.id
       JOIN businesses b ON d.business_id = b.id
       WHERE s.user_id = $1
       ORDER BY s.saved_at DESC`,
      [req.user.sub]
    );
    res.json({ deals: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch saved deals.' });
  }
});

// ── POST /api/deals/:id/save  (authenticated) ─────────────────────────────────
router.post('/:id/save', authenticate, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO saved_deals (deal_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.sub]
    );
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save deal.' });
  }
});

// ── DELETE /api/deals/:id/save  (authenticated) ───────────────────────────────
router.delete('/:id/save', authenticate, async (req, res) => {
  await pool.query(
    'DELETE FROM saved_deals WHERE deal_id = $1 AND user_id = $2',
    [req.params.id, req.user.sub]
  );
  res.json({ saved: false });
});

module.exports = router;
