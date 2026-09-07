/**
 * Support inbox — user ↔ staff threads (not AI).
 */
import { sql } from "./start.js";

export type SupportThreadRow = {
  id: string;
  username: string;
  created_at: string;
  updated_at: string;
  last_preview: string | null;
  unread_for_staff: boolean;
  unread_for_user: boolean;
  unread_for_user_count: number;
};

export type SupportMessageRow = {
  id: string;
  thread_id: string;
  role: "user" | "staff";
  content: string;
  created_at: string;
};

function newId(): string {
  return crypto.randomUUID();
}

function mapThreadRow(
  row: Record<string, unknown>,
  lastPreview: string | null = null,
): SupportThreadRow {
  return {
    id: String(row.id ?? ""),
    username: String(row.username ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    last_preview: lastPreview,
    unread_for_staff: Boolean(row.unread_for_staff),
    unread_for_user: Boolean(row.unread_for_user),
    unread_for_user_count: Math.max(
      0,
      typeof row.unread_for_user_count === "number"
        ? Math.round(row.unread_for_user_count)
        : Number(row.unread_for_user_count) || 0,
    ),
  };
}

export async function ensureSupportTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS support_threads (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      unread_for_staff BOOLEAN NOT NULL DEFAULT FALSE,
      unread_for_user BOOLEAN NOT NULL DEFAULT FALSE,
      unread_for_user_count INTEGER NOT NULL DEFAULT 0
    );
  `;
  await sql`
    ALTER TABLE support_threads
      ADD COLUMN IF NOT EXISTS unread_for_user BOOLEAN NOT NULL DEFAULT FALSE;
  `;
  await sql`
    ALTER TABLE support_threads
      ADD COLUMN IF NOT EXISTS unread_for_user_count INTEGER NOT NULL DEFAULT 0;
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS support_messages (
      id UUID PRIMARY KEY,
      thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'staff')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_support_messages_thread
      ON support_messages(thread_id, created_at ASC);
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_support_threads_updated
      ON support_threads(updated_at DESC);
  `;
}

export async function ensureSupportThreadForUser(
  username: string,
): Promise<SupportThreadRow> {
  const existing = await sql`
    SELECT
      id::text,
      username,
      created_at::text,
      updated_at::text,
      unread_for_staff,
      unread_for_user,
      unread_for_user_count
    FROM support_threads
    WHERE username = ${username}
    LIMIT 1;
  `;
  if (existing[0]) {
    return mapThreadRow(existing[0] as Record<string, unknown>);
  }
  const id = newId();
  const rows = await sql`
    INSERT INTO support_threads (id, username)
    VALUES (${id}::uuid, ${username})
    RETURNING
      id::text,
      username,
      created_at::text,
      updated_at::text,
      unread_for_staff,
      unread_for_user,
      unread_for_user_count;
  `;
  return mapThreadRow(rows[0] as Record<string, unknown>);
}

export async function listSupportMessages(
  threadId: string,
): Promise<SupportMessageRow[]> {
  const rows = await sql`
    SELECT id::text, thread_id::text, role, content, created_at::text
    FROM support_messages
    WHERE thread_id = ${threadId}::uuid
    ORDER BY created_at ASC
    LIMIT 500;
  `;
  return rows as SupportMessageRow[];
}

export async function insertSupportMessage(opts: {
  threadId: string;
  role: "user" | "staff";
  content: string;
}): Promise<SupportMessageRow> {
  const id = newId();
  const rows = await sql`
    INSERT INTO support_messages (id, thread_id, role, content)
    VALUES (${id}::uuid, ${opts.threadId}::uuid, ${opts.role}, ${opts.content})
    RETURNING id::text, thread_id::text, role, content, created_at::text;
  `;
  if (opts.role === "user") {
    await sql`
      UPDATE support_threads
      SET updated_at = NOW(), unread_for_staff = TRUE
      WHERE id = ${opts.threadId}::uuid;
    `;
  } else {
    await sql`
      UPDATE support_threads
      SET
        updated_at = NOW(),
        unread_for_staff = FALSE,
        unread_for_user = TRUE,
        unread_for_user_count = COALESCE(unread_for_user_count, 0) + 1
      WHERE id = ${opts.threadId}::uuid;
    `;
  }
  return rows[0] as SupportMessageRow;
}

export async function listSupportThreadsForStaff(): Promise<SupportThreadRow[]> {
  const rows = await sql`
    SELECT
      t.id::text,
      t.username,
      t.created_at::text,
      t.updated_at::text,
      t.unread_for_staff,
      t.unread_for_user,
      t.unread_for_user_count,
      (
        SELECT m.content FROM support_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS last_preview
    FROM support_threads t
    ORDER BY t.unread_for_staff DESC, t.updated_at DESC
    LIMIT 100;
  `;
  return (rows as Array<Record<string, unknown>>).map((row) =>
    mapThreadRow(row, typeof row.last_preview === "string" ? row.last_preview : null),
  );
}

export async function getSupportThreadById(
  threadId: string,
): Promise<SupportThreadRow | null> {
  const rows = await sql`
    SELECT
      id::text,
      username,
      created_at::text,
      updated_at::text,
      unread_for_staff,
      unread_for_user,
      unread_for_user_count
    FROM support_threads
    WHERE id = ${threadId}::uuid
    LIMIT 1;
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? mapThreadRow(row) : null;
}

export async function markSupportThreadReadByStaff(threadId: string): Promise<void> {
  await sql`
    UPDATE support_threads
    SET unread_for_staff = FALSE
    WHERE id = ${threadId}::uuid;
  `;
}

export async function markSupportThreadReadByUser(threadId: string): Promise<void> {
  await sql`
    UPDATE support_threads
    SET unread_for_user = FALSE, unread_for_user_count = 0
    WHERE id = ${threadId}::uuid;
  `;
}
