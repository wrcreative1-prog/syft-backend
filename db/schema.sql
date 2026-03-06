-- ══════════════════════════════════════════════════════════════
-- Syft database schema
-- Run once against your PostgreSQL database:
--   psql $DATABASE_URL -f db/schema.sql
-- Requires the PostGIS extension (pre-installed on Railway's PG).
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── Users ─────────────────────────────────────────────────────
-- One row per person. apple_sub / google_sub are OAuth provider IDs.
-- password_hash is NULL for social-login users.
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT        UNIQUE,
  password_hash   TEXT,
  apple_sub       TEXT        UNIQUE,
  google_sub      TEXT        UNIQUE,
  display_name    TEXT,
  role            TEXT        NOT NULL DEFAULT 'user',  -- 'user' | 'business' | 'admin'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Businesses ────────────────────────────────────────────────
-- Each business is owned by a user (role = 'business').
CREATE TABLE IF NOT EXISTS businesses (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'other',
  address     TEXT,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  -- PostGIS geography column — used for fast radius searches
  location    GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS
                (ST_MakePoint(lng, lat)::geography) STORED,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS businesses_location_idx ON businesses USING GIST (location);

-- ── Deals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deals (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id             UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title                   TEXT        NOT NULL,
  description             TEXT,
  emoji                   TEXT        DEFAULT '🏷️',
  category                TEXT        NOT NULL DEFAULT 'other',
  discount_type           TEXT        NOT NULL DEFAULT 'percent',  -- 'percent' | 'fixed'
  discount_value          NUMERIC     NOT NULL,
  walk_in_upsell_message  TEXT,
  expires_at              TIMESTAMPTZ NOT NULL,
  remaining_redemptions   INTEGER,    -- NULL = unlimited
  active                  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deals_business_id_idx   ON deals (business_id);
CREATE INDEX IF NOT EXISTS deals_expires_active_idx ON deals (expires_at, active);

-- ── Redemptions ───────────────────────────────────────────────
-- Tracks which user redeemed which deal (for wallet / history).
CREATE TABLE IF NOT EXISTS redemptions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id     UUID        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, user_id)   -- one redemption per deal per user
);

CREATE INDEX IF NOT EXISTS redemptions_user_id_idx ON redemptions (user_id);

-- ── Saved deals (wallet) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_deals (
  deal_id     UUID        NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_id, user_id)
);
