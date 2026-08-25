import { buildApiUrl } from "../../api/_base";
import { openAuthenticatedHomeChatHistory } from "../authenticatedHomeSelectedChat";
import type { MessageChatRowData, MessageChatKind } from "../components/messages/MessageChatRow";
import {
  findTelegramChatByUsername,
  upsertTelegramChatDirectoryEntry,
} from "./telegramChatDirectory";

function normalizeResolvedChat(raw: unknown): MessageChatRowData | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const telegramChatId = Number(row.telegram_chat_id);
  if (!Number.isFinite(telegramChatId)) return null;

  const chatKindRaw = row.chat_kind;
  const chatKind: MessageChatKind | null =
    chatKindRaw === "private" ||
    chatKindRaw === "group" ||
    chatKindRaw === "supergroup" ||
    chatKindRaw === "channel"
      ? chatKindRaw
      : null;

  const peerUsername =
    typeof row.peer_username === "string" && row.peer_username.trim()
      ? row.peer_username.trim().replace(/^@+/, "")
      : null;
  const chatUsername =
    typeof row.chat_username === "string" && row.chat_username.trim()
      ? row.chat_username.trim().replace(/^@+/, "")
      : null;

  return {
    id: Number.isFinite(Number(row.id)) ? Number(row.id) : telegramChatId,
    telegram_chat_id: telegramChatId,
    title: typeof row.title === "string" ? row.title : peerUsername || chatUsername || "Chat",
    subtitle: typeof row.subtitle === "string" ? row.subtitle : "",
    avatar_url: typeof row.avatar_url === "string" ? row.avatar_url : null,
    last_message_at:
      typeof row.last_message_at === "string" || typeof row.last_message_at === "number"
        ? String(row.last_message_at)
        : null,
    unread_count: Number.isFinite(Number(row.unread_count)) ? Number(row.unread_count) : 0,
    peer_user_id: Number.isFinite(Number(row.peer_user_id)) ? Number(row.peer_user_id) : null,
    peer_username: peerUsername,
    chat_username: chatUsername,
    chat_kind: chatKind,
    member_count: null,
    presence_kind: null,
    presence_at: null,
    chat_action: null,
    chat_action_user_id: null,
    chat_action_user_name: null,
    chat_action_expires_at: null,
    is_pinned: false,
    last_read_outbox_message_id: null,
  };
}

const RESERVED_TME_PATHS = new Set([
  "share",
  "joinchat",
  "addstickers",
  "addemoji",
  "addtheme",
  "setlanguage",
  "proxy",
  "socks",
  "iv",
  "login",
  "confirmphone",
  "msg",
  "invoice",
]);

/**
 * Extract a public @username from t.me / telegram.me / tg://resolve links.
 * Returns null for invite hashes, private c/ links, and reserved paths.
 */
export function extractTelegramUsernameFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const tgResolve = /^tg:\/\/resolve\?(?:.*&)?domain=([A-Za-z0-9_]{3,})/i.exec(trimmed);
  if (tgResolve?.[1]) return tgResolve[1];

  let parsed: URL | null = null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : /^t\.me\//i.test(trimmed) || /^telegram\.me\//i.test(trimmed)
        ? `https://${trimmed}`
        : trimmed;
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "t.me" && host !== "telegram.me" && host !== "telegram.dog") {
    return null;
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  let candidate = parts[0]!;
  if (candidate.toLowerCase() === "s" && parts[1]) {
    candidate = parts[1]!;
  }
  if (RESERVED_TME_PATHS.has(candidate.toLowerCase())) return null;
  if (candidate.toLowerCase() === "c") return null;
  if (candidate.startsWith("+")) return null;
  if (!/^[A-Za-z0-9_]{3,}$/.test(candidate)) return null;
  return candidate;
}

/** True when this URL/text is a public Telegram username entity we should keep in-app. */
export function isInAppTelegramUsernameLink(urlOrMention: string): boolean {
  const trimmed = urlOrMention.trim();
  if (!trimmed) return false;
  if (extractTelegramUsernameFromMention(trimmed)) return true;
  return Boolean(extractTelegramUsernameFromUrl(trimmed));
}

export function extractTelegramUsernameFromMention(text: string): string | null {
  const m = /^@([A-Za-z0-9_]{3,})$/.exec(text.trim());
  return m?.[1] ?? null;
}

/** Resolve a public username and open the chat in Hyperlinks Space. */
export async function openTelegramUsernameInApp(username: string): Promise<boolean> {
  const clean = username.trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{3,}$/.test(clean)) return false;

  const local = findTelegramChatByUsername(clean);
  if (local) {
    openAuthenticatedHomeChatHistory(local);
    return true;
  }

  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-resolve-chat?username=${encodeURIComponent(clean)}`),
      { credentials: "include" },
    );
    const json = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      chat?: unknown;
    };
    if (response.ok && json.ok && json.chat) {
      const chat = normalizeResolvedChat(json.chat);
      if (chat) {
        upsertTelegramChatDirectoryEntry(chat);
        openAuthenticatedHomeChatHistory(chat);
        return true;
      }
    }
  } catch {
    /* fall through */
  }
  return false;
}

/**
 * Try opening a message URL as an in-app Telegram entity.
 * Returns true when handled inside the app.
 */
export async function tryOpenTelegramEntityInApp(url: string): Promise<boolean> {
  const username = extractTelegramUsernameFromUrl(url);
  if (!username) return false;
  return openTelegramUsernameInApp(username);
}
