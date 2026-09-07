/**
 * Wallet helpers for the wallets table.
 * Shared by API routes and bot-side services.
 */
import { sql } from './start.js';
import { normalizeUsername } from './users.js';

export type WalletRow = {
  id: number;
  telegram_username: string;
  wallet_address: string;
  wallet_blockchain: string;
  wallet_net: string;
  type: string;
  label: string | null;
  is_default: boolean;
  source: string | null;
  notes: string | null;
  /** base64 AES-GCM ciphertext (includes auth tag) — mnemonic JSON, see walletEnvelopeClient */
  envelope_ciphertext: string | null;
  /** base64 12-byte IV */
  envelope_nonce: string | null;
  /** base64 KMS-wrapped DEK */
  wrapped_dek: string | null;
  /** e.g. aes-256-gcm-v1 */
  envelope_alg: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  last_seen_balance_at: string | null;
};

export type RegisterWalletInput = {
  telegramUsername: string;
  walletAddress: string;
  walletBlockchain: string;
  walletNet: string;
  type: string;
  label?: string | null;
  source?: string | null;
  notes?: string | null;
  isDefault?: boolean;
  /** Server fills after KMS wrap — pass from API handler */
  envelopeCiphertextB64?: string | null;
  envelopeNonceB64?: string | null;
  wrappedDekB64?: string | null;
  envelopeAlg?: string | null;
};

function normalizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function normalizeLower(raw: unknown): string {
  return normalizeText(raw).toLowerCase();
}

function normalizeAddress(raw: unknown): string {
  return normalizeText(raw);
}

export async function listWalletsByUsername(
  telegramUsername: string,
): Promise<WalletRow[]> {
  const username = normalizeUsername(telegramUsername);
  if (!username) return [];

  const rows = (await sql`
    SELECT
      id,
      telegram_username,
      wallet_address,
      wallet_blockchain,
      wallet_net,
      type,
      label,
      is_default,
      source,
      notes,
      envelope_ciphertext,
      envelope_nonce,
      wrapped_dek,
      envelope_alg,
      created_at,
      updated_at,
      last_used_at,
      last_seen_balance_at
    FROM wallets
    WHERE telegram_username = ${username}
    ORDER BY is_default DESC, created_at ASC;
  `) as WalletRow[];
  return rows;
}

export async function getDefaultWalletByUsername(
  telegramUsername: string,
): Promise<WalletRow | null> {
  const username = normalizeUsername(telegramUsername);
  if (!username) return null;

  const rows = (await sql`
    SELECT
      id,
      telegram_username,
      wallet_address,
      wallet_blockchain,
      wallet_net,
      type,
      label,
      is_default,
      source,
      notes,
      envelope_ciphertext,
      envelope_nonce,
      wrapped_dek,
      envelope_alg,
      created_at,
      updated_at,
      last_used_at,
      last_seen_balance_at
    FROM wallets
    WHERE telegram_username = ${username}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1;
  `) as WalletRow[];

  return rows[0] ?? null;
}

export async function setDefaultWallet(opts: {
  telegramUsername: string;
  walletAddress: string;
  walletBlockchain: string;
  walletNet: string;
}): Promise<WalletRow | null> {
  const username = normalizeUsername(opts.telegramUsername);
  const walletAddress = normalizeAddress(opts.walletAddress);
  const walletBlockchain = normalizeLower(opts.walletBlockchain);
  const walletNet = normalizeLower(opts.walletNet);

  if (!username || !walletAddress || !walletBlockchain || !walletNet) {
    return null;
  }

  await sql`
    UPDATE wallets
    SET is_default = FALSE,
        updated_at = NOW()
    WHERE telegram_username = ${username};
  `;

  const rows = (await sql`
    UPDATE wallets
    SET is_default = TRUE,
        updated_at = NOW()
    WHERE telegram_username = ${username}
      AND wallet_address = ${walletAddress}
      AND wallet_blockchain = ${walletBlockchain}
      AND wallet_net = ${walletNet}
    RETURNING
      id,
      telegram_username,
      wallet_address,
      wallet_blockchain,
      wallet_net,
      type,
      label,
      is_default,
      source,
      notes,
      envelope_ciphertext,
      envelope_nonce,
      wrapped_dek,
      envelope_alg,
      created_at,
      updated_at,
      last_used_at,
      last_seen_balance_at;
  `) as WalletRow[];

  const selected = rows[0] ?? null;
  if (!selected) return null;

  await sql`
    UPDATE users
    SET default_wallet = ${selected.id},
        updated_at = NOW()
    WHERE telegram_username = ${username};
  `;

  return selected;
}

export async function registerWallet(
  input: RegisterWalletInput,
): Promise<WalletRow | null> {
  const telegramUsername = normalizeUsername(input.telegramUsername);
  const walletAddress = normalizeAddress(input.walletAddress);
  const walletBlockchain = normalizeLower(input.walletBlockchain);
  const walletNet = normalizeLower(input.walletNet);
  const walletType = normalizeLower(input.type);
  const label = normalizeText(input.label ?? '');
  const source = normalizeText(input.source ?? '');
  const notes = normalizeText(input.notes ?? '');
  const envelopeCiphertext = normalizeText(input.envelopeCiphertextB64 ?? '');
  const envelopeNonce = normalizeText(input.envelopeNonceB64 ?? '');
  const wrappedDek = normalizeText(input.wrappedDekB64 ?? '');
  const envelopeAlg = normalizeText(input.envelopeAlg ?? '') || 'aes-256-gcm-v1';

  if (
    !telegramUsername ||
    !walletAddress ||
    !walletBlockchain ||
    !walletNet ||
    !walletType
  ) {
    return null;
  }

  const rows = (await sql`
    INSERT INTO wallets (
      telegram_username,
      wallet_address,
      wallet_blockchain,
      wallet_net,
      type,
      label,
      source,
      notes,
      envelope_ciphertext,
      envelope_nonce,
      wrapped_dek,
      envelope_alg,
      is_default,
      created_at,
      updated_at
    )
    VALUES (
      ${telegramUsername},
      ${walletAddress},
      ${walletBlockchain},
      ${walletNet},
      ${walletType},
      ${label || null},
      ${source || null},
      ${notes || null},
      ${envelopeCiphertext || null},
      ${envelopeNonce || null},
      ${wrappedDek || null},
      ${envelopeCiphertext && envelopeNonce && wrappedDek ? envelopeAlg : null},
      FALSE,
      NOW(),
      NOW()
    )
    ON CONFLICT (telegram_username, wallet_address, wallet_blockchain, wallet_net)
    DO UPDATE SET
      type = EXCLUDED.type,
      label = EXCLUDED.label,
      source = EXCLUDED.source,
      notes = EXCLUDED.notes,
      envelope_ciphertext = EXCLUDED.envelope_ciphertext,
      envelope_nonce = EXCLUDED.envelope_nonce,
      wrapped_dek = EXCLUDED.wrapped_dek,
      envelope_alg = EXCLUDED.envelope_alg,
      updated_at = NOW()
    RETURNING
      id,
      telegram_username,
      wallet_address,
      wallet_blockchain,
      wallet_net,
      type,
      label,
      is_default,
      source,
      notes,
      envelope_ciphertext,
      envelope_nonce,
      wrapped_dek,
      envelope_alg,
      created_at,
      updated_at,
      last_used_at,
      last_seen_balance_at;
  `) as WalletRow[];

  const wallet = rows[0] ?? null;
  if (!wallet) return null;

  if (input.isDefault) {
    return setDefaultWallet({
      telegramUsername,
      walletAddress,
      walletBlockchain,
      walletNet,
    });
  }

  const currentDefault = await getDefaultWalletByUsername(telegramUsername);
  if (!currentDefault) {
    return setDefaultWallet({
      telegramUsername,
      walletAddress,
      walletBlockchain,
      walletNet,
    });
  }

  return wallet;
}

/** Resolve telegram usernames that registered a given wallet address (any chain/net). */
export async function findUsernamesByWalletAddress(
  walletAddress: string,
): Promise<string[]> {
  const address = normalizeAddress(walletAddress);
  if (!address) return [];
  const rows = (await sql`
    SELECT DISTINCT telegram_username
    FROM wallets
    WHERE lower(wallet_address) = lower(${address})
    ORDER BY telegram_username ASC
    LIMIT 50;
  `) as Array<{ telegram_username?: unknown }>;
  const out: string[] = [];
  for (const row of rows) {
    const u = normalizeUsername(row.telegram_username);
    if (u) out.push(u);
  }
  return out;
}
