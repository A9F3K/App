/**
 * AI agent column chats — tabs, messages, likes, soft-delete, share tokens.
 */
import { sql } from "./start.js";

export type AiAgentChatRow = {
  id: string;
  owner_username: string;
  title: string;
  share_token: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AiAgentMessageRow = {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  created_at: string;
  like_count: number;
  liked_by_me: boolean;
};

function newId(): string {
  return crypto.randomUUID();
}

export async function ensureAiAgentChatTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS ai_agent_chats (
      id UUID PRIMARY KEY,
      owner_username TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Agent',
      share_token TEXT UNIQUE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_agent_chats_owner
      ON ai_agent_chats(owner_username, deleted_at, updated_at DESC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_agent_messages (
      id UUID PRIMARY KEY,
      chat_id UUID NOT NULL REFERENCES ai_agent_chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_chat
      ON ai_agent_messages(chat_id, created_at ASC);
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ai_agent_message_likes (
      message_id UUID NOT NULL REFERENCES ai_agent_messages(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, username)
    );
  `;
}

export async function listAiAgentChatsForUser(
  ownerUsername: string,
): Promise<AiAgentChatRow[]> {
  const rows = await sql`
    SELECT id::text, owner_username, title, share_token, deleted_at::text, created_at::text, updated_at::text
    FROM ai_agent_chats
    WHERE owner_username = ${ownerUsername} AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 50;
  `;
  return rows as AiAgentChatRow[];
}

export async function createAiAgentChat(opts: {
  ownerUsername: string;
  title?: string;
  id?: string;
}): Promise<AiAgentChatRow> {
  const id = opts.id ?? newId();
  const title = (opts.title ?? "New Agent").trim() || "New Agent";
  const rows = await sql`
    INSERT INTO ai_agent_chats (id, owner_username, title)
    VALUES (${id}::uuid, ${opts.ownerUsername}, ${title})
    RETURNING id::text, owner_username, title, share_token, deleted_at::text, created_at::text, updated_at::text;
  `;
  return rows[0] as AiAgentChatRow;
}

export async function getAiAgentChatById(
  chatId: string,
): Promise<AiAgentChatRow | null> {
  const rows = await sql`
    SELECT id::text, owner_username, title, share_token, deleted_at::text, created_at::text, updated_at::text
    FROM ai_agent_chats
    WHERE id = ${chatId}::uuid
    LIMIT 1;
  `;
  return (rows[0] as AiAgentChatRow | undefined) ?? null;
}

export async function getAiAgentChatByShareToken(
  token: string,
): Promise<AiAgentChatRow | null> {
  const rows = await sql`
    SELECT id::text, owner_username, title, share_token, deleted_at::text, created_at::text, updated_at::text
    FROM ai_agent_chats
    WHERE share_token = ${token}
    LIMIT 1;
  `;
  return (rows[0] as AiAgentChatRow | undefined) ?? null;
}

export async function renameAiAgentChat(opts: {
  chatId: string;
  ownerUsername: string;
  title: string;
}): Promise<AiAgentChatRow | null> {
  const title = opts.title.trim().slice(0, 80) || "New Agent";
  const rows = await sql`
    UPDATE ai_agent_chats
    SET title = ${title}, updated_at = NOW()
    WHERE id = ${opts.chatId}::uuid
      AND owner_username = ${opts.ownerUsername}
      AND deleted_at IS NULL
    RETURNING id::text, owner_username, title, share_token, deleted_at::text, created_at::text, updated_at::text;
  `;
  return (rows[0] as AiAgentChatRow | undefined) ?? null;
}

/** Soft-delete for the owner; row kept for analytics. */
export async function softDeleteAiAgentChat(opts: {
  chatId: string;
  ownerUsername: string;
}): Promise<boolean> {
  const rows = await sql`
    UPDATE ai_agent_chats
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ${opts.chatId}::uuid
      AND owner_username = ${opts.ownerUsername}
      AND deleted_at IS NULL
    RETURNING id;
  `;
  return rows.length > 0;
}

export async function ensureShareToken(opts: {
  chatId: string;
  ownerUsername: string;
}): Promise<string | null> {
  const existing = await getAiAgentChatById(opts.chatId);
  if (!existing || existing.owner_username !== opts.ownerUsername || existing.deleted_at) {
    return null;
  }
  if (existing.share_token) return existing.share_token;
  const token = newId().replace(/-/g, "");
  const rows = await sql`
    UPDATE ai_agent_chats
    SET share_token = ${token}, updated_at = NOW()
    WHERE id = ${opts.chatId}::uuid
      AND owner_username = ${opts.ownerUsername}
      AND deleted_at IS NULL
    RETURNING share_token;
  `;
  return (rows[0] as { share_token: string } | undefined)?.share_token ?? null;
}

export async function listAiAgentMessages(opts: {
  chatId: string;
  viewerUsername?: string | null;
}): Promise<AiAgentMessageRow[]> {
  const viewer = opts.viewerUsername ?? "";
  const rows = await sql`
    SELECT
      m.id::text,
      m.chat_id::text,
      m.role,
      m.content,
      m.model,
      m.created_at::text,
      COALESCE((
        SELECT COUNT(*)::int FROM ai_agent_message_likes l WHERE l.message_id = m.id
      ), 0) AS like_count,
      EXISTS (
        SELECT 1 FROM ai_agent_message_likes l
        WHERE l.message_id = m.id AND l.username = ${viewer}
      ) AS liked_by_me
    FROM ai_agent_messages m
    WHERE m.chat_id = ${opts.chatId}::uuid
    ORDER BY m.created_at ASC
    LIMIT 200;
  `;
  return rows as AiAgentMessageRow[];
}

export async function insertAiAgentMessage(opts: {
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
}): Promise<AiAgentMessageRow> {
  const id = newId();
  const rows = await sql`
    INSERT INTO ai_agent_messages (id, chat_id, role, content, model)
    VALUES (${id}::uuid, ${opts.chatId}::uuid, ${opts.role}, ${opts.content}, ${opts.model ?? null})
    RETURNING id::text, chat_id::text, role, content, model, created_at::text;
  `;
  await sql`
    UPDATE ai_agent_chats SET updated_at = NOW() WHERE id = ${opts.chatId}::uuid;
  `;
  const row = rows[0] as Omit<AiAgentMessageRow, "like_count" | "liked_by_me">;
  return { ...row, like_count: 0, liked_by_me: false };
}

export async function toggleAiAgentMessageLike(opts: {
  messageId: string;
  username: string;
}): Promise<{ liked: boolean; likeCount: number }> {
  const existing = await sql`
    SELECT 1 FROM ai_agent_message_likes
    WHERE message_id = ${opts.messageId}::uuid AND username = ${opts.username}
    LIMIT 1;
  `;
  if (existing.length > 0) {
    await sql`
      DELETE FROM ai_agent_message_likes
      WHERE message_id = ${opts.messageId}::uuid AND username = ${opts.username};
    `;
  } else {
    await sql`
      INSERT INTO ai_agent_message_likes (message_id, username)
      VALUES (${opts.messageId}::uuid, ${opts.username})
      ON CONFLICT DO NOTHING;
    `;
  }
  const countRows = await sql`
    SELECT COUNT(*)::int AS n FROM ai_agent_message_likes
    WHERE message_id = ${opts.messageId}::uuid;
  `;
  const likeCount = Number((countRows[0] as { n: number })?.n ?? 0);
  return { liked: existing.length === 0, likeCount };
}

/** Copy a shared chat into another user's account (new chat id). */
export async function claimSharedAiAgentChat(opts: {
  shareToken: string;
  claimantUsername: string;
}): Promise<AiAgentChatRow | null> {
  const source = await getAiAgentChatByShareToken(opts.shareToken);
  if (!source || source.deleted_at) return null;
  if (source.owner_username === opts.claimantUsername) return source;

  const copy = await createAiAgentChat({
    ownerUsername: opts.claimantUsername,
    title: source.title,
  });
  const messages = await listAiAgentMessages({ chatId: source.id });
  for (const m of messages) {
    if (m.role === "system") continue;
    await insertAiAgentMessage({
      chatId: copy.id,
      role: m.role,
      content: m.content,
      model: m.model,
    });
  }
  return copy;
}
