import { buildApiUrl } from "../../api/_base";
import { clearAuthenticatedFeedInflight } from "../authenticatedFeedDedupedFetch";
import { setFeedUnreadCount } from "./feedUnreadStore";
import { bumpFeedRefresh } from "./feedRefreshStore";

export type PostWalletTopUpFeedNotificationInput = {
  initDataRaw?: string | null;
  sourceId: string;
  amount: string;
  symbol: string;
  title: string;
  subtitle: string;
  trailingLabel: string;
};

/** Create a wallet top-up feed notification and refresh the Feed unread badge. */
export async function postWalletTopUpFeedNotification(
  input: PostWalletTopUpFeedNotificationInput,
): Promise<{ ok: boolean; unreadCount: number }> {
  const trimmedInit = typeof input.initDataRaw === "string" ? input.initDataRaw.trim() : "";
  const body: Record<string, unknown> = {
    action: "create_topup",
    source_id: input.sourceId,
    amount: input.amount,
    symbol: input.symbol,
    title: input.title,
    subtitle: input.subtitle,
    trailing_label: input.trailingLabel,
  };
  if (trimmedInit) body.initData = trimmedInit;

  try {
    const res = await fetch(buildApiUrl("/api/feed"), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      unread_count?: number;
    } | null;
    if (res.ok && data?.ok) {
      const unread =
        typeof data.unread_count === "number" && Number.isFinite(data.unread_count)
          ? data.unread_count
          : 0;
      setFeedUnreadCount(unread);
      clearAuthenticatedFeedInflight();
      bumpFeedRefresh();
      return { ok: true, unreadCount: unread };
    }
  } catch {
    /* best effort — top-up already succeeded on-chain */
  }
  return { ok: false, unreadCount: 0 };
}

/** Mark feed item(s) read. Pass no ids to mark all unread rows. */
export async function markFeedItemsReadClient(opts: {
  initDataRaw?: string | null;
  ids?: number[];
}): Promise<number> {
  const trimmedInit = typeof opts.initDataRaw === "string" ? opts.initDataRaw.trim() : "";
  const body: Record<string, unknown> = { action: "mark_read" };
  if (opts.ids && opts.ids.length > 0) body.ids = opts.ids;
  if (trimmedInit) body.initData = trimmedInit;

  try {
    const res = await fetch(buildApiUrl("/api/feed"), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      unread_count?: number;
    } | null;
    if (res.ok && data?.ok && typeof data.unread_count === "number") {
      setFeedUnreadCount(data.unread_count);
      clearAuthenticatedFeedInflight();
      return data.unread_count;
    }
  } catch {
    /* ignore */
  }
  return 0;
}
