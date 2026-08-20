/**
 * POST /api/telegram handler (init data verify + DB upsert).
 * Loaded only for POST so GET stays fast. Lives under app/telegram; api/telegram.ts imports this.
 */
import crypto from 'crypto';
import {
  deliverWelcomeFeedIfNeeded,
  listFeedItemsForUser,
} from '../database/feed.js';
import { resolveFeedCatalogLocaleFromLanguageTag } from '../locales/resolveFeedCatalogLocale.js';
import {
  displayNameFromNameParts,
  getDisplayNameForUsername,
  normalizeUsername,
  upsertUserFromTma,
} from '../database/users.js';
import { ensureSchema } from '../database/start.js';
import { getDefaultWalletByUsername } from '../database/wallets.js';
import { isTelegramMessagesConnected } from '../database/telegramMessages.js';
import { issueAuthSession } from '../api/_lib/auth-session-issue.js';

import { appError, appLog } from '../shared/appLog.js';

const LOG_TAG = '[api/telegram]';

function log(msg: string, detail?: Record<string, unknown>) {
  appLog(LOG_TAG, msg, detail);
}

function logErr(msg: string, err: unknown) {
  appError(LOG_TAG, msg, undefined, err);
}

/** Same orchestration as `/api/feed`: schema → deliver missing catalogue rows (`sent_at = NOW()`) → list. */
async function bootstrapFeedPayloadForMiniApp(opts: {
  telegramUsername: string;
  locale: string | null;
  startMs: number;
}): Promise<Awaited<ReturnType<typeof listFeedItemsForUser>>> {
  const fb0 = Date.now();
  try {
    await ensureSchema();
  } catch (e) {
    logErr('feed_schema_failed', e);
    return [];
  }

  let deliverDiag: Awaited<ReturnType<typeof deliverWelcomeFeedIfNeeded>> | null =
    null;
  try {
    deliverDiag = await deliverWelcomeFeedIfNeeded({
      telegramUsername: opts.telegramUsername,
      localePreferred: opts.locale,
    });
  } catch (e) {
    logErr('feed_deliver_catch_soft', e);
  }
  log('feed_deliver_done', {
    feedMsInner: Date.now() - fb0,
    elapsedMs: Date.now() - opts.startMs,
    deliverExplicitCatalogSize: deliverDiag?.explicitCatalogSize ?? null,
    deliverExtraCatalogSize: deliverDiag?.extraCatalogSize ?? null,
    deliverWelcomeRowsResolved: deliverDiag?.welcomeRowsResolved ?? null,
    deliverLocale: deliverDiag?.locale ?? null,
  });

  try {
    const catalogLocale = resolveFeedCatalogLocaleFromLanguageTag(opts.locale);
    const items = await listFeedItemsForUser(opts.telegramUsername, 80, catalogLocale);
    log('feed_list_done', {
      itemCount: items.length,
      feedMsTotal: Date.now() - fb0,
      elapsedMs: Date.now() - opts.startMs,
    });
    return items;
  } catch (e) {
    logErr('feed_list_failed', e);
    return [];
  }
}

type TelegramUserPayload = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
  photo_url?: string;
  [key: string]: unknown;
};

type VerifiedInitData = {
  auth_date?: string;
  query_id?: string;
  user?: TelegramUserPayload;
  [key: string]: unknown;
};

const TELEGRAM_WEBAPP_PUBLIC_KEY_RAW = Buffer.from(
  'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
  'hex',
);
const ED25519_SPKI_HEADER = Buffer.from(
  '302a300506032b6570032100',
  'hex',
);
const TELEGRAM_WEBAPP_PUBLIC_KEY = crypto.createPublicKey({
  key: Buffer.concat([
    ED25519_SPKI_HEADER,
    Buffer.from([0]),
    TELEGRAM_WEBAPP_PUBLIC_KEY_RAW,
  ]),
  format: 'der',
  type: 'spki',
});

function verifyTelegramWebAppInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = 24 * 3600,
): VerifiedInitData | null {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const data: Record<string, string> = {};
    for (const [key, value] of params.entries()) data[key] = value;

    const authDateStr = data['auth_date'];
    if (authDateStr) {
      const authDate = Number(authDateStr);
      if (!Number.isFinite(authDate)) return null;
      const now = Math.floor(Date.now() / 1000);
      if (authDate > now + 60) return null;
      if (maxAgeSeconds != null && now - authDate > maxAgeSeconds) {
        return null;
      }
    }

    const receivedHash = data['hash'];
    const receivedSignature = data['signature'];

    if (receivedHash) {
      const dataForHash = { ...data };
      delete dataForHash['hash'];
      const sorted = Object.keys(dataForHash)
        .sort()
        .map((k) => `${k}=${dataForHash[k]}`)
        .join('\n');
      const dataCheckString = Buffer.from(sorted, 'utf8');
      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();
      const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');
      const valid =
        receivedHash.length === computedHash.length &&
        crypto.timingSafeEqual(
          Buffer.from(receivedHash, 'hex'),
          Buffer.from(computedHash, 'hex'),
        );
      if (!valid) return null;
    } else if (receivedSignature) {
      const botId = botToken.split(':')[0];
      if (!botId) return null;
      const dataForSig = { ...data };
      delete dataForSig['hash'];
      delete dataForSig['signature'];
      const sorted = Object.keys(dataForSig)
        .sort()
        .map((k) => `${k}=${dataForSig[k]}`)
        .join('\n');
      const dataCheckString = `${botId}:WebAppData\n${sorted}`;
      const base64 = receivedSignature
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const pad = (4 - (base64.length % 4)) % 4;
      const sigBuffer = Buffer.from(
        base64 + '='.repeat(pad),
        'base64',
      );
      const ok = crypto.verify(
        null,
        Buffer.from(dataCheckString, 'utf8'),
        TELEGRAM_WEBAPP_PUBLIC_KEY,
        sigBuffer,
      );
      if (!ok) return null;
    } else return null;

    const result: VerifiedInitData = { ...data };
    delete result['hash'];
    delete result['signature'];
    if (data.user) {
      try {
        result.user = JSON.parse(data.user) as TelegramUserPayload;
      } catch {
        return null;
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** Get JSON body from Web Request or Node req (Vercel may pass either). */
async function getBody(
  request:
    | Request
    | {
        json?: () => Promise<unknown>;
        body?: unknown;
        on?: (e: string, fn: (c: Buffer) => void) => void;
      },
): Promise<unknown> {
  if (
    typeof (request as { json?: () => Promise<unknown> }).json ===
    'function'
  ) {
    return (request as Request).json();
  }
  const req = request as {
    body?: unknown;
    on?: (e: string, fn: (c: Buffer) => void) => void;
  };
  if (req.body != null && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.on === 'function') {
    const chunks: Buffer[] = [];
    return new Promise<unknown>((resolve, reject) => {
      (req as NodeJS.ReadableStream).on(
        'data',
        (c: Buffer) => chunks.push(c),
      );
      (req as NodeJS.ReadableStream).on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          reject(e);
        }
      });
      (req as NodeJS.ReadableStream).on('error', reject);
    });
  }
  return null;
}

function isSecureRequest(
  request: Request | { headers?: Record<string, string | string[] | undefined>; url?: string },
): boolean {
  const rawUrl = (request as { url?: string }).url ?? (request as Request).url ?? '';
  if (rawUrl.startsWith('https://')) return true;
  const headers = (request as Request).headers;
  const xf =
    headers && typeof headers.get === 'function'
      ? headers.get('x-forwarded-proto')
      : (request as { headers?: Record<string, string | string[] | undefined> }).headers?.[
          'x-forwarded-proto'
        ];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  return typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https';
}

async function jsonTelegramRegisterSuccess(
  body: Record<string, unknown>,
  telegramUsername: string,
  request: Request | { headers?: Record<string, string | string[] | undefined>; url?: string },
  issueSession: boolean,
): Promise<Response> {
  const telegram_messages_connected = await isTelegramMessagesConnected(telegramUsername);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (issueSession) {
    const { setCookie } = await issueAuthSession({
      telegramUsername,
      secure: isSecureRequest(request),
    });
    headers.append('Set-Cookie', setCookie);
  }
  return new Response(
    JSON.stringify({ ...body, telegram_messages_connected, session_issued: issueSession }),
    {
      status: 200,
      headers,
    },
  );
}

export async function handlePost(
  request: Request | { json?: () => Promise<unknown>; body?: unknown },
): Promise<Response> {
  const startMs = Date.now();
  log('post_start', { elapsedMs: 0 });

  let body: any;
  try {
    body = await getBody(request);
    if (body == null) throw new Error('no_body');
    log('body_parsed', { elapsedMs: Date.now() - startMs });
  } catch (e) {
    logErr('body_parse_failed', e);
    return new Response(
      JSON.stringify({ ok: false, error: 'bad_json' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const initData =
    typeof body?.initData === 'string' ? body.initData : '';
  /** Client opts in after welcome Sign in / prior session; false after explicit logout. */
  const issueSession = body?.issueSession === true;
  if (!initData) {
    log('reject', {
      reason: 'missing_initData',
      elapsedMs: Date.now() - startMs,
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'missing_initData' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  log('initData_received', {
    initDataLength: initData.length,
    elapsedMs: Date.now() - startMs,
  });

  const botToken = (process.env.BOT_TOKEN || '').trim();
  if (!botToken) {
    log('reject', {
      reason: 'bot_token_not_configured',
      elapsedMs: Date.now() - startMs,
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'bot_token_not_configured' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const verifyStart = Date.now();
  const verified = verifyTelegramWebAppInitData(initData, botToken);
  log('verify_done', {
    ok: !!verified,
    verifyMs: Date.now() - verifyStart,
    elapsedMs: Date.now() - startMs,
  });

  if (!verified) {
    log('reject', {
      reason: 'invalid_initdata',
      elapsedMs: Date.now() - startMs,
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_initdata' }),
      {
        status: 401,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  const user: TelegramUserPayload =
    verified.user && typeof verified.user === 'object'
      ? (verified.user as TelegramUserPayload)
      : {};
  const telegramUsername = normalizeUsername(user.username);
  if (!telegramUsername) {
    log('reject', {
      reason: 'username_required',
      elapsedMs: Date.now() - startMs,
    });
    return new Response(
      JSON.stringify({ ok: false, error: 'username_required' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  log('username_ok', {
    telegramUsername,
    elapsedMs: Date.now() - startMs,
  });

  const locale =
    typeof user.language_code === 'string'
      ? user.language_code
      : null;
  const dbStart = Date.now();
  try {
    const userRow = await upsertUserFromTma({
      telegramUsername,
      locale,
      displayName: displayNameFromNameParts(user.first_name, user.last_name),
      pictureUrl: typeof user.photo_url === 'string' ? user.photo_url : null,
      authProvider: 'telegram',
      loginSubject: user.id != null ? String(user.id) : telegramUsername,
      telegramUsernameActual: telegramUsername,
      providerUsername: telegramUsername,
      telegramUserId: user.id,
    });
    const displayName =
      userRow?.displayName ?? (await getDisplayNameForUsername(telegramUsername));
    const wallet = await getDefaultWalletByUsername(telegramUsername);
    log('db_upsert_done', {
      dbMs: Date.now() - dbStart,
      elapsedMs: Date.now() - startMs,
      hasWallet: !!wallet,
    });

    const feed_items = await bootstrapFeedPayloadForMiniApp({
      telegramUsername,
      locale,
      startMs,
    });

    if (wallet) {
      log('success', {
        telegramUsername,
        hasWallet: true,
        feedItems: feed_items.length,
        issueSession,
        totalMs: Date.now() - startMs,
      });
      return jsonTelegramRegisterSuccess(
        {
          ok: true,
          telegram_username: telegramUsername,
          display_name: displayName,
          has_wallet: true,
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
          feed_items,
        },
        telegramUsername,
        request,
        issueSession,
      );
    }

    log('success', {
      telegramUsername,
      hasWallet: false,
      feedItems: feed_items.length,
      issueSession,
      totalMs: Date.now() - startMs,
    });
    return jsonTelegramRegisterSuccess(
      {
        ok: true,
        telegram_username: telegramUsername,
        display_name: displayName,
        has_wallet: false,
        wallet_required: true,
        feed_items,
      },
      telegramUsername,
      request,
      issueSession,
    );
  } catch (e) {
    logErr('db_upsert_failed', e);
    return new Response(
      JSON.stringify({ ok: false, error: 'db_error' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

}
