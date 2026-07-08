import dotenv from "dotenv";
import path from "path";
import { appError } from "../shared/appLog.js";

// Local-only: try to load .env / .env.local when running tools like db:migrate.
// In Vercel Lambdas these files don't exist, so these calls are harmless no-ops.
const cwd = process.cwd();
dotenv.config({ path: path.join(cwd, ".env") });
dotenv.config({ path: path.join(cwd, ".env.local") });
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Fail fast on the server side so misconfiguration is obvious in logs.
  throw new Error(
    "DATABASE_URL is not set. Configure it in ./.env for the current Neon branch.",
  );
}

export const sql = neon(connectionString);

async function runSchemaMigrations() {
  // users table
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      telegram_username   TEXT PRIMARY KEY,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at       TIMESTAMPTZ,
      last_tma_seen_at    TIMESTAMPTZ,
      locale              TEXT,
      time_zone           TEXT,
      default_wallet      BIGINT
    );
  `;

  await sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS feed_welcome_bundle_delivered_at TIMESTAMPTZ;
  `;

  await sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
  `;

  // wallets table
  await sql`
    CREATE TABLE IF NOT EXISTS wallets (
      id                    BIGSERIAL PRIMARY KEY,
      telegram_username     TEXT NOT NULL REFERENCES users(telegram_username),
      wallet_address        TEXT NOT NULL,
      wallet_blockchain     TEXT NOT NULL,
      wallet_net            TEXT NOT NULL,
      type                  TEXT NOT NULL,
      label                 TEXT,
      is_default            BOOLEAN NOT NULL DEFAULT FALSE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at          TIMESTAMPTZ,
      last_seen_balance_at  TIMESTAMPTZ,
      source                TEXT,
      notes                 TEXT,
      UNIQUE (telegram_username, wallet_address, wallet_blockchain, wallet_net)
    );
  `;

  // pending_transactions table
  await sql`
    CREATE TABLE IF NOT EXISTS pending_transactions (
      id                TEXT PRIMARY KEY,
      telegram_username TEXT NOT NULL REFERENCES users(telegram_username),
      wallet_address    TEXT NOT NULL,
      wallet_blockchain TEXT NOT NULL,
      wallet_net        TEXT NOT NULL,
      payload           JSONB NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Helpful indexes
  await sql`
    CREATE INDEX IF NOT EXISTS idx_wallets_user
      ON wallets(telegram_username);
  `;

  // Wallet secret: AES-GCM payload (Neon) + DEK wrapped by Cloud KMS (not plaintext mnemonic).
  await sql`
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS envelope_ciphertext TEXT;
  `;
  await sql`
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS envelope_nonce TEXT;
  `;
  await sql`
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS wrapped_dek TEXT;
  `;
  await sql`
    ALTER TABLE wallets ADD COLUMN IF NOT EXISTS envelope_alg TEXT;
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pending_tx_user
      ON pending_transactions(telegram_username);
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pending_tx_status
      ON pending_transactions(status);
  `;

  // messages table (AI: bot + TMA)
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id                  BIGSERIAL PRIMARY KEY,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      telegram_username   TEXT NOT NULL REFERENCES users(telegram_username),
      thread_id           BIGINT NOT NULL,
      type                TEXT NOT NULL CHECK (type IN ('bot', 'app')),
      role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content             TEXT,
      telegram_update_id  BIGINT
    );
  `;

  await sql`
    DO $rename_messages_user_col$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'messages'
          AND column_name = 'user_telegram'
      ) THEN
        ALTER TABLE messages RENAME COLUMN user_telegram TO telegram_username;
      END IF;
    END $rename_messages_user_col$;
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(telegram_username, thread_id, type, created_at);
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_bot_update_id
      ON messages(telegram_username, thread_id, type, telegram_update_id)
      WHERE telegram_update_id IS NOT NULL;
  `;

  // Telegram OIDC/browser login attempts (state/nonce/PKCE replay protection).
  await sql`
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      id                  TEXT PRIMARY KEY,
      provider            TEXT NOT NULL,
      state_hash          TEXT NOT NULL UNIQUE,
      nonce_hash          TEXT NOT NULL,
      pkce_verifier       TEXT NOT NULL,
      redirect_uri        TEXT NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('created', 'consumed', 'expired', 'failed')),
      ip                  TEXT,
      user_agent          TEXT,
      error_code          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ NOT NULL,
      consumed_at         TIMESTAMPTZ
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_status_exp
      ON auth_login_attempts(status, expires_at);
  `;

  // Stable external auth mapping (Telegram subject -> local username).
  await sql`
    CREATE TABLE IF NOT EXISTS auth_identities (
      id                  BIGSERIAL PRIMARY KEY,
      provider            TEXT NOT NULL,
      provider_subject    TEXT NOT NULL,
      telegram_username   TEXT NOT NULL REFERENCES users(telegram_username),
      telegram_id         TEXT,
      username            TEXT,
      display_name        TEXT,
      picture_url         TEXT,
      phone_number        TEXT,
      claims_version      TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at       TIMESTAMPTZ
    );
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_subject
      ON auth_identities(provider, provider_subject);
  `;

  // Auditable auth lifecycle events (no token bodies).
  await sql`
    CREATE TABLE IF NOT EXISTS auth_login_events (
      id                  BIGSERIAL PRIMARY KEY,
      attempt_id          TEXT,
      provider            TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      telegram_username   TEXT,
      provider_subject    TEXT,
      request_id          TEXT,
      ip                  TEXT,
      user_agent          TEXT,
      meta_json           JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_login_events_attempt
      ON auth_login_events(attempt_id, created_at);
  `;

  // Browser/app session store (cookie token hash -> telegram username).
  await sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_hash        TEXT PRIMARY KEY,
      telegram_username   TEXT NOT NULL REFERENCES users(telegram_username),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at          TIMESTAMPTZ NOT NULL,
      last_seen_at        TIMESTAMPTZ,
      ip                  TEXT,
      user_agent          TEXT
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp
      ON auth_sessions(expires_at);
  `;

  // Feed catalogue + per-user timeline + interaction events (see texts/feed-messages-architecture.md).
  await sql`
    CREATE TABLE IF NOT EXISTS feed_default_messages (
      id                BIGSERIAL PRIMARY KEY,
      key               TEXT NOT NULL,
      locale            TEXT NOT NULL,
      kind              TEXT NOT NULL,
      message_variant   TEXT NOT NULL,
      body              JSONB NOT NULL,
      segment_rules     JSONB,
      version           INTEGER NOT NULL DEFAULT 1,
      active_from       TIMESTAMPTZ,
      active_to         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_default_messages_key_locale
      ON feed_default_messages(key, locale);
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_default_messages_active
      ON feed_default_messages(kind, active_from, active_to);

  `;

  await sql`
    CREATE TABLE IF NOT EXISTS feed_items (
      id                         BIGSERIAL PRIMARY KEY,
      telegram_username          TEXT NOT NULL REFERENCES users(telegram_username),
      created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at                    TIMESTAMPTZ,
      source_type                TEXT NOT NULL,
      card_type                  TEXT NOT NULL,
      layout_variant             TEXT,
      default_message_id         BIGINT REFERENCES feed_default_messages(id) ON DELETE SET NULL,
      source_id                  TEXT,
      payload                    JSONB NOT NULL,
      read_at                    TIMESTAMPTZ,
      dismissed_at               TIMESTAMPTZ,
      cta                        JSONB,
      feed_item_interactions     JSONB
    );
  `;

  await sql`
    ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS cta JSONB;

  `;

  await sql`
    ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS feed_item_interactions JSONB;

  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_items_user_sent
      ON feed_items(telegram_username, sent_at DESC NULLS LAST, created_at DESC);
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_items_user_created
      ON feed_items(telegram_username, created_at DESC);
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_items_default_message
      ON feed_items(default_message_id)
      WHERE default_message_id IS NOT NULL;

  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_feed_items_user_default_message
      ON feed_items(telegram_username, default_message_id)
      WHERE default_message_id IS NOT NULL;

  `;

  await sql`
    CREATE TABLE IF NOT EXISTS feed_item_interactions (
      id                  BIGSERIAL PRIMARY KEY,
      feed_item_id        BIGINT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
      telegram_username   TEXT NOT NULL REFERENCES users(telegram_username),
      event_type          TEXT NOT NULL,
      event_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_item_interactions_item
      ON feed_item_interactions(feed_item_id, created_at);

  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_feed_item_interactions_user
      ON feed_item_interactions(telegram_username, created_at);

  `;

  // Telegram client message sync (TDLib gateway); connection flag only — chat list lives in gateway memory.
  await sql`
    CREATE TABLE IF NOT EXISTS telegram_messages_connections (
      telegram_username   TEXT PRIMARY KEY REFERENCES users(telegram_username),
      status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'revoked')),
      connected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at          TIMESTAMPTZ
    );
  `;

  await sql`DROP TABLE IF EXISTS telegram_threads CASCADE;`;

  await sql`
    CREATE TABLE IF NOT EXISTS telegram_mtproto_sessions (
      telegram_username     TEXT PRIMARY KEY REFERENCES users(telegram_username),
      telegram_user_id      BIGINT,
      status                TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'revoked', 'pending')),
      tdlib_db_path         TEXT NOT NULL,
      connected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at            TIMESTAMPTZ,
      last_sync_at          TIMESTAMPTZ
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS app_deploy_version (
      id      INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INT NOT NULL DEFAULT 0
    );
  `;
  await sql`
    INSERT INTO app_deploy_version (id, version)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;
  `;
}

let schemaInitPromise: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = runSchemaMigrations().catch((err) => {
      appError("[db]", "schema_init_failed", undefined, err);
      schemaInitPromise = null;
      throw err;
    });
  }
  return schemaInitPromise;
}

// Schema runs at deploy via `npm run db:migrate` in buildCommand. No schema work
// in the request path — keeps /api/telegram and other routes fast (no 504).

