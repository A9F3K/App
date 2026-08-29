import { sql } from "./start.js";
import { getMtprotoSession, isMtprotoSessionActive } from "./telegramMtproto.js";

type ConnectionRow = {
  telegram_username: string;
  status: string;
  connected_at: string;
};

export async function isTelegramMessagesLinkRevoked(telegramUsername: string): Promise<boolean> {
  const session = await getMtprotoSession(telegramUsername);
  if (session?.status === "revoked") return true;
  const conn = await getConnection(telegramUsername);
  return conn?.status === "revoked";
}

export async function isTelegramMessagesConnected(telegramUsername: string): Promise<boolean> {
  if (await isTelegramMessagesLinkRevoked(telegramUsername)) {
    return false;
  }
  if (await isMtprotoSessionActive(telegramUsername)) {
    return true;
  }
  const rows = (await sql`
    SELECT status FROM telegram_messages_connections
    WHERE telegram_username = ${telegramUsername}
    LIMIT 1;
  `) as { status: string }[];
  return rows[0]?.status === "active";
}

export async function getConnection(telegramUsername: string): Promise<ConnectionRow | null> {
  const rows = (await sql`
    SELECT telegram_username, status, connected_at
    FROM telegram_messages_connections
    WHERE telegram_username = ${telegramUsername}
    LIMIT 1;
  `) as ConnectionRow[];
  return rows[0] ?? null;
}

/** Mark product-level “messages connected” after TDLib auth + initial sync. */
export async function markTelegramMessagesConnected(telegramUsername: string): Promise<void> {
  await sql`
    INSERT INTO telegram_messages_connections (telegram_username, status, connected_at, revoked_at)
    VALUES (${telegramUsername}, 'active', NOW(), NULL)
    ON CONFLICT (telegram_username) DO UPDATE
      SET status = 'active',
          connected_at = NOW(),
          revoked_at = NULL;
  `;
}

export async function disconnectTelegramMessages(telegramUsername: string): Promise<void> {
  await sql`
    UPDATE telegram_messages_connections
    SET status = 'revoked', revoked_at = NOW()
    WHERE telegram_username = ${telegramUsername};
  `;
}
