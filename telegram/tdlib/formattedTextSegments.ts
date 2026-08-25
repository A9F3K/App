import type { FormattedTextSegment } from "../../shared/formattedTextSegments.js";
import {
  enrichSegmentsWithStandardEmojis,
  segmentsContainTelegramEmoji,
  segmentsPlainText,
} from "../../shared/formattedTextSegments.js";
import {
  enrichServiceChatMessageForCodeSpoilers,
  isTelegramServiceNotificationsChat,
} from "../../shared/serviceChatCodeSpoilers.js";
import { readCustomEmojiIdField } from "../../shared/telegramCustomEmojiId.js";


export type { FormattedTextSegment };

type EntityRange = {
  offset: number;
  length: number;
  kind: "custom_emoji" | "link" | "bot_command" | "code";
  custom_emoji_id?: string;
  url?: string;
};

function readTextEntityType(entity: Record<string, unknown>): Record<string, unknown> | null {
  const nested = entity.type;
  if (nested && typeof nested === "object") {
    return nested as Record<string, unknown>;
  }
  return entity;
}

function parseEntityRange(entity: unknown): EntityRange | null {
  if (!entity || typeof entity !== "object") return null;
  const row = entity as Record<string, unknown>;
  const typeRow = readTextEntityType(row);
  if (!typeRow) return null;
  const type = typeRow._;
  const offset = Number(row.offset);
  const length = Number(row.length);
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) return null;

  if (
    type === "messageEntityCustomEmoji" ||
    type === "textEntityTypeCustomEmoji" ||
    type === "textEntityCustomEmoji"
  ) {
    const customEmojiId =
      readCustomEmojiIdField(typeRow) ?? readCustomEmojiIdField(row);
    if (!customEmojiId) return null;
    return { offset, length, kind: "custom_emoji", custom_emoji_id: customEmojiId };
  }
  if (type === "messageEntityTextUrl" || type === "textEntityTypeTextUrl" || type === "textEntityTextUrl") {
    const url = typeof typeRow.url === "string" ? typeRow.url.trim() : "";
    if (!url) return null;
    return { offset, length, kind: "link", url };
  }
  if (type === "messageEntityUrl" || type === "textEntityTypeUrl" || type === "textEntityUrl") {
    return { offset, length, kind: "link" };
  }
  if (
    type === "messageEntityMention" ||
    type === "textEntityTypeMention" ||
    type === "textEntityMention"
  ) {
    // Slice is "@username"; open as t.me link (handled in-app by openMessageLinkUrl).
    return { offset, length, kind: "link" };
  }
  if (
    type === "messageEntityBotCommand" ||
    type === "textEntityTypeBotCommand" ||
    type === "textEntityBotCommand"
  ) {
    return { offset, length, kind: "bot_command" };
  }
  if (
    type === "messageEntityCode" ||
    type === "textEntityTypeCode" ||
    type === "textEntityCode" ||
    type === "messageEntityPre" ||
    type === "textEntityTypePre" ||
    type === "textEntityPre"
  ) {
    // Login codes from 777000 are marked as code entities — keep as text so the
    // client spoiler enricher can hide digit runs (incl. hyphenated codes).
    return { offset, length, kind: "code" };
  }
  return null;
}

export function parseFormattedTextSegments(value: unknown): FormattedTextSegment[] | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as { text?: string; entities?: unknown[] };
  const text = typeof obj.text === "string" ? obj.text : "";
  if (!text) return null;

  const entities = Array.isArray(obj.entities) ? obj.entities : [];
  const ranges: EntityRange[] = [];
  for (const entity of entities) {
    const parsed = parseEntityRange(entity);
    if (parsed) ranges.push(parsed);
  }
  if (ranges.length === 0) return null;

  ranges.sort((a, b) => a.offset - b.offset || b.length - a.length);

  const segments: FormattedTextSegment[] = [];
  let cursor = 0;

  for (const range of ranges) {
    if (range.offset < cursor) continue;
    if (range.offset > text.length) continue;
    const end = Math.min(range.offset + range.length, text.length);
    if (end <= range.offset) continue;

    if (range.offset > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, range.offset) });
    }

    const slice = text.slice(range.offset, end);
    if (range.kind === "custom_emoji") {
      segments.push({
        kind: "custom_emoji",
        text: slice,
        custom_emoji_id: range.custom_emoji_id!,
      });
    } else if (range.kind === "bot_command") {
      segments.push({
        kind: "bot_command",
        text: slice,
        command: slice,
      });
    } else if (range.kind === "code") {
      segments.push({ kind: "text", text: slice });
    } else {
      const rawUrl = range.url ?? slice;
      const mentionUser = slice.startsWith("@") ? slice.slice(1).trim() : "";
      const url =
        !range.url && mentionUser && /^[A-Za-z0-9_]{3,}$/.test(mentionUser)
          ? `https://t.me/${mentionUser}`
          : rawUrl;
      segments.push({
        kind: "link",
        text: slice,
        url,
      });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : null;
}

export function truncatePreviewSegments(
  segments: FormattedTextSegment[],
  maxLen = 240,
): FormattedTextSegment[] {
  const plain = segmentsPlainText(segments);
  if (plain.length <= maxLen) return segments;

  const truncated: FormattedTextSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const remaining = maxLen - used;
    if (remaining <= 0) break;
    if (segment.text.length <= remaining) {
      truncated.push(segment);
      used += segment.text.length;
      continue;
    }
    truncated.push({ ...segment, text: segment.text.slice(0, remaining) });
    break;
  }
  return truncated;
}

export function animatedEmojiSegments(content: Record<string, unknown>): FormattedTextSegment[] | null {
  const animated = content.animated_emoji as Record<string, unknown> | undefined;
  const sticker = animated?.sticker as Record<string, unknown> | undefined;
  const customEmojiId =
    readCustomEmojiIdField(animated ?? {}) ??
    readCustomEmojiIdField(sticker ?? {}) ??
    readCustomEmojiIdField(content);

  const fallback =
    (typeof animated?.emoji === "string" && animated.emoji) ||
    (typeof (content.emoji as { emoji?: string } | undefined)?.emoji === "string"
      ? (content.emoji as { emoji: string }).emoji
      : "") ||
    "";

  if (customEmojiId) {
    return [{ kind: "custom_emoji", text: fallback || "🎭", custom_emoji_id: customEmojiId }];
  }
  if (fallback) {
    return [{ kind: "animated_emoji", text: fallback, emoji: fallback }];
  }
  return null;
}

export function messageTextSegments(
  message: {
  content?: Record<string, unknown> | null;
  chat_id?: number | null;
  sender_id?: { _?: string; user_id?: number } | null;
} | null | undefined,
  options?: {
    enrichStandardEmojis?: boolean;
    /** When set, spoil login codes for Telegram service notifications (777000). */
    serviceChatId?: number | null;
    serviceSenderUserId?: number | null;
    servicePlainText?: string | null;
  },
): FormattedTextSegment[] | null {
  if (!message) return null;
  const content = message.content;
  if (!content || typeof content !== "object") return null;
  const row = content as Record<string, unknown>;
  const type = row._;

  const finalize = (segments: FormattedTextSegment[] | null): FormattedTextSegment[] | null => {
    if (!segments || segments.length === 0) return null;
    let next = segments;
    if (options?.enrichStandardEmojis) {
      next = enrichSegmentsWithStandardEmojis(next);
    }
    const senderUserId =
      options?.serviceSenderUserId ??
      (message.sender_id?._ === "messageSenderUser" && typeof message.sender_id.user_id === "number"
        ? message.sender_id.user_id
        : null);
    const chatId = options?.serviceChatId ?? (typeof message.chat_id === "number" ? message.chat_id : null);
    if (isTelegramServiceNotificationsChat(chatId, null, senderUserId)) {
      const plain =
        typeof options?.servicePlainText === "string" && options.servicePlainText
          ? options.servicePlainText
          : segmentsPlainText(next);
      next = enrichServiceChatMessageForCodeSpoilers(plain, next);
    }
    return next.length > 0 ? next : null;
  };

  if (type === "messageText") {
    const parsed = parseFormattedTextSegments(row.text);
    if (parsed) return finalize(parsed);
    const plain = typeof (row.text as { text?: string } | undefined)?.text === "string"
      ? (row.text as { text: string }).text
      : "";
    return plain ? finalize([{ kind: "text", text: plain }]) : null;
  }
  if (type === "messageAnimatedEmoji") {
    return animatedEmojiSegments(row);
  }
  if (
    type === "messagePhoto" ||
    type === "messageVideo" ||
    type === "messageDocument" ||
    type === "messageAnimation" ||
    type === "messageAudio" ||
    type === "messageVoiceNote" ||
    type === "messagePaidMedia"
  ) {
    return finalize(parseFormattedTextSegments(row.caption));
  }
  if (type === "messageWebPage") {
    return finalize(parseFormattedTextSegments(row.caption));
  }
  return null;
}

export function previewSegmentsFromMessage(message: {
  content?: Record<string, unknown> | null;
} | null | undefined): FormattedTextSegment[] | null {
  const segments = messageTextSegments(message);
  if (!segments) return null;
  if (!segmentsContainTelegramEmoji(segments)) return null;
  return truncatePreviewSegments(segments);
}
