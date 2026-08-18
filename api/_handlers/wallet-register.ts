import { registerWallet } from '../../database/wallets.js';
import { upsertUserFromTma } from '../../database/users.js';
import { authWalletRequest } from '../wallet/_auth.js';
import { kmsEncrypt } from '../_lib/envelope-crypto.js';
import { appLog } from '../../shared/appLog.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const ENVELOPE_ALG = 'aes-256-gcm-v1';
const DEK_LENGTH = 32;

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

type RegisterRequestBody = {
  initData?: unknown;
  wallet_address?: unknown;
  wallet_blockchain?: unknown;
  wallet_net?: unknown;
  type?: unknown;
  label?: unknown;
  source?: unknown;
  wallet_payload_ciphertext?: unknown;
  wallet_payload_nonce?: unknown;
  dek?: unknown;
  [key: string]: unknown;
};

async function getBody(
  request:
    | Request
    | {
        json?: () => Promise<unknown>;
        body?: unknown;
      },
): Promise<unknown> {
  if (typeof (request as { json?: () => Promise<unknown> }).json === 'function') {
    return (request as Request).json();
  }
  return (request as { body?: unknown }).body ?? null;
}

function hasForbiddenSensitiveFields(body: RegisterRequestBody): boolean {
  const forbidden = [
    'mnemonic',
    'seed',
    'private_key',
    'secret',
    'secret_key',
    'wallet_master_key',
    'wallet_seed_cipher',
  ];
  return forbidden.some((key) => key in body);
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeB64Dek(raw: string): Buffer {
  const t = raw.trim();
  if (!t) {
    throw new Error('missing_dek');
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(t, 'base64');
  } catch {
    throw new Error('invalid_dek_base64');
  }
  if (buf.length !== DEK_LENGTH) {
    throw new Error('dek_must_be_32_bytes');
  }
  return buf;
}

async function handler(request: Request): Promise<Response> {
  const method = (request as { method?: string }).method ?? request.method;
  if (method === 'GET') {
    return jsonResponse(
      {
        ok: true,
        endpoint: 'wallet/register',
        use: 'POST with initData or hs_auth_session cookie, public wallet fields, and envelope (wallet_payload_ciphertext, wallet_payload_nonce, dek)',
      },
      200,
    );
  }
  if (method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const rawBody = (await getBody(request)) as RegisterRequestBody | null;
  if (!rawBody || typeof rawBody !== 'object') {
    return jsonResponse({ ok: false, error: 'bad_json' }, 400);
  }
  if (hasForbiddenSensitiveFields(rawBody)) {
    return jsonResponse(
      { ok: false, error: 'sensitive_fields_not_allowed' },
      400,
    );
  }

  const initData = toTrimmedString(rawBody.initData);

  const ct = toTrimmedString(rawBody.wallet_payload_ciphertext);
  const nonce = toTrimmedString(rawBody.wallet_payload_nonce);
  const dekStr = toTrimmedString(rawBody.dek);

  if (!ct || !nonce || !dekStr) {
    return jsonResponse(
      {
        ok: false,
        error: 'wallet_envelope_required',
        hint: 'Send wallet_payload_ciphertext, wallet_payload_nonce, and dek (base64) from the client envelope builder',
      },
      400,
    );
  }

  let dekPlain: Buffer;
  try {
    dekPlain = decodeB64Dek(dekStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'bad_dek';
    return jsonResponse({ ok: false, error: msg }, 400);
  }

  let wrappedDekBuf: Buffer;
  try {
    wrappedDekBuf = await kmsEncrypt(dekPlain);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'kms_encrypt_failed';
    appLog('[wallet-register]', 'kms_wrap_failed', { err: msg });
    return jsonResponse({ ok: false, error: 'kms_wrap_failed', detail: msg }, 502);
  } finally {
    dekPlain.fill(0);
  }

  const wrappedDekB64 = wrappedDekBuf.toString('base64');

  try {
    const auth = await authWalletRequest(request, initData);
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

    const wallet_address = toTrimmedString(rawBody.wallet_address);
    const wallet_blockchain = toTrimmedString(rawBody.wallet_blockchain);
    const wallet_net = toTrimmedString(rawBody.wallet_net);
    const type = toTrimmedString(rawBody.type);
    const label = toTrimmedString(rawBody.label);
    const source = toTrimmedString(rawBody.source);

    if (!wallet_address || !wallet_blockchain || !wallet_net || !type) {
      return jsonResponse(
        {
          ok: false,
          error:
            'required_fields_missing (wallet_address, wallet_blockchain, wallet_net, type)',
        },
        400,
      );
    }

    const wallet = await registerWallet({
      telegramUsername: auth.telegramUsername,
      walletAddress: wallet_address,
      walletBlockchain: wallet_blockchain,
      walletNet: wallet_net,
      type,
      label: label || null,
      source: source || null,
      isDefault: true,
      envelopeCiphertextB64: ct,
      envelopeNonceB64: nonce,
      wrappedDekB64,
      envelopeAlg: ENVELOPE_ALG,
    });

    if (!wallet) {
      return jsonResponse({ ok: false, error: 'wallet_register_failed' }, 500);
    }

    if (process.env.WALLET_ENVELOPE_DEBUG === '1') {
      appLog('[wallet-register]', 'envelope_persisted', {
        user: auth.telegramUsername,
        walletId: wallet.id,
        hasEnvelope: Boolean(wallet.envelope_ciphertext && wallet.wrapped_dek),
      });
    }

    return jsonResponse(
      {
        ok: true,
        telegram_username: auth.telegramUsername,
        has_wallet: true,
        has_wallet_envelope: Boolean(
          wallet.envelope_ciphertext && wallet.envelope_nonce && wallet.wrapped_dek,
        ),
        wallet: {
          id: wallet.id,
          wallet_address: wallet.wallet_address,
          wallet_blockchain: wallet.wallet_blockchain,
          wallet_net: wallet.wallet_net,
          type: wallet.type,
          label: wallet.label,
          is_default: wallet.is_default,
          source: wallet.source,
        },
      },
      200,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal_error';
    const status = msg === 'bot_token_not_configured'
      ? 500
      : msg === 'invalid_initdata'
        ? 401
        : msg === 'missing_auth'
          ? 401
          : 400;
    return jsonResponse({ ok: false, error: msg }, status);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
