import type { Client } from "tdl";
import {
  presenceFromTdlibStatus,
  usernameFromTdUser,
  type ChatPresenceKind,
} from "./chatPreview.js";
import { requireReadySession } from "./connectAttempts.js";
import { getLiveChatList, patchLiveChatFromTdlib, type LiveChatRow } from "./liveChatCache.js";
import { logGateway } from "./gatewayLog.js";

export type SideMenuContactRow = {
  userId: number;
  firstName: string;
  lastName: string;
  title: string;
  username: string | null;
  chatId: number | null;
  presenceKind: ChatPresenceKind | null;
  presenceAt: string | null;
};

export type SideMenuCreatedChat = {
  chatId: number;
  title: string;
  chatKind: "group" | "supergroup" | "channel" | "private" | null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function chatKindFromTd(chat: Record<string, unknown>): SideMenuCreatedChat["chatKind"] {
  const type = asRecord(chat.type);
  const id = typeof type?._ === "string" ? type._ : "";
  if (id === "chatTypePrivate") return "private";
  if (id === "chatTypeBasicGroup") return "group";
  if (id === "chatTypeSupergroup") {
    return type?.is_channel === true ? "channel" : "supergroup";
  }
  return null;
}

async function ensurePrivateChatId(
  client: Client,
  userId: number,
): Promise<number | null> {
  try {
    const chat = (await client.invoke({
      _: "createPrivateChat",
      user_id: userId,
      force: true,
    })) as { id?: number };
    return typeof chat.id === "number" ? chat.id : null;
  } catch {
    return null;
  }
}

export async function listSideMenuContactsForUser(
  telegramUsername: string,
): Promise<SideMenuContactRow[]> {
  const record = await requireReadySession(telegramUsername, 90_000);
  if (!record) return [];

  try {
    const result = (await record.client.invoke({ _: "getContacts" })) as {
      user_ids?: number[];
    };
    const rows: SideMenuContactRow[] = [];
    for (const userId of result.user_ids ?? []) {
      if (!Number.isFinite(userId) || userId <= 0) continue;
      const trunc = Math.trunc(userId);
      const user = (await record.client.invoke({
        _: "getUser",
        user_id: trunc,
      })) as Record<string, unknown>;
      const firstName =
        typeof user.first_name === "string" ? user.first_name.trim() : "";
      const lastName =
        typeof user.last_name === "string" ? user.last_name.trim() : "";
      const title = [firstName, lastName].filter(Boolean).join(" ") || `User ${trunc}`;
      const presence = presenceFromTdlibStatus(user.status);
      const chatId = await ensurePrivateChatId(record.client, trunc);
      rows.push({
        userId: trunc,
        firstName,
        lastName,
        title,
        username: usernameFromTdUser(user),
        chatId,
        presenceKind: presence?.kind ?? null,
        presenceAt: presence?.at ?? null,
      });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    return rows;
  } catch (err) {
    logGateway("side_menu_contacts_fail", {
      telegramUsername,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function addSideMenuContactForUser(
  telegramUsername: string,
  args: {
    phoneNumber: string;
    firstName: string;
    lastName?: string;
  },
): Promise<{ ok: true; userId: number | null; chatId: number | null } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return { ok: false, error: "session_not_ready" };

  const phone = args.phoneNumber.trim();
  const firstName = args.firstName.trim();
  if (!phone || !firstName) return { ok: false, error: "phone_and_name_required" };

  try {
    const imported = (await record.client.invoke({
      _: "importContacts",
      contacts: [
        {
          _: "importedContact",
          phone_number: phone,
          first_name: firstName,
          last_name: (args.lastName ?? "").trim(),
          note: null,
        },
      ],
    })) as { user_ids?: number[] };
    const userIdRaw = imported.user_ids?.[0];
    const userId =
      typeof userIdRaw === "number" && Number.isFinite(userIdRaw) && userIdRaw > 0
        ? Math.trunc(userIdRaw)
        : null;
    const chatId = userId != null ? await ensurePrivateChatId(record.client, userId) : null;
    return { ok: true, userId, chatId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "import_contacts_failed",
    };
  }
}

export async function createSideMenuGroupForUser(
  telegramUsername: string,
  args: { title: string; userIds: number[] },
): Promise<{ ok: true; chat: SideMenuCreatedChat } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return { ok: false, error: "session_not_ready" };

  const title = args.title.trim();
  if (!title) return { ok: false, error: "title_required" };
  const userIds = [
    ...new Set(
      args.userIds
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .map((id) => Math.trunc(id)),
    ),
  ];

  try {
    // Prefer basic group when members are known; empty member set → supergroup.
    if (userIds.length > 0) {
      const created = (await record.client.invoke({
        _: "createNewBasicGroupChat",
        user_ids: userIds,
        title,
        message_auto_delete_time: 0,
      })) as { chat_id?: number; id?: number };
      // Newer TDLib returns createdBasicGroupChat.chat_id; older builds returned chat.id.
      const chatId = Number(created.chat_id ?? created.id);
      if (!Number.isFinite(chatId) || chatId === 0) {
        return { ok: false, error: "create_group_failed" };
      }
      const chat = (await record.client.invoke({
        _: "getChat",
        chat_id: Math.trunc(chatId),
      })) as Record<string, unknown>;
      try {
        await patchLiveChatFromTdlib(telegramUsername, chat as never, {});
      } catch {
        // ignore cache patch failures
      }
      return {
        ok: true,
        chat: {
          chatId: Math.trunc(chatId),
          title:
            typeof chat.title === "string" && chat.title.trim()
              ? chat.title.trim()
              : title,
          chatKind: chatKindFromTd(chat) ?? "group",
        },
      };
    }

    const chat = (await record.client.invoke({
      _: "createNewSupergroupChat",
      title,
      is_forum: false,
      is_channel: false,
      description: "",
      location: null,
      message_auto_delete_time: 0,
      for_import: false,
    })) as Record<string, unknown>;
    const chatId = Number(chat.id);
    if (!Number.isFinite(chatId) || chatId === 0) {
      return { ok: false, error: "create_group_failed" };
    }
    try {
      await patchLiveChatFromTdlib(telegramUsername, chat as never, {});
    } catch {
      // ignore
    }
    return {
      ok: true,
      chat: {
        chatId: Math.trunc(chatId),
        title:
          typeof chat.title === "string" && chat.title.trim()
            ? chat.title.trim()
            : title,
        chatKind: chatKindFromTd(chat) ?? "supergroup",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "create_group_failed",
    };
  }
}

export async function createSideMenuChannelForUser(
  telegramUsername: string,
  args: { title: string; description?: string },
): Promise<{ ok: true; chat: SideMenuCreatedChat } | { ok: false; error: string }> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return { ok: false, error: "session_not_ready" };

  const title = args.title.trim();
  if (!title) return { ok: false, error: "title_required" };

  try {
    const chat = (await record.client.invoke({
      _: "createNewSupergroupChat",
      title,
      is_forum: false,
      is_channel: true,
      description: (args.description ?? "").trim(),
      location: null,
      message_auto_delete_time: 0,
      for_import: false,
    })) as Record<string, unknown>;
    const chatId = Number(chat.id);
    if (!Number.isFinite(chatId) || chatId === 0) {
      return { ok: false, error: "create_channel_failed" };
    }
    try {
      await patchLiveChatFromTdlib(telegramUsername, chat as never, {});
    } catch {
      // ignore
    }
    return {
      ok: true,
      chat: {
        chatId: Math.trunc(chatId),
        title:
          typeof chat.title === "string" && chat.title.trim()
            ? chat.title.trim()
            : title,
        chatKind: "channel",
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "create_channel_failed",
    };
  }
}

export function listActiveVoiceChatsForUser(
  telegramUsername: string,
): LiveChatRow[] {
  const rows = getLiveChatList(telegramUsername) ?? [];
  return rows.filter((row) => row.has_active_voice_chat);
}

export async function listSideMenuCallHistoryForUser(
  telegramUsername: string,
  limit = 40,
): Promise<SideMenuCallHistoryRow[]> {
  const record = await requireReadySession(telegramUsername, 30_000);
  if (!record) return [];

  try {
    const found = (await record.client.invoke({
      _: "searchCallMessages",
      offset: "",
      limit: Math.min(100, Math.max(1, Math.trunc(limit))),
      only_missed: false,
    })) as { messages?: unknown[] };

    type Agg = {
      chatId: number;
      title: string;
      peerUserId: number | null;
      isOutgoing: boolean;
      isMissed: boolean;
      callCount: number;
      at: string | null;
      sortAt: number;
    };
    const byChat = new Map<number, Agg>();

    for (const raw of found.messages ?? []) {
      const msg = asRecord(raw);
      if (!msg) continue;
      const chatId = Number(msg.chat_id);
      if (!Number.isFinite(chatId) || chatId === 0) continue;
      const content = asRecord(msg.content);
      if (!content || content._ !== "messageCall") continue;
      const dateSec = Number(msg.date);
      const sortAt =
        Number.isFinite(dateSec) && dateSec > 0 ? dateSec * 1000 : Date.now();
      const isOutgoing = Boolean(msg.is_outgoing);
      const discard =
        typeof content.discard_reason === "object" && content.discard_reason
          ? String((content.discard_reason as { _?: string })._ ?? "")
          : "";
      const isMissed =
        discard.includes("Missed") ||
        discard.includes("Declined") ||
        (!isOutgoing && Number(content.duration) === 0);

      let title = `Chat ${chatId}`;
      let peerUserId: number | null = null;
      try {
        const chat = (await record.client.invoke({
          _: "getChat",
          chat_id: Math.trunc(chatId),
        })) as Record<string, unknown>;
        if (typeof chat.title === "string" && chat.title.trim()) {
          title = chat.title.trim();
        }
        const type = asRecord(chat.type);
        if (type?._ === "chatTypePrivate") {
          const uid = Number(type.user_id);
          if (Number.isFinite(uid) && uid !== 0) peerUserId = Math.trunc(uid);
        }
      } catch {
        // keep fallback title
      }

      const prev = byChat.get(Math.trunc(chatId));
      if (!prev) {
        byChat.set(Math.trunc(chatId), {
          chatId: Math.trunc(chatId),
          title,
          peerUserId,
          isOutgoing,
          isMissed,
          callCount: 1,
          at: new Date(sortAt).toISOString(),
          sortAt,
        });
      } else {
        prev.callCount += 1;
        if (sortAt >= prev.sortAt) {
          prev.sortAt = sortAt;
          prev.at = new Date(sortAt).toISOString();
          prev.isOutgoing = isOutgoing;
          prev.isMissed = isMissed;
          prev.title = title;
          prev.peerUserId = peerUserId;
        }
      }
    }

    return [...byChat.values()]
      .sort((a, b) => b.sortAt - a.sortAt)
      .map(({ sortAt: _s, ...row }) => row);
  } catch (err) {
    logGateway("side_menu_call_history_fail", {
      telegramUsername,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
