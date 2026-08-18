import { getDefaultWalletByUsername } from '../../database/wallets.js';
import { upsertUserFromTma } from '../../database/users.js';
import { authByInitData } from '../wallet/_auth.js';
import { kmsDecrypt } from '../_lib/envelope-crypto.js';
import { decryptWalletPayloadAesGcmV1 } from '../_lib/wallet-envelope-payload.js';
import { appLog } from '../../shared/appLog.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeB64ToBuffer(label: string, value: string): Buffer {
  const t = value.trim();
  if (!t) {
    throw new Error(`missing_${label}`);
  }
  try {
    return Buffer.from(t, 'base64');
  } catch {
    throw new Error(`invalid_${label}_base64`);
  }
}

async function getBody(request: Request): Promise<unknown> {
  if (typeof (request as Request).json === 'function') {
    return (request as Request).json();
  }
  return null;
}

/**
 * POST /api/wallet/envelope-verify
 * Proves Neon row + wrapped_dek round-trip through KMS and AES-GCM.
 * Requires header: x-wallet-envelope-verify-secret: <WALLET_ENVELOPE_VERIFY_SECRET>
 * Body: { "initData": "..." }
 * Response: { ok, plaintext_json_valid, mnemonic_word_count } — never returns mnemonic text.
 */
async function handler(request: Request): Promise<Response> {
  const method = request.method ?? 'GET';
  if (method === 'GET') {
    return jsonResponse(
      {
        ok: true,
        endpoint: 'wallet/envelope-verify',
        use: 'POST with initData + header x-wallet-envelope-verify-secret (dev/ops only)',
      },
      200,
    );
  }
  if (method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const secret = process.env.WALLET_ENVELOPE_VERIFY_SECRET?.trim() ?? '';
  if (!secret) {
    return jsonResponse(
      { ok: false, error: 'WALLET_ENVELOPE_VERIFY_SECRET not configured on server' },
      503,
    );
  }

  const provided = request.headers.get('x-wallet-envelope-verify-secret')?.trim() ?? '';
  if (provided !== secret) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const raw = (await getBody(request)) as { initData?: unknown } | null;
  const initData = typeof raw?.initData === 'string' ? raw.initData : '';
  if (!initData) {
    return jsonResponse({ ok: false, error: 'missing_initData' }, 400);
  }

  try {
    const auth = authByInitData(initData);
    await upsertUserFromTma({
      telegramUsername: auth.telegramUsername,
      locale: auth.locale,
      displayName: auth.displayName,
      pictureUrl: auth.pictureUrl,
      authProvider: 'telegram',
      loginSubject: auth.telegramUserId ?? auth.telegramUsername,
      telegramUsernameActual: auth.telegramUsername,
      providerUsername: auth.telegramUsername,
      telegramUserId: auth.telegramUserId,
    });

    const wallet = await getDefaultWalletByUsername(auth.telegramUsername);
    if (!wallet) {
      return jsonResponse({ ok: false, error: 'no_wallet_row' }, 404);
    }

    const ctB64 = wallet.envelope_ciphertext?.trim() ?? '';
    const nonceB64 = wallet.envelope_nonce?.trim() ?? '';
    const wrappedB64 = wallet.wrapped_dek?.trim() ?? '';
    if (!ctB64 || !nonceB64 || !wrappedB64) {
      return jsonResponse(
        {
          ok: false,
          error: 'wallet_row_missing_envelope',
          wallet_id: wallet.id,
        },
        422,
      );
    }

    const nonce = safeB64ToBuffer('envelope_nonce', nonceB64);
    const ct = safeB64ToBuffer('envelope_ciphertext', ctB64);
    const wrapped = safeB64ToBuffer('wrapped_dek', wrappedB64);

    const dek = await kmsDecrypt(wrapped);
    if (dek.length !== 32) {
      appLog('[wallet-envelope-verify]', 'kms_unwrap_bad_dek_len', {
        user: auth.telegramUsername,
        walletId: wallet.id,
        dekLen: dek.length,
      });
      return jsonResponse({ ok: false, error: 'kms_unwrap_bad_dek_len' }, 500);
    }

    const plain = decryptWalletPayloadAesGcmV1(dek, nonce, ct);
    let parsed: { v?: number; m?: string };
    try {
      parsed = JSON.parse(plain.toString('utf8')) as { v?: number; m?: string };
    } catch {
      appLog('[wallet-envelope-verify]', 'plaintext_not_json', {
        user: auth.telegramUsername,
        walletId: wallet.id,
        plainLen: plain.length,
      });
      return jsonResponse({ ok: false, error: 'plaintext_not_json' }, 500);
    }

    const mnemonic = typeof parsed.m === 'string' ? parsed.m.trim() : '';
    const wordCount = mnemonic ? mnemonic.split(/\s+/).filter(Boolean).length : 0;
    const valid = parsed.v === 1 && wordCount >= 12;

    appLog('[wallet-envelope-verify]', 'roundtrip_ok', {
      user: auth.telegramUsername,
      walletId: wallet.id,
      plainBytes: plain.length,
      wordCount,
      valid,
    });

    return jsonResponse(
      {
        ok: true,
        wallet_id: wallet.id,
        telegram_username: auth.telegramUsername,
        plaintext_byte_length: plain.length,
        mnemonic_word_count: wordCount,
        plaintext_json_valid: valid,
      },
      200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal_error';
    appLog('[wallet-envelope-verify]', 'failed', { error: msg });
    const status =
      msg === 'bot_token_not_configured' ? 500 : msg === 'invalid_initdata' ? 401 : 500;
    return jsonResponse({ ok: false, error: msg }, status);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
