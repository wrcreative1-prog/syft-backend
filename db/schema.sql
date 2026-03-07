-- ══════════════════════════════════════════════════════════════
-- Syft database schema
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT        UNIQUE,
  password_hash   TEXT,
  apple_sub       TEXT        UNIQUE,
  google_sub      TEXT        UNIQUE,
  display_name    TEXT,
  role            TEXT        NOT NULL DEFAULT 'user',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Businesses ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS businesses (
  id          UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id    UUID             NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT             NOT NULL,
  category    TEXT             NOT NULL DEFAULT 'other',
  address     TEXT,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS businesses_lat_lng_idx ON businesses (lat, lng);

-- ── Business plan / billing (safe on re-deploy) ───────────────
-- plan values: 'founding' | 'free' | 'pro'
--   founding  → first 20 businesses, free forever, unlimited deals
--   free      → 1 active deal at a time
--   pro       → unlimited deals + analytics (Stripe subscription)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan                   TEXT        NOT NULL DEFAULT 'free';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS founding_number        INTEGER;          -- 1–20, null if not founding
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS subscription_status    TEXT        NOT NULL DEFAULT 'inactive';
-- subscription_status: 'active' | 'inactive' | 'past_due' | 'canceled'

-- ── Deals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id             UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title                   TEXT        NOT NULL,
  description             TEXT,
  emoji                   TEXT        DEFAULT '🏷️',
  category                TEXT        NOT NULL DEFAULT 'other',
  discount_type           TEXT        NOT NULL DEFAULT 'percent',
  discount_value          NUMERIC     NOT NULL,
  walk_in_upsell_message  TEXT,
  expires_at              TIMESTAMPTZ NOT NULL,
  remaining_redemptions   INTEGER,
  active                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deals_business_id_idx   ON deals (business_id);
CREATE INDEX IF NOT EXISTS deals_expires_active_idx ON deals (expires_at, active);

-- Add start_at for scheduled deal windows (safe on re-deploy)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── Ad / boost infrastructure (safe on re-deploy) ─────────────
-- Future ad model: businesses can pay to boost a deal's visibility.
-- Priority score drives sort order in /api/deals/nearby.
-- No UI yet — columns are here so the model is ready when needed.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS boost_active     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS boost_budget     NUMERIC NOT NULL DEFAULT 0;   -- total $ budget allocated
ALTER TABLE deals ADD COLUMN IF NOT EXISTS boost_spent      NUMERIC NOT NULL DEFAULT 0;   -- $ spent so far
ALTER TABLE deals ADD COLUMN IF NOT EXISTS boost_impressions INTEGER NOT NULL DEFAULT 0;  -- times shown in feed/map
ALTER TABLE deals ADD COLUMN IF NOT EXISTS boost_clicks     INTEGER NOT NULL DEFAULT 0;   -- times tapped
ALTER TABLE deals ADD COLUMN IF NOT EXISTS priority_score   NUMERIC NOT NULL DEFAULT 0;
-- priority_score: 0 = organic; >0 = boosted. Nearby query sorts by distance ASC
-- but boosted deals get a bump. Formula (future): boost_budget_remaining * relevance.

-- ── Redemptions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS redemptions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id     UUID        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, user_id)
);

CREATE INDEX IF NOT EXISTS redemptions_user_id_idx ON redemptions (user_id);

-- ── Saved deals (wallet) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_deals (
  deal_id     UUID        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_id, user_id)
);
