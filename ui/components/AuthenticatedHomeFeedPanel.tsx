import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { buildApiUrl } from "../../api/_base";
import {
  AUTHENTICATED_FEED_FETCH_TIMEOUT_MS,
  clearAuthenticatedFeedInflight,
  loadAuthenticatedFeedDeduped,
} from "../authenticatedFeedDedupedFetch";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { logPageDisplay } from "../pageDisplayLog";
import { layout, type ThemeColors } from "../theme";
import { HomeListRowShell } from "./HomeListRowShell";
import {
  homeListShellStyle,
  MESSAGE_AVATAR_PX,
  MESSAGE_FONT_SIZE_PX,
  MESSAGE_ICON_TEXT_GAP_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_NAME_TIME_GAP_PX,
  MESSAGE_ROW_HEIGHT_PX,
} from "./messages/messageListLayout";
import { extractChatAvatarInitials } from "./messages/chatAvatarInitials";
import { MessageChatAvatarSlot } from "./messages/MessageChatAvatarSlot";
import type { AppLocale, AppStringKey } from "../../locales/appStrings";
import { getAppString } from "../../locales/appStrings";
import { useAppStrings } from "../../locales/AppStringsContext";
import { useAuth } from "../../auth/AuthContext";
import { useTelegram } from "./Telegram";

/** One extra attempt after client abort (slow TMA / cold API) before showing timeout + offline preview. */
const FEED_FETCH_ATTEMPTS_ON_TIMEOUT = 2;
/** Short backoff so a cold retry starts quickly without hammering the API. */
const FEED_FETCH_RETRY_DELAY_MS = 200;

type FeedRow = {
  id: number;
  /** ISO string preferred; numeric epoch ms/s may appear after JSON coercion. */
  sent_at?: string | null | number | undefined;
  card_type: string;
  layout_variant: string | null;
  payload: unknown;
};

function firstPresent(...values: unknown[]): unknown {
  for (const v of values) {
    if (v != null && v !== "") return v;
  }
  return null;
}

function normalizeFeedRow(raw: unknown): FeedRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const idRaw = firstPresent(row.id, row.feed_id);
  const idNum = typeof idRaw === "number" ? idRaw : Number(idRaw);
  if (!Number.isFinite(idNum)) return null;
  const cardType = firstPresent(row.card_type, row.cardType);
  if (typeof cardType !== "string" || !cardType) return null;
  const layoutVariant = firstPresent(row.layout_variant, row.layoutVariant);
  const sentAt = firstPresent(row.sent_at, row.sentAt, row.created_at, row.createdAt);
  return {
    id: idNum,
    sent_at: (sentAt as string | number | null | undefined) ?? null,
    card_type: cardType,
    layout_variant: layoutVariant == null ? null : String(layoutVariant),
    payload: row.payload ?? {},
  };
}

function normalizeFeedRows(rows: unknown[]): FeedRow[] {
  const out: FeedRow[] = [];
  for (const r of rows) {
    const row = normalizeFeedRow(r);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Stable demo clocks for welcome placeholders (today, staggered) so times stay
 * visible while `/api/feed` is slow or hanging — matches chat-list HH:mm style.
 */
function placeholderSentAtIso(welcomeOrder: number): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(14, Math.max(0, 32 - (welcomeOrder - 1) * 7), 0, 0);
  return d.toISOString();
}

/**
 * Matches `sql/seed-welcome-messages.sql` (+ `database/feed.ts` welcome keys): placeholder rows until `/api/feed` hydrates.
 */
function buildWelcomePlaceholderFeed(catalogLocale: AppLocale): FeedRow[] {
  const t = (key: AppStringKey) => getAppString(catalogLocale, key);
  return [
    {
      id: -1,
      sent_at: placeholderSentAtIso(1),
      card_type: "system_action",
      layout_variant: "action_hint",
      payload: {
        welcome_order: 1,
        title: t("feed.placeholder.walletTitle"),
        subtitle: t("feed.placeholder.walletSubtitle"),
        icon: { type: "svg_url", url: "/welcome_messages/welcome.svg" },
      },
    },
    {
      id: -2,
      sent_at: placeholderSentAtIso(2),
      card_type: "user_status",
      layout_variant: "compact",
      payload: {
        welcome_order: 2,
        title: t("feed.placeholder.creatorTitle"),
        subtitle: t("feed.placeholder.creatorSubtitle"),
        icon: { type: "svg_url", url: "/welcome_messages/creator.svg" },
      },
    },
    {
      id: -3,
      sent_at: placeholderSentAtIso(3),
      card_type: "transaction_asset",
      layout_variant: "value_trailing",
      payload: {
        welcome_order: 3,
        title: t("feed.placeholder.nftTitle"),
        subtitle: t("feed.placeholder.nftSubtitle"),
        trailing_label: t("feed.placeholder.nftTrailing"),
        icon: { type: "svg_url", url: "/welcome_messages/NFT.svg" },
      },
    },
    {
      id: -4,
      sent_at: placeholderSentAtIso(4),
      card_type: "reward_token",
      layout_variant: "value_trailing",
      payload: {
        welcome_order: 4,
        title: t("feed.placeholder.tokenTitle"),
        subtitle: t("feed.placeholder.tokenSubtitle"),
        trailing_label: t("feed.placeholder.tokenTrailing"),
        icon: { type: "svg_url", url: "/welcome_messages/token.svg" },
      },
    },
    {
      id: -5,
      sent_at: placeholderSentAtIso(5),
      card_type: "task_gig",
      layout_variant: "compact",
      payload: {
        welcome_order: 5,
        title: t("feed.placeholder.taskTitle"),
        subtitle: t("feed.placeholder.taskSubtitle"),
        icon: { type: "svg_url", url: "/welcome_messages/task.svg" },
      },
    },
  ];
}

/** Shown whenever `sent_at` is absent (preview rows, or API lag until `/api/feed` hydrates). */
function formatWallClock(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = raw < 12_000_000_000 ? raw * 1000 : raw;
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) {
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
  }
  if (typeof raw === "string" && raw.trim()) {
    const t = raw.trim();
    const d = new Date(t.includes("T") ? t : t.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) {
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
  }
  return "";
}

function coercePayload(p: unknown): Record<string, unknown> {
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  return {};
}

function resolveIconUrl(icon: unknown): string | null {
  if (!icon || typeof icon !== "object") return null;
  const o = icon as {
    type?: string;
    url?: string;
    key?: string;
    chat_id?: number | string;
    user_id?: number | string;
  };
  if (
    o.type === "svg_url" ||
    o.type === "preset" ||
    o.type === "url" ||
    o.type === "image_url"
  ) {
    const u = typeof o.url === "string" ? o.url : null;
    if (!u) return null;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    return buildApiUrl(u.startsWith("/") ? u : `/${u}`);
  }
  if (
    o.type === "telegram_avatar" ||
    o.type === "telegram_user" ||
    o.type === "telegram_chat"
  ) {
    const query = new URLSearchParams();
    if (o.user_id != null && String(o.user_id).trim() !== "") {
      query.set("user_id", String(o.user_id));
    }
    if (o.chat_id != null && String(o.chat_id).trim() !== "") {
      query.set("chat_id", String(o.chat_id));
    }
    if (query.toString()) {
      return buildApiUrl(`/api/telegram-messages-avatar?${query.toString()}`);
    }
  }
  return null;
}

function feedIconUsesContainFit(icon: unknown): boolean {
  if (!icon || typeof icon !== "object") return false;
  const type = (icon as { type?: string }).type;
  return type === "svg_url" || type === "preset";
}

function FeedFeedRow({
  item,
  isLast,
  isActive,
  colors,
  timePendingLabel,
  onPress,
}: {
  item: FeedRow;
  isLast: boolean;
  isActive?: boolean;
  colors: ThemeColors;
  timePendingLabel: string;
  onPress?: () => void;
}) {
  const { colorScheme } = useTelegram();
  const p = coercePayload(item.payload);
  const title = typeof p.title === "string" ? p.title : "";
  const subtitle = typeof p.subtitle === "string" ? p.subtitle : "";
  const trailing =
    typeof p.trailing_label === "string" ? p.trailing_label : "";

  const iconUrl = resolveIconUrl(p.icon);
  const avatarInitials = useMemo(() => extractChatAvatarInitials(title), [title]);
  const iconContentFit = feedIconUsesContainFit(p.icon) ? "contain" : "cover";
  const isProxyAvatar = Boolean(iconUrl?.includes("/api/telegram-messages-avatar"));
  const parsedClock = formatWallClock(item.sent_at);
  const timeLabel = parsedClock || timePendingLabel;
  const timeIsProvisional = !parsedClock;
  const gapTitleTime = !!(title.trim() && timeLabel.trim());
  const gapSubtitleTrailing = !!(subtitle.trim() && trailing.trim());

  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <HomeListRowShell
      isLast={isLast}
      isActive={isActive}
      colors={colors}
      onPress={onPress}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: MESSAGE_ROW_HEIGHT_PX,
          width: "100%",
          alignSelf: "stretch",
        }}
      >
      <View
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
          overflow: "visible",
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={iconUrl}
          initials={avatarInitials}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          loadEnabled={!isProxyAvatar || Boolean(isActive)}
          fetchPriority={isActive ? "high" : "normal"}
          imageContentFit={iconContentFit}
        />
      </View>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            minHeight: MESSAGE_LINE_HEIGHT_PX,
          }}
        >
          {/*
            Title must live in a flex:1 View (not flex on Text) so RN-web shrinks the
            label and keeps the wall-clock visible — same pattern as MessageChatRow.
          */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={{
                ...textBase,
                color: colors.primary,
              }}
            >
              {title}
            </Text>
          </View>
          {gapTitleTime ? <View style={{ width: MESSAGE_NAME_TIME_GAP_PX }} /> : null}
          {timeLabel ? (
            <Text
              numberOfLines={1}
              style={{
                ...textBase,
                flexShrink: 0,
                color: timeIsProvisional ? colors.secondary : colors.accent,
              }}
            >
              {timeLabel}
            </Text>
          ) : null}
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            minHeight: MESSAGE_LINE_HEIGHT_PX,
          }}
        >
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...textBase,
              flex: trailing ? 1 : 1,
              minWidth: 0,
              color: colors.secondary,
            }}
          >
            {subtitle}
          </Text>
          {trailing ? (
            <>
              {gapSubtitleTrailing ? <View style={{ width: MESSAGE_NAME_TIME_GAP_PX }} /> : null}
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{
                  ...textBase,
                  flexShrink: 0,
                  maxWidth: "45%",
                  color: colors.secondary,
                  textAlign: "right",
                }}
              >
                {trailing}
              </Text>
            </>
          ) : null}
        </View>
      </View>
      </View>
    </HomeListRowShell>
  );
}

export function AuthenticatedHomeFeedPanel({
  colors,
  scrollable = true,
}: {
  colors: ThemeColors;
  /** When false, the parent owns vertical scrolling (e.g. wide home left column with a pinned footer). */
  scrollable?: boolean;
}) {
  const {
    t,
    welcomeFeedCatalogLocale,
    welcomeFeedManualTranslation,
  } = useAppStrings();
  const welcomePlaceholderFeedItems = useMemo(
    () => buildWelcomePlaceholderFeed(welcomeFeedCatalogLocale),
    [welcomeFeedCatalogLocale],
  );
  const welcomePlaceholderRef = useRef(welcomePlaceholderFeedItems);
  welcomePlaceholderRef.current = welcomePlaceholderFeedItems;

  const { authReady, isAuthenticated, sessionFeedItems } = useAuth();
  const { initData, status, telegramBootstrapFeed } = useTelegram();
  const [items, setItems] = useState<FeedRow[]>(welcomePlaceholderFeedItems);
  const [error, setError] = useState<string | null>(null);
  const [selectedFeedId, setSelectedFeedId] = useState<number | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const wideListChrome = windowWidth > layout.authenticatedHome.firstBreakpoint;
  const feedScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const feedLoadSeqRef = useRef(0);
  const lastRenderSnapshotIdRef = useRef<number | null>(null);
  /** True once session/telegram/API applied rows with positive ids — suppress background fetch errors. */
  const hasRealFeedRef = useRef(false);

  const surfaceFeedFetchError = (message: string, meta?: Record<string, unknown>) => {
    if (hasRealFeedRef.current) {
      logPageDisplay("feed_fetch_error_suppressed", { message, ...meta });
      return;
    }
    setError(message);
  };

  useEffect(() => {
    setItems((prev) => {
      const hasPositive = prev.some((r) => r.id > 0);
      if (hasPositive) {
        return prev.map((r) => (r.id < 0 ? welcomePlaceholderFeedItems.find((w) => w.id === r.id) ?? r : r));
      }
      if (prev.length === 0 || prev.every((r) => r.id < 0)) {
        return [...welcomePlaceholderFeedItems];
      }
      return prev;
    });
  }, [welcomePlaceholderFeedItems]);

  useEffect(() => {
    const first = items[0];
    if (!first || first.id === lastRenderSnapshotIdRef.current) return;
    lastRenderSnapshotIdRef.current = first.id;
    logPageDisplay("feed_panel_render_snapshot", {
      firstId: first.id,
      itemCount: items.length,
      allPlaceholder: items.every((r) => r.id < 0),
      firstClock: formatWallClock(first.sent_at),
      firstSentAtPreview:
        typeof first.sent_at === "string" ? first.sent_at.slice(0, 32) : first.sent_at ?? null,
    });
  }, [items]);

  /**
   * When `initData` is present, key is **only** the trimmed string so `status` going `loading`→`ok`
   * does not cancel an in-flight `/api/feed` and restart (that duplicated cold work and slowed updates).
   * Session GET waits for `authReady` + cookie sign-in, then uses a stable locale key (no telegram status).
   */
  const feedLoadKey = useMemo(() => {
    if (status === "error") return null;
    const trimmed = typeof initData === "string" ? initData.trim() : "";
    if (trimmed !== "") return `post:${trimmed}:${welcomeFeedCatalogLocale}`;
    if (!authReady || !isAuthenticated) return null;
    // Cookie web auth: feed_items may ship in GET /api/auth/session (budgeted); else /api/feed.
    if (Array.isArray(sessionFeedItems) && sessionFeedItems.length > 0) return null;
    return `get:${welcomeFeedCatalogLocale}`;
  }, [initData, status, welcomeFeedCatalogLocale, authReady, isAuthenticated, sessionFeedItems]);

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const run = () => {
      const instance = feedScrollRef.current as unknown as {
        getScrollableNode?: () => HTMLElement | null | undefined;
      } | null;
      const el = instance?.getScrollableNode?.();
      if (el?.style) {
        el.style.setProperty("scrollbar-color", `${colors.accent} ${colors.background}`);
      }
    };
    const id = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
    return () => cancelAnimationFrame(id);
  }, [colors.accent, colors.background, items.length, error]);

  useEffect(() => {
    if (!telegramBootstrapFeed || telegramBootstrapFeed.length === 0) return;
    logPageDisplay("feed_panel_bootstrap_from_telegram", {
      itemCount: telegramBootstrapFeed.length,
    });
    const normalized = normalizeFeedRows(telegramBootstrapFeed as unknown[]);
    if (normalized.length > 0) {
      hasRealFeedRef.current = normalized.some((r) => r.id > 0);
      setItems(normalized);
    }
  }, [telegramBootstrapFeed]);

  useEffect(() => {
    if (!sessionFeedItems || sessionFeedItems.length === 0) return;
    logPageDisplay("feed_panel_bootstrap_from_session", {
      itemCount: sessionFeedItems.length,
    });
    const normalized = normalizeFeedRows(sessionFeedItems as unknown[]);
    if (normalized.length > 0) {
      const first = normalized[0];
      hasRealFeedRef.current = normalized.some((r) => r.id > 0);
      if (hasRealFeedRef.current) setError(null);
      logPageDisplay("feed_panel_session_items_applied", {
        itemCount: normalized.length,
        firstId: first.id,
        firstClock: formatWallClock(first.sent_at),
        allPlaceholder: normalized.every((r) => r.id < 0),
      });
      setItems(normalized);
    }
  }, [sessionFeedItems]);

  useEffect(() => {
    if (feedLoadKey === null) return;

    const feedKey = feedLoadKey;
    const loadSeq = ++feedLoadSeqRef.current;

    async function load() {
      const startedAt = Date.now();

      const initDataTrimmed = typeof initData === "string" ? initData.trim() : "";
      const initDataOk = initDataTrimmed !== "";

      logPageDisplay("feed_panel_mount_effect", {
        telegramStatus: status,
        initDataChars: initDataOk ? initDataTrimmed.length : 0,
        feedLoadKey: feedKey.slice(0, 64),
        note: initDataOk ? "feed_key_stable_across_status" : "session_feed_key_after_auth_ready",
      });

      logPageDisplay("feed_fetch_start", {
        url: buildApiUrl("/api/feed"),
        telegramStatus: status,
        initDataChars: initDataOk ? initDataTrimmed.length : 0,
        method: initDataOk ? "POST" : "GET",
        catalogLocale: welcomeFeedCatalogLocale,
        welcomeFeedManualTranslation,
        dedupedSingleton: true,
        timeoutMs: AUTHENTICATED_FEED_FETCH_TIMEOUT_MS,
      });

      if (loadSeq === feedLoadSeqRef.current) setError(null);

      let res: Awaited<ReturnType<typeof loadAuthenticatedFeedDeduped>> | undefined;
      try {
        for (let attempt = 0; attempt < FEED_FETCH_ATTEMPTS_ON_TIMEOUT; attempt++) {
          if (loadSeq !== feedLoadSeqRef.current) {
            logPageDisplay("feed_fetch_superseded_before_attempt", { loadSeq });
            return;
          }
          try {
            res = await loadAuthenticatedFeedDeduped(
              initDataOk ? initDataTrimmed : null,
              welcomeFeedCatalogLocale,
              attempt > 0 ? { bypassDedupe: true } : undefined,
            );
            break;
          } catch (e) {
            const aborted = e instanceof Error && e.name === "AbortError";
            if (loadSeq !== feedLoadSeqRef.current) {
              logPageDisplay("feed_fetch_superseded_catch", { loadSeq });
              return;
            }
            if (aborted && attempt < FEED_FETCH_ATTEMPTS_ON_TIMEOUT - 1) {
              clearAuthenticatedFeedInflight();
              logPageDisplay("feed_fetch_timeout_retry", {
                attempt: attempt + 1,
                delayMs: FEED_FETCH_RETRY_DELAY_MS,
                timeoutMs: AUTHENTICATED_FEED_FETCH_TIMEOUT_MS,
              });
              await new Promise((r) => setTimeout(r, FEED_FETCH_RETRY_DELAY_MS));
              continue;
            }
            const msg = e instanceof Error ? e.message : String(e);
            logPageDisplay("feed_fetch_catch", {
              message: msg,
              aborted,
              fromCleanupAbort: aborted && loadSeq !== feedLoadSeqRef.current,
              durationMs: Date.now() - startedAt,
              telegramStatus: status,
              attempt: attempt + 1,
            });
            if (loadSeq === feedLoadSeqRef.current) {
              surfaceFeedFetchError(
                aborted ? `timeout_after_${AUTHENTICATED_FEED_FETCH_TIMEOUT_MS}ms` : msg,
                { aborted, attempt: attempt + 1 },
              );
            }
            return;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logPageDisplay("feed_fetch_catch", {
          message: msg,
          aborted: false,
          durationMs: Date.now() - startedAt,
          telegramStatus: status,
        });
        if (loadSeq === feedLoadSeqRef.current) surfaceFeedFetchError(msg);
        return;
      }

      if (!res || loadSeq !== feedLoadSeqRef.current) {
        if (loadSeq !== feedLoadSeqRef.current) {
          logPageDisplay("feed_fetch_headers_superseded", { loadSeq });
        }
        return;
      }

      try {
        logPageDisplay("feed_fetch_headers", {
          httpStatus: res.httpStatus,
          ok: res.httpOk,
          durationMs: Date.now() - startedAt,
          loadSeq,
        });

        const text = res.bodyText;
        let j: Record<string, unknown> = {};
        try {
          j = JSON.parse(text) as Record<string, unknown>;
        } catch {
          logPageDisplay("feed_fetch_json_invalid", {
            httpStatus: res.httpStatus,
            bodyPreview: text.slice(0, 280),
            durationMs: Date.now() - startedAt,
          });
          if (loadSeq !== feedLoadSeqRef.current) {
            logPageDisplay("feed_fetch_json_invalid_superseded", { loadSeq });
            return;
          }
          surfaceFeedFetchError(`gateway_${res.httpStatus}`, {
            httpStatus: res.httpStatus,
            reason: "non_json_body",
          });
          return;
        }

        const itemsRaw = j.items;
        const ok = j.ok === true;
        const errStr = typeof j.error === "string" ? j.error : null;

        const firstRow =
          Array.isArray(itemsRaw) && itemsRaw.length > 0 && typeof itemsRaw[0] === "object"
            ? (itemsRaw[0] as Record<string, unknown>)
            : null;
        const firstSentAtRaw = firstRow?.sent_at;

        const normalizedPreview = normalizeFeedRows(
          Array.isArray(itemsRaw) ? (itemsRaw as unknown[]) : [],
        );
        const firstNormalizedSentAt = normalizedPreview[0]?.sent_at ?? null;

        logPageDisplay("feed_fetch_response", {
          httpStatus: res.httpStatus,
          ok,
          durationMs: Date.now() - startedAt,
          itemCount: Array.isArray(itemsRaw) ? itemsRaw.length : null,
          error: errStr,
          firstItemId: normalizedPreview[0]?.id ?? null,
          firstItemSentAtType:
            firstSentAtRaw == null ? "absent" : typeof firstSentAtRaw,
          firstItemSentAtPreview:
            typeof firstSentAtRaw === "string" ? firstSentAtRaw.slice(0, 32) : null,
          firstNormalizedSentAtPreview:
            typeof firstNormalizedSentAt === "string"
              ? firstNormalizedSentAt.slice(0, 32)
              : firstNormalizedSentAt,
          firstNormalizedClock: formatWallClock(firstNormalizedSentAt),
          keys:
            typeof j === "object" && j !== null
              ? Object.keys(j).filter((k) => k !== "items")
              : [],
        });

        if (loadSeq !== feedLoadSeqRef.current) {
          logPageDisplay("feed_fetch_response_superseded", { loadSeq });
          return;
        }

        if (!res.httpOk || !ok || !Array.isArray(itemsRaw)) {
          surfaceFeedFetchError(errStr ?? `HTTP ${res.httpStatus}`, { httpStatus: res.httpStatus });
          return;
        }

        setError(null);
        const next = normalizeFeedRows(itemsRaw as unknown[]);
        if (next.some((r) => r.id > 0)) hasRealFeedRef.current = true;
        if (next.length === 0) {
          logPageDisplay("feed_fetch_empty_server", {
            durationMs: Date.now() - startedAt,
          });
        } else {
          const first = next[0];
          logPageDisplay("feed_panel_items_applied", {
            source: first.id > 0 ? "api" : "placeholder",
            itemCount: next.length,
            firstId: first.id,
            firstSentAtType:
              first.sent_at == null ? "nullish" : typeof first.sent_at,
            firstSentAtPreview:
              typeof first.sent_at === "string" ? first.sent_at.slice(0, 32) : first.sent_at,
            firstClock: formatWallClock(first.sent_at),
            allPlaceholder: next.every((r) => r.id < 0),
          });
        }
        setItems((prev) => {
          if (next.length > 0) return next;
          if (prev.some((r) => r.id > 0)) return prev;
          return [...welcomePlaceholderRef.current];
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logPageDisplay("feed_fetch_response_parse_catch", {
          message: msg,
          durationMs: Date.now() - startedAt,
        });
        if (loadSeq === feedLoadSeqRef.current) surfaceFeedFetchError(msg);
      } finally {
        logPageDisplay("feed_fetch_finally", {
          durationMs: Date.now() - startedAt,
          loadSeq,
          supersededRun: loadSeq !== feedLoadSeqRef.current,
        });
      }
    }

    void load();
    // Intentionally only `feedLoadKey`: for POST-with-initData the key omits `status` so `loading`→`ok`
    // does not cancel/restart the in-flight fetch. `load()` still reads the latest `initData`/`status`
    // from the render that created this effect run.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trigger is feedLoadKey only
  }, [feedLoadKey]);

  const listShellStyle = homeListShellStyle(wideListChrome);

  const renderListBody = (content: ReactNode) => (
    <Pressable
      style={{ width: "100%", alignSelf: "stretch" }}
      onPress={() => setSelectedFeedId(null)}
    >
      <View style={listShellStyle} pointerEvents="box-none">
        {body}
      </View>
    </Pressable>
  );

  if (error && items.length === 0) {
    return renderListBody(
      <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, marginBottom: 8 }}>
        {error}
      </Text>,
    );
  }

  if (items.length === 0) {
    return renderListBody(
      <Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18 }}>
        {t("feed.empty")}
      </Text>,
    );
  }

  const body = (
    <>
      {error ? (
        <Text
          style={{
            color: colors.secondary,
            fontSize: 11,
            lineHeight: 16,
            marginBottom: 10,
          }}
          accessibilityRole="text"
        >
          {error}{" "}
          <Text style={{ color: colors.primary }}>{t("feed.offlinePreview")}</Text>
        </Text>
      ) : null}
      {items.map((it, i) => (
        <FeedFeedRow
          key={it.id}
          item={it}
          isLast={i === items.length - 1}
          isActive={selectedFeedId === it.id}
          colors={colors}
          timePendingLabel={t("feed.timePending")}
          onPress={() => setSelectedFeedId(it.id)}
        />
      ))}
    </>
  );

  if (!scrollable) {
    return renderListBody(body);
  }

  return (
    <ScrollView
      ref={feedScrollRef}
      style={{ alignSelf: "stretch" }}
      contentContainerStyle={{ ...listShellStyle, flexGrow: 1 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={() => setSelectedFeedId(null)}
    >
      {body}
      <Pressable style={{ flexGrow: 1, minHeight: 1 }} onPress={() => setSelectedFeedId(null)} />
    </ScrollView>
  );
}
