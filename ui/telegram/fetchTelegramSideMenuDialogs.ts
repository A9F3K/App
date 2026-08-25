import { buildApiUrl } from "../../api/_base";

export type SideMenuContact = {
  userId: number;
  firstName: string;
  lastName: string;
  title: string;
  username: string | null;
  chatId: number | null;
  presenceKind: "online" | "recently" | "last_week" | "last_month" | "offline" | null;
  presenceAt: string | null;
};

export type SideMenuCreatedChat = {
  telegram_chat_id: number;
  title: string;
  chat_kind: string | null;
};

export type SideMenuActiveVoiceChat = {
  chatId: number;
  title: string;
  chatKind: string | null;
  groupCallId: number | null;
  isJoined: boolean;
};

export type SideMenuCallHistoryRow = {
  chatId: number;
  title: string;
  peerUserId: number | null;
  isOutgoing: boolean;
  isMissed: boolean;
  callCount: number;
  at: string | null;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function fetchTelegramContacts(
  signal?: AbortSignal,
): Promise<{ ok: true; contacts: SideMenuContact[] } | { ok: false; error: string }> {
  const res = await fetch(buildApiUrl("/api/telegram-messages-contacts"), {
    method: "GET",
    credentials: "include",
    signal,
  });
  const json = await readJson(res);
  if (!res.ok || json.ok === false) {
    return { ok: false, error: String(json.error ?? `http_${res.status}`) };
  }
  const contacts: SideMenuContact[] = [];
  for (const row of Array.isArray(json.contacts) ? json.contacts : []) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const userId = Number(item.userId);
    if (!Number.isFinite(userId) || userId === 0) continue;
    const presenceKindRaw = item.presenceKind;
    const presenceKind =
      presenceKindRaw === "online" ||
      presenceKindRaw === "recently" ||
      presenceKindRaw === "last_week" ||
      presenceKindRaw === "last_month" ||
      presenceKindRaw === "offline"
        ? presenceKindRaw
        : null;
    contacts.push({
      userId: Math.trunc(userId),
      firstName: typeof item.firstName === "string" ? item.firstName : "",
      lastName: typeof item.lastName === "string" ? item.lastName : "",
      title: typeof item.title === "string" ? item.title : `User ${userId}`,
      username: typeof item.username === "string" ? item.username : null,
      chatId:
        Number.isFinite(Number(item.chatId)) && Number(item.chatId) !== 0
          ? Math.trunc(Number(item.chatId))
          : null,
      presenceKind,
      presenceAt: typeof item.presenceAt === "string" ? item.presenceAt : null,
    });
  }
  return { ok: true, contacts };
}

export async function addTelegramContact(args: {
  phoneNumber: string;
  firstName: string;
  lastName?: string;
}): Promise<
  | { ok: true; userId: number | null; chatId: number | null }
  | { ok: false; error: string }
> {
  const res = await fetch(buildApiUrl("/api/telegram-messages-contacts"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const json = await readJson(res);
  if (!res.ok || json.ok === false) {
    return { ok: false, error: String(json.error ?? `http_${res.status}`) };
  }
  const userId = Number(json.user_id);
  const chatId = Number(json.chat_id);
  return {
    ok: true,
    userId: Number.isFinite(userId) && userId !== 0 ? Math.trunc(userId) : null,
    chatId: Number.isFinite(chatId) && chatId !== 0 ? Math.trunc(chatId) : null,
  };
}

export async function createTelegramGroup(args: {
  title: string;
  userIds: number[];
}): Promise<{ ok: true; chat: SideMenuCreatedChat } | { ok: false; error: string }> {
  const res = await fetch(buildApiUrl("/api/telegram-messages-create-group"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const json = await readJson(res);
  if (!res.ok || json.ok === false) {
    return { ok: false, error: String(json.error ?? `http_${res.status}`) };
  }
  const chat = (json.chat && typeof json.chat === "object"
    ? json.chat
    : {}) as Record<string, unknown>;
  const chatId = Number(chat.telegram_chat_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "create_group_failed" };
  }
  return {
    ok: true,
    chat: {
      telegram_chat_id: Math.trunc(chatId),
      title: typeof chat.title === "string" ? chat.title : args.title,
      chat_kind: typeof chat.chat_kind === "string" ? chat.chat_kind : null,
    },
  };
}

export async function createTelegramChannel(args: {
  title: string;
  description?: string;
}): Promise<{ ok: true; chat: SideMenuCreatedChat } | { ok: false; error: string }> {
  const res = await fetch(buildApiUrl("/api/telegram-messages-create-channel"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const json = await readJson(res);
  if (!res.ok || json.ok === false) {
    return { ok: false, error: String(json.error ?? `http_${res.status}`) };
  }
  const chat = (json.chat && typeof json.chat === "object"
    ? json.chat
    : {}) as Record<string, unknown>;
  const chatId = Number(chat.telegram_chat_id);
  if (!Number.isFinite(chatId) || chatId === 0) {
    return { ok: false, error: "create_channel_failed" };
  }
  return {
    ok: true,
    chat: {
      telegram_chat_id: Math.trunc(chatId),
      title: typeof chat.title === "string" ? chat.title : args.title,
      chat_kind: typeof chat.chat_kind === "string" ? chat.chat_kind : "channel",
    },
  };
}

export async function fetchTelegramCallsOverview(
  signal?: AbortSignal,
): Promise<
  | {
      ok: true;
      activeVoiceChats: SideMenuActiveVoiceChat[];
      history: SideMenuCallHistoryRow[];
    }
  | { ok: false; error: string }
> {
  const res = await fetch(buildApiUrl("/api/telegram-messages-calls"), {
    method: "GET",
    credentials: "include",
    signal,
  });
  const json = await readJson(res);
  if (!res.ok || json.ok === false) {
    return { ok: false, error: String(json.error ?? `http_${res.status}`) };
  }
  const activeVoiceChats: SideMenuActiveVoiceChat[] = [];
  for (const row of Array.isArray(json.active_voice_chats) ? json.active_voice_chats : []) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const chatId = Number(item.chatId);
    if (!Number.isFinite(chatId) || chatId === 0) continue;
    activeVoiceChats.push({
      chatId: Math.trunc(chatId),
      title: typeof item.title === "string" ? item.title : `Chat ${chatId}`,
      chatKind: typeof item.chatKind === "string" ? item.chatKind : null,
      groupCallId:
        Number.isFinite(Number(item.groupCallId)) && Number(item.groupCallId) !== 0
          ? Math.trunc(Number(item.groupCallId))
          : null,
      isJoined: Boolean(item.isJoined),
    });
  }
  const history: SideMenuCallHistoryRow[] = [];
  for (const row of Array.isArray(json.history) ? json.history : []) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const chatId = Number(item.chatId);
    if (!Number.isFinite(chatId) || chatId === 0) continue;
    history.push({
      chatId: Math.trunc(chatId),
      title: typeof item.title === "string" ? item.title : `Chat ${chatId}`,
      peerUserId:
        Number.isFinite(Number(item.peerUserId)) && Number(item.peerUserId) !== 0
          ? Math.trunc(Number(item.peerUserId))
          : null,
      isOutgoing: Boolean(item.isOutgoing),
      isMissed: Boolean(item.isMissed),
      callCount: Math.max(1, Math.trunc(Number(item.callCount) || 1)),
      at: typeof item.at === "string" ? item.at : null,
    });
  }
  return { ok: true, activeVoiceChats, history };
}
