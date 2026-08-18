import { deliverWelcomeFeedIfNeeded } from '../../database/feed.js';
import { getDefaultWalletByUsername } from '../../database/wallets.js';
import { upsertUserFromTma } from '../../database/users.js';
import { authWalletRequest } from '../wallet/_auth.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

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

async function handler(request: Request): Promise<Response> {
  const method = (request as { method?: string }).method ?? request.method;
  if (method === 'GET') {
    return jsonResponse(
      { ok: true, endpoint: 'wallet/status', use: 'POST with initData or hs_auth_session cookie' },
      200,
    );
  }
  if (method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const body = (await getBody(request)) as { initData?: unknown } | null;
  const initData = typeof body?.initData === 'string' ? body.initData : '';

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
    await deliverWelcomeFeedIfNeeded({
      telegramUsername: auth.telegramUsername,
      localePreferred: auth.locale,
    }).catch(() => {});

    const wallet = await getDefaultWalletByUsername(auth.telegramUsername);
    if (!wallet) {
      return jsonResponse(
        {
          ok: true,
          telegram_username: auth.telegramUsername,
          has_wallet: false,
          wallet_required: true,
        },
        200,
      );
    }

    const hasEnv = Boolean(
      wallet.envelope_ciphertext?.trim() &&
        wallet.envelope_nonce?.trim() &&
        wallet.wrapped_dek?.trim(),
    );

    return jsonResponse(
      {
        ok: true,
        telegram_username: auth.telegramUsername,
        has_wallet: true,
        has_wallet_envelope: hasEnv,
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

