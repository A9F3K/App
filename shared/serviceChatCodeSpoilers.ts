import type { FormattedTextSegment } from "./formattedTextSegments";

/** Official Telegram service notifications account (login codes, etc.). */
export const TELEGRAM_SERVICE_NOTIFICATIONS_USER_ID = 777000;

/**
 * Telegram login codes: 5–7 decimal digits, optionally interleaved with `-`
 * (https://core.telegram.org/api/auth#invalidating-login-codes).
 * Also accepts 4–8 digits and optional spaces / zero-width separators that
 * some clients insert for readability.
 */
const LOGIN_CODE_PATTERN =
  /(?<![\dA-Za-z])(?:\d[\s\u00a0\u200b\u200c\u200d-]*){3,7}\d(?![\dA-Za-z])/g;

function normalizeId(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function textContainsLoginCode(text: string): boolean {
  if (!text) return false;
  LOGIN_CODE_PATTERN.lastIndex = 0;
  return LOGIN_CODE_PATTERN.test(text);
}

function isStandaloneLoginCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  LOGIN_CODE_PATTERN.lastIndex = 0;
  const match = LOGIN_CODE_PATTERN.exec(trimmed);
  return Boolean(match && match[0] === trimmed);
}

export function isTelegramServiceNotificationsChat(
  chatId?: number | string | null,
  peerUserId?: number | string | null,
  senderUserId?: number | string | null,
): boolean {
  const ids = [normalizeId(chatId), normalizeId(peerUserId), normalizeId(senderUserId)];
  return ids.some((id) => id === TELEGRAM_SERVICE_NOTIFICATIONS_USER_ID);
}

function splitTextWithCodeSpoilers(text: string): FormattedTextSegment[] {
  if (!text) return [];
  const out: FormattedTextSegment[] = [];
  let last = 0;
  const pattern = new RegExp(LOGIN_CODE_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const code = match[0]!;
    if (start > last) {
      out.push({ kind: "text", text: text.slice(last, start) });
    }
    out.push({ kind: "spoiler_code", text: code });
    last = start + code.length;
    // Avoid zero-length loops if a weird separator match advances poorly.
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out.length > 0 ? out : [{ kind: "text", text }];
}

/**
 * Hide login / verification digit codes behind a revealable spoiler in Telegram
 * service notification chats (user id 777000).
 */
export function enrichSegmentsWithServiceChatCodeSpoilers(
  segments: FormattedTextSegment[],
): FormattedTextSegment[] {
  if (segments.some((s) => s.kind === "spoiler_code")) return segments;
  const out: FormattedTextSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "link") {
      if (isStandaloneLoginCode(segment.text)) {
        out.push({ kind: "spoiler_code", text: segment.text.trim() });
        continue;
      }
      const split = splitTextWithCodeSpoilers(segment.text);
      if (split.some((row) => row.kind === "spoiler_code")) {
        for (const row of split) {
          if (row.kind === "spoiler_code") {
            out.push(row);
          } else if (row.kind === "text" && row.text) {
            out.push({ kind: "link", text: row.text, url: segment.url });
          }
        }
        continue;
      }
      out.push(segment);
      continue;
    }
    if (segment.kind !== "text" || !segment.text) {
      out.push(segment);
      continue;
    }
    out.push(...splitTextWithCodeSpoilers(segment.text));
  }
  return out;
}

/** Prefer segment enrich; if digits only exist on plain text, rebuild from plain. */
export function enrichServiceChatMessageForCodeSpoilers(
  text: string,
  segments: FormattedTextSegment[] | null | undefined,
): FormattedTextSegment[] {
  const base =
    segments && segments.length > 0 ? segments : text ? [{ kind: "text" as const, text }] : [];
  if (base.length === 0) return base;
  const enriched = enrichSegmentsWithServiceChatCodeSpoilers(base);
  if (enriched.some((s) => s.kind === "spoiler_code")) return enriched;
  if (text && textContainsLoginCode(text)) {
    return enrichSegmentsWithServiceChatCodeSpoilers([{ kind: "text", text }]);
  }
  return enriched;
}
