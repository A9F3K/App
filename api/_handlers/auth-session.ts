import { bootstrapAuthenticatedFeedItems } from "../../database/feed.js";
import { getConnection, isTelegramMessagesConnected } from "../../database/telegramMessages.js";
import { getDisplayNameForUsername } from "../../database/users.js";
import { getDefaultWalletByUsername } from "../../database/wallets.js";
import { deleteSession, getSessionByHash, touchSession } from "../../database/telegramAuth.js";
import {
  FEED_CATALOG_FALLBACK_LOCALE,
  parseFeedCatalogLocaleHint,
  type FeedCatalogLocale,
} from "../../locales/resolveFeedCatalogLocale.js";
import { sha256Hex } from "../_lib/telegram-oidc.js";
import { getSessionTokenFromRequest } from "../_lib/session-auth.js";
import { applyAuthApiCors, authApiPreflightResponse } from "../_lib/auth-cors.js";

type NodeRes = {
  status: (code: number) => void;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};
type AnyRequest = Request | { method?: string; headers?: Record<string, string | string[] | undefined>; url?: string };

const SESSION_COOKIE = "hs_auth_session";
const JSON_HEADERS = { "Content-Type": "application/json" };

function getCookieValue(cookieHeader: string | null, key: string): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(";").map((p) => p.trim());
  for (const p of pairs) {
    if (!p.startsWith(`${key}=`)) continue;
    const raw = p.slice(key.length + 1);
    return decodeURIComponent(raw);
  }
  return null;
}

function getHeader(request: AnyRequest, name: string): string | null {
  const lower = name.toLowerCase();
  const webHeaders = (request as Request).headers as Headers | undefined;
  if (webHeaders && typeof (webHeaders as Headers).get === "function") {
    return webHeaders.get(name);
  }
  const nodeHeaders = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  if (!nodeHeaders) return null;
  const raw = nodeHeaders[lower];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

function isSecureRequest(request: AnyRequest): boolean {
  const xfProto = getHeader(request, "x-forwarded-proto");
  if (xfProto) return xfProto.split(",")[0]?.trim() === "https";
  const rawUrl = (request as { url?: string }).url ?? "";
  return rawUrl.startsWith("https://");
}

function sendJson(body: object, status = 200, request?: AnyRequest): Response {
  const headers = new Headers(JSON_HEADERS);
  if (request) applyAuthApiCors(request, headers);
  return new Response(JSON.stringify(body), { status, headers });
}

function sendJsonViaRes(res: NodeRes, body: object, status = 200, request?: AnyRequest): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  if (request) {
    const headers = new Headers();
    applyAuthApiCors(request, headers);
    headers.forEach((v, k) => res.setHeader(k, v));
  }
  res.end(JSON.stringify(body));
}

function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function catalogLocaleFromRequest(request: AnyRequest): FeedCatalogLocale {
  try {
    const rawUrl = (request as { url?: string }).url ?? "";
    if (rawUrl) {
      const url = new URL(rawUrl, "http://localhost");
      const fromQuery = parseFeedCatalogLocaleHint(url.searchParams.get("catalog_locale"));
      if (fromQuery) return fromQuery;
    }
  } catch {
    /* ignore */
  }
  return FEED_CATALOG_FALLBACK_LOCALE;
}

/** Browser hydrate / light clients: skip feed so auth unlocks without waiting on catalog. */
function wantsSkipFeed(request: AnyRequest): boolean {
  try {
    const rawUrl = (request as { url?: string }).url ?? "";
    if (!rawUrl) return false;
    const url = new URL(rawUrl, "http://localhost");
    const v = url.searchParams.get("skip_feed");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

/** Cap feed bootstrap so cold session does not serialize behind a slow catalog query. */
const FEED_BOOTSTRAP_BUDGET_MS = 450;

async function withBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

async function handler(request: AnyRequest, res?: NodeRes): Promise<Response | void> {
  const preflight = authApiPreflightResponse(request);
  if (preflight) {
    if (res) {
      res.status(preflight.status);
      preflight.headers.forEach((v, k) => res.setHeader(k, v));
      res.end();
      return;
    }
    return preflight;
  }

  const method = (request as { method?: string }).method ?? request.method;
  const token = getSessionTokenFromRequest(request);
  const secure = isSecureRequest(request);

  if (method === "DELETE") {
    if (token) {
      await deleteSession(sha256Hex(token));
    }
    const response = sendJson({ ok: true, cleared: true }, 200, request);
    response.headers.append("Set-Cookie", clearSessionCookie(secure));
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await response.text());
      return;
    }
    return response;
  }

  if (method !== "GET") {
    const body = { ok: false, error: "method_not_allowed" };
    if (res) return sendJsonViaRes(res, body, 405, request);
    return sendJson(body, 405, request);
  }

  if (!token) {
    const body = { ok: true, authenticated: false };
    if (res) return sendJsonViaRes(res, body, 200, request);
    return sendJson(body, 200, request);
  }

  const row = await getSessionByHash(sha256Hex(token));
  if (!row) {
    const body = { ok: true, authenticated: false };
    const response = sendJson(body, 200, request);
    response.headers.append("Set-Cookie", clearSessionCookie(secure));
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await response.text());
      return;
    }
    return response;
  }

  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteSession(sha256Hex(token));
    const body = { ok: true, authenticated: false };
    const response = sendJson(body, 200, request);
    response.headers.append("Set-Cookie", clearSessionCookie(secure));
    if (res) {
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await response.text());
      return;
    }
    return response;
  }

  await touchSession(sha256Hex(token));
  const skipFeed = wantsSkipFeed(request);
  const catalogLocale = catalogLocaleFromRequest(request);

  type FeedItems = Awaited<ReturnType<typeof bootstrapAuthenticatedFeedItems>>;
  const feedPromise: Promise<FeedItems> = skipFeed
    ? Promise.resolve([])
    : withBudget(
        bootstrapAuthenticatedFeedItems({
          telegramUsername: row.telegram_username,
          catalogLocale,
        }).catch(() => [] as FeedItems),
        FEED_BOOTSTRAP_BUDGET_MS,
        [],
      );

  // Overlap wallet/profile/connected/feed/connection — do not serialize
  // getConnection behind the first batch (cold session felt "lazy").
  const connectedPromise = isTelegramMessagesConnected(row.telegram_username);
  const connectionPromise = connectedPromise.then((connected) =>
    connected ? getConnection(row.telegram_username) : Promise.resolve(null),
  );
  const [displayName, wallet, telegramMessagesConnected, feed_items, telegramMessagesConn] =
    await Promise.all([
      getDisplayNameForUsername(row.telegram_username),
      getDefaultWalletByUsername(row.telegram_username),
      connectedPromise,
      feedPromise,
      connectionPromise,
    ]);
  const feedFields = { feed_items };
  const telegramMessagesFields = {
    telegram_messages_connected: telegramMessagesConnected,
    telegram_messages_connected_at: telegramMessagesConn?.connected_at ?? null,
  };
  const body = wallet
    ? {
        ok: true,
        authenticated: true,
        telegram_username: row.telegram_username,
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
        ...telegramMessagesFields,
        ...feedFields,
      }
    : {
        ok: true,
        authenticated: true,
        telegram_username: row.telegram_username,
        display_name: displayName,
        has_wallet: false,
        wallet_required: true,
        ...telegramMessagesFields,
        ...feedFields,
      };
  if (res) return sendJsonViaRes(res, body, 200, request);
  return sendJson(body, 200, request);
}

export default handler;
export const GET = handler;
export const DELETE = handler;
export const OPTIONS = handler;

