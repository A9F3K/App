import type { Client } from "tdl";
import { formattedTextPlain, type TdChat } from "./chatPreview.js";
import { emojiStatusCustomIdFromUser } from "./emojiStatus.js";
import { userDisplayNameFromTdUser, isBotFromTdUser } from "./tdUserProfile.js";
import {
  listUserProfileAudios,
  parseTdProfileAudio,
  type TelegramProfileAudioTrack,
} from "./profileMusic.js";

export type { TelegramProfileAudioTrack };

export type TelegramUserProfilePayload = {
  user_id: number | null;
  chat_id: number;
  title: string;
  username: string | null;
  bio: string | null;
  phone_number: string | null;
  status_text: string | null;
  is_bot: boolean;
  is_blocked: boolean;
  emoji_status_custom_emoji_id: string | null;
  music: { artist: string; title: string } | null;
  playlist: TelegramProfileAudioTrack[];
  channel: {
    chat_id: number;
    title: string;
    subtitle: string | null;
  } | null;
  media: {
    marked: number;
    images: number;
    photos: number;
    links: number;
    gifs: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function usernameFromTdUser(user: Record<string, unknown>): string | null {
  const usernames = asRecord(user.usernames);
  const active = Array.isArray(usernames?.active_usernames)
    ? usernames.active_usernames.find((u) => typeof u === "string" && u.trim())
    : null;
  const editable =
    typeof usernames?.editable_username === "string" && usernames.editable_username.trim()
      ? usernames.editable_username.trim()
      : null;
  const legacy =
    typeof user.username === "string" && user.username.trim() ? user.username.trim() : null;
  const raw = (typeof active === "string" ? active.trim() : null) || editable || legacy;
  return raw ? raw.replace(/^@+/, "") : null;
}

function phoneFromTdUser(user: Record<string, unknown>): string | null {
  const phone =
    typeof user.phone_number === "string" && user.phone_number.trim()
      ? user.phone_number.trim()
      : null;
  if (!phone) return null;
  if (phone.startsWith("+")) return phone;
  return `+${phone}`;
}

/** Collectible / premium emoji status title when Telegram exposes one. */
function statusTextFromTdUser(user: Record<string, unknown>): string | null {
  const emojiStatus = asRecord(user.emoji_status);
  if (!emojiStatus) return null;
  for (const key of ["title", "name", "custom_emoji_name"] as const) {
    const value = emojiStatus[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const type = asRecord(emojiStatus.type);
  if (type) {
    for (const key of ["title", "name"] as const) {
      const value = type[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function musicFromTdUser(user: Record<string, unknown>): { artist: string; title: string } | null {
  const emojiStatus = asRecord(user.emoji_status);
  const type = asRecord(emojiStatus?.type);
  if (!type) return null;
  const typeId = typeof type._ === "string" ? type._ : "";
  if (
    !typeId.toLowerCase().includes("music") &&
    !typeId.toLowerCase().includes("listen") &&
    typeId !== "emojiStatusTypeRingtone"
  ) {
    // Some builds nest artist/title without a music type id — still accept if both present.
    const artistGuess =
      typeof type.artist === "string"
        ? type.artist
        : typeof type.performer === "string"
          ? type.performer
          : null;
    const titleGuess = typeof type.title === "string" ? type.title : null;
    if (!artistGuess?.trim() && !titleGuess?.trim()) return null;
  }
  const artist =
    (typeof type.artist === "string" && type.artist.trim()) ||
    (typeof type.performer === "string" && type.performer.trim()) ||
    "";
  const title =
    (typeof type.title === "string" && type.title.trim()) ||
    (typeof type.name === "string" && type.name.trim()) ||
    "";
  if (!artist && !title) return null;
  return { artist: artist || title, title: artist && title ? title : "" };
}

type ChatMessageSearchFilter =
  | "searchMessagesFilterPinned"
  | "searchMessagesFilterVideo"
  | "searchMessagesFilterPhoto"
  | "searchMessagesFilterUrl"
  | "searchMessagesFilterAnimation";

async function chatMessageCount(
  client: Client,
  chatId: number,
  filterType: ChatMessageSearchFilter,
): Promise<number> {
  try {
    const result = (await client.invoke({
      _: "getChatMessageCount",
      chat_id: chatId,
      filter: { _: filterType },
      return_local: false,
    })) as { count?: number; _?: string };
    const count = Number(result.count);
    return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  } catch {
    return 0;
  }
}

async function loadMediaCounts(
  client: Client,
  chatId: number,
): Promise<TelegramUserProfilePayload["media"]> {
  const [marked, images, photos, links, gifs] = await Promise.all([
    chatMessageCount(client, chatId, "searchMessagesFilterPinned"),
    chatMessageCount(client, chatId, "searchMessagesFilterVideo"),
    chatMessageCount(client, chatId, "searchMessagesFilterPhoto"),
    chatMessageCount(client, chatId, "searchMessagesFilterUrl"),
    chatMessageCount(client, chatId, "searchMessagesFilterAnimation"),
  ]);
  return { marked, images, photos, links, gifs };
}

async function loadPersonalChannel(
  client: Client,
  personalChatId: number,
): Promise<TelegramUserProfilePayload["channel"]> {
  if (!Number.isFinite(personalChatId) || personalChatId === 0) return null;
  try {
    const chat = (await client.invoke({
      _: "getChat",
      chat_id: personalChatId,
    })) as TdChat & { title?: string };
    const title = typeof chat.title === "string" ? chat.title.trim() : "";
    if (!title) return null;
    let subtitle: string | null = null;
    const type = asRecord(chat.type);
    if (type?._ === "chatTypeSupergroup" && Number(type.supergroup_id) > 0) {
      const supergroupId = Math.trunc(Number(type.supergroup_id));
      try {
        const sg = (await client.invoke({
          _: "getSupergroup",
          supergroup_id: supergroupId,
        })) as Record<string, unknown>;
        const channelUsername = usernameFromTdUser(sg);
        if (channelUsername) subtitle = `@${channelUsername}`;
      } catch {
        // ignore
      }
      try {
        const full = (await client.invoke({
          _: "getSupergroupFullInfo",
          supergroup_id: supergroupId,
        })) as { description?: string };
        if (typeof full.description === "string" && full.description.trim()) {
          // Prefer first line of description when present (design sheet subtitle).
          const firstLine = full.description.trim().split(/\r?\n/)[0]?.trim() || null;
          if (firstLine) subtitle = firstLine;
        }
      } catch {
        // keep username subtitle if any
      }
    }
    return {
      chat_id: Math.trunc(personalChatId),
      title,
      subtitle,
    };
  } catch {
    return null;
  }
}

async function resolveUserIdFromChat(
  client: Client,
  chatId: number,
): Promise<number | null> {
  if (!Number.isFinite(chatId) || chatId === 0) return null;
  try {
    const chat = (await client.invoke({
      _: "getChat",
      chat_id: Math.trunc(chatId),
    })) as TdChat;
    const type = asRecord(chat.type);
    if (type?._ === "chatTypePrivate" && Number(type.user_id) > 0) {
      return Math.trunc(Number(type.user_id));
    }
  } catch {
    // ignore
  }
  return null;
}

function formatPhoneDisplay(phone: string | null): string | null {
  if (!phone) return null;
  const raw = phone.trim();
  if (!raw) return null;
  // Keep leading +, strip other non-digits for grouping.
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return plus ? `+${digits}` : raw;
  // +7 XXX XXX XX XX / +N … (last 10 grouped loosely)
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
  }
  if (digits.length === 10) {
    return `${plus ? "+" : ""}${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  // Generic: country code (1–3) + rest in chunks of 3
  const ccLen = digits.length > 10 ? Math.min(3, digits.length - 7) : 1;
  const cc = digits.slice(0, ccLen);
  const rest = digits.slice(ccLen);
  const parts = rest.match(/.{1,3}/g) ?? [rest];
  return `${plus || ccLen > 0 ? "+" : ""}${cc} ${parts.join(" ")}`.trim();
}

export async function fetchTelegramUserProfile(
  client: Client,
  chatId: number,
  peerUserId: number | null,
): Promise<TelegramUserProfilePayload> {
  const emptyMedia = { marked: 0, images: 0, photos: 0, links: 0, gifs: 0 };
  let resolvedChatId =
    Number.isFinite(chatId) && chatId !== 0 ? Math.trunc(chatId) : 0;
  let resolvedUserId =
    peerUserId != null && Number.isFinite(peerUserId) && peerUserId !== 0
      ? Math.trunc(peerUserId)
      : null;

  // Private DM opens often omit peer_user_id — recover it from chatTypePrivate.
  if (resolvedUserId == null && resolvedChatId !== 0) {
    resolvedUserId = await resolveUserIdFromChat(client, resolvedChatId);
  }

  // Voice / group avatar clicks often only have user_id — open (or create) the
  // private chat so media counts and avatar proxy still resolve.
  if (resolvedUserId != null && resolvedChatId === 0) {
    try {
      const privateChat = (await client.invoke({
        _: "createPrivateChat",
        user_id: resolvedUserId,
        force: false,
      })) as { id?: number };
      const id = Number(privateChat.id);
      if (Number.isFinite(id) && id !== 0) resolvedChatId = Math.trunc(id);
    } catch {
      // keep 0 — profile fields still load from getUser / getUserFullInfo
    }
  }

  const base: TelegramUserProfilePayload = {
    user_id: resolvedUserId,
    chat_id: resolvedChatId,
    title: "",
    username: null,
    bio: null,
    phone_number: null,
    status_text: null,
    is_bot: false,
    is_blocked: false,
    emoji_status_custom_emoji_id: null,
    music: null,
    playlist: [],
    channel: null,
    media: emptyMedia,
  };

  const mediaPromise =
    resolvedChatId !== 0
      ? loadMediaCounts(client, resolvedChatId)
      : Promise.resolve(emptyMedia);
  const playlistPromise =
    resolvedUserId != null
      ? listUserProfileAudios(client, resolvedUserId)
      : Promise.resolve([] as TelegramProfileAudioTrack[]);

  if (resolvedUserId != null) {
    try {
      const user = (await client.invoke({
        _: "getUser",
        user_id: resolvedUserId,
      })) as Record<string, unknown>;
      base.title = userDisplayNameFromTdUser(user);
      base.username = usernameFromTdUser(user);
      base.phone_number = formatPhoneDisplay(phoneFromTdUser(user));
      base.status_text = statusTextFromTdUser(user);
      base.is_bot = isBotFromTdUser(user);
      base.emoji_status_custom_emoji_id = emojiStatusCustomIdFromUser(user);
      base.music = musicFromTdUser(user);
    } catch {
      // keep defaults
    }

    try {
      const full = (await client.invoke({
        _: "getUserFullInfo",
        user_id: resolvedUserId,
      })) as {
        bio?: unknown;
        bot_info?: { description?: string };
        personal_chat_id?: number;
        personalChatId?: number;
        first_profile_audio?: unknown;
        firstProfileAudio?: unknown;
      };
      const bio = formattedTextPlain(full.bio)?.trim() || null;
      if (bio) base.bio = bio;
      else if (typeof full.bot_info?.description === "string" && full.bot_info.description.trim()) {
        base.bio = full.bot_info.description.trim();
      }
      const firstAudio = parseTdProfileAudio(
        full.first_profile_audio ?? full.firstProfileAudio,
        resolvedUserId,
      );
      if (firstAudio) {
        base.music = {
          artist: firstAudio.artist,
          title: firstAudio.title,
        };
        base.playlist = [firstAudio];
      }
      const personalChatId = Number(
        full.personal_chat_id ?? full.personalChatId ?? 0,
      );
      if (Number.isFinite(personalChatId) && personalChatId !== 0) {
        base.channel = await loadPersonalChannel(client, personalChatId);
      }
    } catch {
      // keep defaults
    }

    base.is_blocked = await isUserBlocked(client, resolvedUserId);
  } else if (resolvedChatId !== 0) {
    try {
      const chat = (await client.invoke({
        _: "getChat",
        chat_id: resolvedChatId,
      })) as TdChat & { title?: string };
      base.title = chat.title?.trim() || "";
      const type = asRecord(chat.type);
      if (type?._ === "chatTypeSupergroup" && Number(type.supergroup_id) > 0) {
        const supergroupId = Math.trunc(Number(type.supergroup_id));
        try {
          const sg = (await client.invoke({
            _: "getSupergroup",
            supergroup_id: supergroupId,
          })) as Record<string, unknown>;
          base.username = usernameFromTdUser(sg);
        } catch {
          // ignore
        }
        try {
          const full = (await client.invoke({
            _: "getSupergroupFullInfo",
            supergroup_id: supergroupId,
          })) as { description?: string };
          if (typeof full.description === "string" && full.description.trim()) {
            base.bio = full.description.trim();
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // keep defaults
    }
  }

  const [media, playlist] = await Promise.all([mediaPromise, playlistPromise]);
  base.media = media;
  if (playlist.length > 0) {
    base.playlist = playlist;
    const first = playlist[0]!;
    base.music = { artist: first.artist, title: first.title };
  }
  return base;
}

export async function blockTelegramUser(
  client: Client,
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  try {
    await client.invoke({
      _: "setMessageSenderBlockList",
      sender_id: { _: "messageSenderUser", user_id: Math.trunc(userId) },
      block_list: { _: "blockListMain" },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "block_failed" };
  }
}

export async function unblockTelegramUser(
  client: Client,
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  try {
    await client.invoke({
      _: "setMessageSenderBlockList",
      sender_id: { _: "messageSenderUser", user_id: Math.trunc(userId) },
      block_list: undefined,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "unblock_failed" };
  }
}

async function isUserBlocked(client: Client, userId: number): Promise<boolean> {
  try {
    const full = (await client.invoke({
      _: "getUserFullInfo",
      user_id: userId,
    })) as { is_blocked?: boolean; block_list?: { _?: string } | null };
    if (full.is_blocked === true) return true;
    if (full.block_list && typeof full.block_list === "object") {
      const id = full.block_list._;
      if (id === "blockListMain" || id === "blockListStories") return true;
    }
  } catch {
    // fall through to blocked senders scan
  }
  try {
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const result = (await client.invoke({
        _: "getBlockedMessageSenders",
        block_list: { _: "blockListMain" },
        offset,
        limit: 100,
      })) as {
        senders?: Array<{ _?: string; user_id?: number }>;
        total_count?: number;
      };
      const senders = Array.isArray(result.senders) ? result.senders : [];
      if (
        senders.some(
          (s) => s._ === "messageSenderUser" && Number(s.user_id) === userId,
        )
      ) {
        return true;
      }
      if (senders.length === 0) break;
      offset += senders.length;
      if (offset >= Number(result.total_count ?? 0)) break;
    }
  } catch {
    return false;
  }
  return false;
}

export type ProfileMediaKind = "marked" | "images" | "photos" | "links" | "gifs";

export type ChatMediaSearchItem = {
  telegram_message_id: number;
  date: string | null;
  text: string;
  url: string;
  kind: ProfileMediaKind;
  sender_name: string;
};

/** @deprecated Prefer ChatMediaSearchItem — kept for gateway clients still expecting `links`. */
export type ChatLinkSearchItem = ChatMediaSearchItem;

const MEDIA_KIND_FILTER: Record<ProfileMediaKind, ChatMessageSearchFilter> = {
  marked: "searchMessagesFilterPinned",
  images: "searchMessagesFilterVideo",
  photos: "searchMessagesFilterPhoto",
  links: "searchMessagesFilterUrl",
  gifs: "searchMessagesFilterAnimation",
};

function isProfileMediaKind(value: unknown): value is ProfileMediaKind {
  return (
    value === "marked" ||
    value === "images" ||
    value === "photos" ||
    value === "links" ||
    value === "gifs"
  );
}

function mediaItemFromMessage(
  msg: {
    id?: number;
    date?: number;
    content?: {
      _?: string;
      text?: {
        text?: string;
        entities?: Array<{
          _?: string;
          type?: { _?: string; url?: string };
          offset?: number;
          length?: number;
        }>;
      };
      caption?: {
        text?: string;
        entities?: Array<{
          _?: string;
          type?: { _?: string; url?: string };
          offset?: number;
          length?: number;
        }>;
      };
      url?: string;
      web_page?: { url?: string; display_url?: string; title?: string; description?: string };
    };
  },
  kind: ProfileMediaKind,
): ChatMediaSearchItem | null {
  const id = Number(msg.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const content = msg.content;
  const textBody =
    content?._ === "messageText" ? content.text : content?.caption;
  const plain =
    (typeof textBody?.text === "string" && textBody.text.trim()) ||
    (typeof content?.web_page?.title === "string" && content.web_page.title.trim()) ||
    (typeof content?.web_page?.description === "string" &&
      content.web_page.description.trim()) ||
    "";
  let url =
    (typeof content?.url === "string" && content.url.trim()) ||
    (typeof content?.web_page?.url === "string" && content.web_page.url.trim()) ||
    (typeof content?.web_page?.display_url === "string" &&
      content.web_page.display_url.trim()) ||
    "";
  if (!url && Array.isArray(textBody?.entities)) {
    for (const ent of textBody.entities) {
      const typeId = ent.type?._;
      if (
        typeId === "textEntityTypeUrl" &&
        plain &&
        ent.offset != null &&
        ent.length != null
      ) {
        url = plain.slice(ent.offset, ent.offset + ent.length).trim();
        if (url) break;
      }
      if (typeId === "textEntityTypeTextUrl" && typeof ent.type?.url === "string") {
        url = ent.type.url.trim();
        if (url) break;
      }
    }
  }
  if (!url) {
    const match = plain.match(/https?:\/\/[^\s]+/i);
    if (match) url = match[0];
  }
  if (kind === "links" && !url) return null;

  const fallbackLabel =
    kind === "marked"
      ? "Pinned message"
      : kind === "images"
        ? "Video"
        : kind === "photos"
          ? "Photo"
          : kind === "gifs"
            ? "GIF"
            : url || "Link";
  const text = plain || (kind === "links" ? url : fallbackLabel);
  const dateSec = Number(msg.date);
  return {
    telegram_message_id: Math.trunc(id),
    date:
      Number.isFinite(dateSec) && dateSec > 0
        ? new Date(dateSec * 1000).toISOString()
        : null,
    text,
    url: kind === "links" ? url : url || "",
    kind,
    sender_name: "",
  };
}

export async function searchChatMedia(
  client: Client,
  chatId: number,
  kind: ProfileMediaKind,
  options?: { fromMessageId?: number | null; limit?: number },
): Promise<{ items: ChatMediaSearchItem[]; has_more: boolean }> {
  if (!Number.isFinite(chatId) || chatId === 0 || !isProfileMediaKind(kind)) {
    return { items: [], has_more: false };
  }
  const limit = Math.min(50, Math.max(1, Math.trunc(options?.limit ?? 30)));
  const fromMessageId =
    options?.fromMessageId != null &&
    Number.isFinite(options.fromMessageId) &&
    options.fromMessageId! > 0
      ? Math.trunc(options.fromMessageId!)
      : 0;
  try {
    const result = (await client.invoke({
      _: "searchChatMessages",
      chat_id: Math.trunc(chatId),
      query: "",
      from_message_id: fromMessageId,
      offset: 0,
      limit,
      filter: { _: MEDIA_KIND_FILTER[kind] },
    })) as {
      messages?: unknown[];
      total_count?: number;
    };
    const rows = Array.isArray(result.messages) ? result.messages : [];
    const items: ChatMediaSearchItem[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const item = mediaItemFromMessage(
        raw as Parameters<typeof mediaItemFromMessage>[0],
        kind,
      );
      if (item) items.push(item);
    }
    return {
      items,
      has_more: items.length >= limit,
    };
  } catch {
    return { items: [], has_more: false };
  }
}

export async function searchChatLinks(
  client: Client,
  chatId: number,
  options?: { fromMessageId?: number | null; limit?: number },
): Promise<{ links: ChatLinkSearchItem[]; has_more: boolean }> {
  const result = await searchChatMedia(client, chatId, "links", options);
  return { links: result.items, has_more: result.has_more };
}
