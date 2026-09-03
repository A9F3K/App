/**
 * Authenticated feed: list items, create wallet top-up notifications, mark read.
 */
import {
  deleteSession,
  getSessionByHash,
  touchSession,
} from "../../database/telegramAuth.js";
import {
  bootstrapAuthenticatedFeedItems,
  countUnreadFeedItems,
  insertWalletTopUpFeedItem,
  markFeedItemsRead,
  type FeedCatalogLocale,
} from "../../database/feed.js";
import {
  FEED_CATALOG_FALLBACK_LOCALE,
  parseFeedCatalogLocaleHint,
} from "../../locales/resolveFeedCatalogLocale.js";
import { upsertUserFromTma } from "../../database/users.js";
import { authByInitData } from "../wallet/_auth.js";
import { getSessionTokenFromRequest } from "../_lib/session-auth.js";
import { sha256Hex } from "../_lib/telegram-oidc.js";
import { appLog } from "../../shared/appLog.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const FEED_LOG_TAG = "[api/feed]";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function feedLog(payload: Record<string, unknown>): void {
  const { phase, ...rest } = payload;
  appLog(FEED_LOG_TAG, typeof phase === "string" ? phase : "log", rest);
}

function sendJson(res: NodeRes | undefined, body: object, status: number): Response | void {
  const json = JSON.stringify(body);
  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(json);
    return;
  }
  return new Response(json, { status, headers: JSON_HEADERS });
}

async function telegramUsernameFromRequest(
  request: Request,
  postBody?: { initData?: unknown },
): Promise<{
  username: string;
  locale: string | null;
} | null> {
  const method = request.method ?? "GET";
  const sessionToken = getSessionTokenFromRequest(request);
  if (sessionToken) {
    const hash = sha256Hex(sessionToken);
    const row = await getSessionByHash(hash);
    if (!row) {
      return null;
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      await deleteSession(hash);
      return null;
    }
    await touchSession(hash);
    return { username: row.telegram_username, locale: null };
  }

  if (method !== "POST") return null;
  let body = postBody;
  if (!body) {
    try {
      body = (await request.json()) as { initData?: unknown };
    } catch {
      return null;
    }
  }
  const initData = typeof body?.initData === "string" ? body.initData : "";
  if (!initData) return null;
  const auth = authByInitData(initData);
  await upsertUserFromTma({
    telegramUsername: auth.telegramUsername,
    locale: auth.locale,
    displayName: auth.displayName,
    pictureUrl: auth.pictureUrl,
    authProvider: "telegram",
    loginSubject: auth.telegramUserId ?? auth.telegramUsername,
    telegramUsernameActual: auth.telegramUsername,
    providerUsername: auth.telegramUsername,
    telegramUserId: auth.telegramUserId,
  });
  return { username: auth.telegramUsername, locale: auth.locale };
}

function catalogLocaleFromRequest(request: Request, bodyCatalogLocale?: unknown): FeedCatalogLocale {
  const hinted = parseFeedCatalogLocaleHint(bodyCatalogLocale);
  if (hinted) return hinted;
  try {
    const rawUrl = (request as { url?: string }).url ?? "";
    const url = new URL(rawUrl, "http://localhost");
    const fromQuery = parseFeedCatalogLocaleHint(url.searchParams.get("catalog_locale"));
    if (fromQuery) return fromQuery;
  } catch {
    /* ignore */
  }
  return FEED_CATALOG_FALLBACK_LOCALE;
}

type FeedPostBody = {
  initData?: unknown;
  catalog_locale?: unknown;
  action?: unknown;
  source_id?: unknown;
  amount?: unknown;
  symbol?: unknown;
  title?: unknown;
  subtitle?: unknown;
  trailing_label?: unknown;
  ids?: unknown;
  id?: unknown;
};

function asTrimmedString(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const t0 = Date.now();
  const method = (request as { method?: string }).method ?? "GET";
  let postBody: FeedPostBody = {};
  if (method === "POST") {
    try {
      postBody = (await request.json()) as FeedPostBody;
    } catch {
      postBody = {};
    }
  }
  const displayLocale = catalogLocaleFromRequest(request, postBody.catalog_locale);
  const action =
    typeof postBody.action === "string" ? postBody.action.trim().toLowerCase() : "";

  feedLog({
    phase: "request_start",
    method,
    action: action || null,
    cookiePresent: (() => {
      const token = getSessionTokenFromRequest(request);
      return typeof token === "string" && token.length > 0;
    })(),
  });

  if (method !== "GET" && method !== "POST") {
    feedLog({ phase: "method_reject", durationMs: Date.now() - t0, method });
    return sendJson(res, { ok: false, error: "method_not_allowed" }, 405);
  }

  try {
    const user = await telegramUsernameFromRequest(request, postBody);
    if (!user) {
      feedLog({
        phase: "unauthorized",
        durationMs: Date.now() - t0,
        method,
      });
      return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    }

    if (method === "POST" && action === "create_topup") {
      const sourceId = asTrimmedString(postBody.source_id, 180);
      const amount = asTrimmedString(postBody.amount, 64);
      const symbol = asTrimmedString(postBody.symbol, 32) || "GRAM";
      const title = asTrimmedString(postBody.title, 120) || "Wallet top-up";
      const subtitle =
        asTrimmedString(postBody.subtitle, 120) || (amount ? `${amount} ${symbol}` : symbol);
      const trailingLabel =
        asTrimmedString(postBody.trailing_label, 64) || (amount ? `+${amount} ${symbol}` : `+${symbol}`);
      if (!sourceId || !amount) {
        return sendJson(res, { ok: false, error: "source_id_and_amount_required" }, 400);
      }
      const inserted = await insertWalletTopUpFeedItem({
        telegramUsername: user.username,
        sourceId,
        amountLabel: amount,
        symbol,
        title,
        subtitle,
        trailingLabel,
      });
      const unreadCount = await countUnreadFeedItems(user.username);
      feedLog({
        phase: "create_topup_ok",
        inserted: inserted?.inserted ?? false,
        itemId: inserted?.id ?? null,
        unreadCount,
        totalMs: Date.now() - t0,
      });
      return sendJson(
        res,
        {
          ok: true,
          item_id: inserted?.id ?? null,
          inserted: inserted?.inserted ?? false,
          unread_count: unreadCount,
        },
        200,
      );
    }

    if (method === "POST" && action === "mark_read") {
      const idsRaw = Array.isArray(postBody.ids) ? postBody.ids : [];
      const singleId = postBody.id;
      const ids = [...idsRaw, ...(singleId != null ? [singleId] : [])]
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0);
      const result = await markFeedItemsRead({
        telegramUsername: user.username,
        ids: ids.length > 0 ? ids : null,
      });
      feedLog({
        phase: "mark_read_ok",
        marked: result.marked,
        unreadCount: result.unreadCount,
        totalMs: Date.now() - t0,
      });
      return sendJson(
        res,
        { ok: true, marked: result.marked, unread_count: result.unreadCount },
        200,
      );
    }

    const deliverLocalePreferred =
      user.locale ??
      (displayLocale !== FEED_CATALOG_FALLBACK_LOCALE ? displayLocale : null);
    const items = await bootstrapAuthenticatedFeedItems({
      telegramUsername: user.username,
      catalogLocale: displayLocale,
      localePreferred: deliverLocalePreferred,
    });
    const unreadCount = items.reduce((n, row) => (row.read_at ? n : n + 1), 0);
    feedLog({
      phase: "response_ok",
      itemCount: items.length,
      unreadCount,
      displayLocale,
      totalMs: Date.now() - t0,
    });
    return sendJson(res, { ok: true, items, unread_count: unreadCount }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "internal_error";
    const status =
      msg === "bot_token_not_configured"
        ? 500
        : msg === "invalid_initdata" || msg === "username_required"
          ? 401
          : 400;
    feedLog({
      phase: "handler_error",
      durationMs: Date.now() - t0,
      httpStatus: status,
      error: msg,
    });
    return sendJson(res, { ok: false, error: msg }, status);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
