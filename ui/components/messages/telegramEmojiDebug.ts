import { appLog, appWarn } from "../../../shared/appLog";
import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import { segmentsContainTelegramEmoji } from "../../../shared/formattedTextSegments";
import type { TelegramEmojiFetchRef } from "./fetchTelegramEmojiBytes";

const TAG = "[telegram-emoji]";

const eventCounts = new Map<string, number>();
const MAX_PER_KEY = 2;

function shouldLog(key: string): boolean {
  const count = eventCounts.get(key) ?? 0;
  if (count >= MAX_PER_KEY) return false;
  eventCounts.set(key, count + 1);
  return true;
}

function refLabel(ref: TelegramEmojiFetchRef): string {
  return ref.kind === "custom"
    ? `custom:${ref.preferStatic ? "static:" : ""}${ref.customEmojiId}`
    : `animated:${ref.emoji}`;
}

export const telegramEmojiDebug = {
  fetchStart(ref: TelegramEmojiFetchRef, url: string) {
    const key = `fetch:start:${refLabel(ref)}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "fetch_start", { ref: refLabel(ref), url });
  },

  fetchCacheHit(ref: TelegramEmojiFetchRef, mime: string, byteLength: number) {
    const key = `fetch:cache:${refLabel(ref)}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "fetch_cache_hit", { ref: refLabel(ref), mime, byteLength });
  },

  fetchUnavailableCached(ref: TelegramEmojiFetchRef) {
    const key = `fetch:unavailable:${refLabel(ref)}`;
    if (!shouldLog(key)) return;
    appWarn(TAG, "fetch_unavailable_cached", {
      ref: refLabel(ref),
      hint: "prior fetch failed; not retrying until reload",
    });
  },

  fetchHttpResult(
    ref: TelegramEmojiFetchRef,
    status: number,
    contentType: string | null,
    byteLength: number,
  ) {
    if (status !== 200) {
      appWarn(TAG, "fetch_http_error", {
        ref: refLabel(ref),
        status,
        contentType,
        byteLength,
        hint:
          status === 404
            ? "gateway/API could not resolve sticker bytes"
            : status === 403
              ? "not connected or session warming"
              : status === 503
                ? "TDLib gateway session not ready"
                : "unexpected HTTP status",
      });
      return;
    }
    const key = `fetch:ok:${refLabel(ref)}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "fetch_http_ok", { ref: refLabel(ref), status, contentType, byteLength });
  },

  fetchEmptyBody(ref: TelegramEmojiFetchRef) {
    appWarn(TAG, "fetch_empty_body", { ref: refLabel(ref) });
  },

  fetchNetworkError(ref: TelegramEmojiFetchRef, err: unknown) {
    appWarn(TAG, "fetch_network_error", {
      ref: refLabel(ref),
      err: err instanceof Error ? err.message : String(err),
    });
  },

  inlineNoRef(context: string, props: { customEmojiId?: string; emoji?: string }) {
    const key = `inline:no_ref:${context}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "inline_no_fetch_ref", {
      context,
      customEmojiId: props.customEmojiId?.trim() || null,
      emoji: props.emoji?.trim() || null,
    });
  },

  fetchSkipped(
    ref: TelegramEmojiFetchRef,
    details: {
      fetchEnabled: boolean;
      priority: boolean;
      lowPriority: boolean;
      visible: boolean;
    },
  ) {
    const key = `fetch:skipped:${refLabel(ref)}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "fetch_skipped", {
      ref: refLabel(ref),
      ...details,
      hint: "shouldFetch=false — emoji stays on Unicode placeholder until gate opens",
    });
  },

  inlineDecode(
    ref: TelegramEmojiFetchRef,
    path: "tgs" | "video" | "image" | "unsupported",
    mime: string,
    byteLength: number,
  ) {
    if (path === "unsupported") {
      appWarn(TAG, "inline_decode_unsupported", { ref: refLabel(ref), mime, byteLength });
      return;
    }
    const key = `inline:decode:${refLabel(ref)}:${path}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "inline_decode", { ref: refLabel(ref), path, mime, byteLength });
  },

  inlineTgsParseFail(ref: TelegramEmojiFetchRef, err: unknown) {
    appWarn(TAG, "inline_tgs_parse_fail", {
      ref: refLabel(ref),
      err: err instanceof Error ? err.message : String(err),
    });
  },

  inlineAssetNull(ref: TelegramEmojiFetchRef, context: string) {
    appWarn(TAG, "inline_asset_null", {
      ref: refLabel(ref),
      context,
      hint: "fetch returned null — see fetch_http_error or fetch_unavailable_cached",
    });
  },

  inlineFallback(
    ref: TelegramEmojiFetchRef | null,
    fallback: string,
    context: string,
  ) {
    const key = `inline:fallback:${context}:${ref ? refLabel(ref) : "none"}`;
    if (!shouldLog(key)) return;
    appWarn(TAG, "inline_showing_fallback", {
      ref: ref ? refLabel(ref) : null,
      fallback,
      context,
    });
  },

  statusBadgeDecision(details: {
    context: string;
    userId: number | null;
    emojiStatusId: string | null;
    showSpecialBadge: boolean;
    showTelegramEmojiStatus: boolean;
    badgeKind: string | null;
  }) {
    if (!details.emojiStatusId && !details.showSpecialBadge) return;
    const key = `status:${details.context}:${details.userId}:${details.emojiStatusId}:${details.showSpecialBadge}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "emoji_status_badge", details);
  },

  profilePhotoAvatar(details: {
    context: string;
    customEmojiId: string | null;
    fillKind: string | null;
    hasAnimation: boolean;
  }) {
    if (!details.customEmojiId && !details.hasAnimation) return;
    const key = `avatar:${details.context}:${details.customEmojiId}:${details.hasAnimation}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "profile_photo_avatar", details);
  },

  richTextSegments(context: string, text: string, segments: FormattedTextSegment[]) {
    if (!segmentsContainTelegramEmoji(segments)) return;
    const custom = segments.filter((segment) => segment.kind === "custom_emoji");
    const animated = segments.filter((segment) => segment.kind === "animated_emoji");
    const key = `richtext:${context}:${custom.length}:${animated.length}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "rich_text_emoji_segments", {
      context,
      textPreview: text.slice(0, 48),
      customEmojiCount: custom.length,
      animatedEmojiCount: animated.length,
      sampleCustomIds: custom
        .slice(0, 3)
        .map((segment) => (segment.kind === "custom_emoji" ? segment.custom_emoji_id : "")),
      sampleAnimated: animated
        .slice(0, 3)
        .map((segment) => (segment.kind === "animated_emoji" ? segment.emoji : "")),
    });
  },

  chatListSummary(
    rows: Array<{
      peer_emoji_status_custom_emoji_id?: string | null;
      subtitle_segments?: FormattedTextSegment[] | null;
    }>,
  ) {
    const key = "chat_list_summary";
    if (!shouldLog(key)) return;
    const withStatus = rows.filter((row) => row.peer_emoji_status_custom_emoji_id?.trim()).length;
    const withSubtitleEmoji = rows.filter(
      (row) => row.subtitle_segments && segmentsContainTelegramEmoji(row.subtitle_segments),
    ).length;
    const sampleStatusIds = rows
      .filter((row) => row.peer_emoji_status_custom_emoji_id?.trim())
      .slice(0, 3)
      .map((row) => row.peer_emoji_status_custom_emoji_id);
    appLog(TAG, "chat_list_emoji_summary", {
      chatCount: rows.length,
      peerEmojiStatusCount: withStatus,
      subtitleEmojiSegmentCount: withSubtitleEmoji,
      sampleStatusIds,
    });
    if (withStatus === 0 && withSubtitleEmoji === 0) {
      appWarn(TAG, "chat_list_no_emoji_data", {
        hint: "no peer_emoji_status_custom_emoji_id or subtitle emoji segments in chat list payload",
      });
    }
  },

  playerAction(
    action: "ready" | "play" | "pause" | "paint_only" | "dotlottie_construct_fail",
    details: Record<string, unknown>,
  ) {
    const key = `player:${action}:${String(details.reason ?? details.hasCanvas ?? "")}`;
    if (!shouldLog(key)) return;
    appLog(TAG, "player_action", { action, ...details });
  },

  historySummary(
    messages: Array<{
      text_segments?: FormattedTextSegment[] | null;
      sender_emoji_status_custom_emoji_id?: string | null;
    }>,
    chatPeerStatusId?: string | null,
  ) {
    const key = "history_summary";
    if (!shouldLog(key)) return;
    let messageCustomEmoji = 0;
    let messageAnimatedEmoji = 0;
    let senderStatusCount = 0;
    for (const message of messages) {
      const segments = message.text_segments;
      if (segments) {
        for (const segment of segments) {
          if (segment.kind === "custom_emoji") messageCustomEmoji += 1;
          if (segment.kind === "animated_emoji") messageAnimatedEmoji += 1;
        }
      }
      if (message.sender_emoji_status_custom_emoji_id?.trim()) senderStatusCount += 1;
    }
    appLog(TAG, "history_emoji_summary", {
      messageCount: messages.length,
      messageCustomEmojiSegments: messageCustomEmoji,
      messageAnimatedEmojiSegments: messageAnimatedEmoji,
      senderEmojiStatusCount: senderStatusCount,
      chatPeerEmojiStatusId: chatPeerStatusId?.trim() || null,
    });
    if (
      messageCustomEmoji === 0 &&
      messageAnimatedEmoji === 0 &&
      senderStatusCount === 0 &&
      !chatPeerStatusId?.trim()
    ) {
      appWarn(TAG, "history_no_emoji_data", {
        hint: "history API returned no emoji segments or status ids",
      });
    }
  },
};
