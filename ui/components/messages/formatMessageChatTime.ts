const MS_PER_DAY = 86_400_000;

function parseMessageTimestamp(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = raw < 12_000_000_000 ? raw * 1000 : raw;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string" && raw.trim()) {
    const t = raw.trim();
    const d = new Date(t.includes("T") ? t : t.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Wall-clock label for open chat headers (HH:mm). */
export function formatMessageChatWallClock(raw: unknown): string {
  const d = parseMessageTimestamp(raw);
  if (!d) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Chat list row time: today → HH:mm; last 7 days → weekday; older → date.
 * Matches Telegram-style chat preview timestamps.
 */
export function formatMessageChatListTime(raw: unknown, locale?: string): string {
  const d = parseMessageTimestamp(raw);
  if (!d) return "";

  const now = new Date();
  const todayStart = startOfLocalDay(now);
  const messageDayStart = startOfLocalDay(d);

  if (messageDayStart.getTime() === todayStart.getTime()) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const dayDiff = Math.floor((todayStart.getTime() - messageDayStart.getTime()) / MS_PER_DAY);
  if (dayDiff > 0 && dayDiff < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(d);
}
