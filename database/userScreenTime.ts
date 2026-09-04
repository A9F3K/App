/**
 * Per-user visible screen-time sessions + aggregate totals.
 * Clients report capped deltas; the server is the source of truth for accrual.
 */
import { sql } from "./start.js";
import { normalizeUsername } from "./users.js";

const MAX_DELTA_MS = 120_000;
const MIN_DELTA_MS = 0;

export type ScreenTimeSessionRow = {
  client_session_id: string;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  active_ms: number;
  platform: string | null;
};

export type ScreenTimeTotalsRow = {
  total_active_ms: number;
  session_count: number;
  last_active_at: string | null;
};

function clampDeltaMs(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(MIN_DELTA_MS, Math.min(MAX_DELTA_MS, Math.round(raw)));
}

function asIso(raw: unknown): string | null {
  if (raw == null) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isNaN(t) ? null : raw.toISOString();
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function asMs(raw: unknown): number {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.round(raw));
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }
  return 0;
}

export async function applyScreenTimeHeartbeat(input: {
  telegramUsername: string;
  clientSessionId: string;
  deltaMs: number;
  end?: boolean;
  platform?: string | null;
  userAgent?: string | null;
}): Promise<{
  session_active_ms: number;
  total_active_ms: number;
  session_count: number;
  ended: boolean;
}> {
  const username = normalizeUsername(input.telegramUsername);
  const clientSessionId = input.clientSessionId.trim().slice(0, 80);
  if (!username || !clientSessionId) {
    throw new Error("invalid_screen_time_identity");
  }

  const deltaMs = clampDeltaMs(input.deltaMs);
  const end = Boolean(input.end);
  const platform = (input.platform ?? "").trim().slice(0, 32) || null;
  const userAgent = (input.userAgent ?? "").trim().slice(0, 400) || null;

  const existing = await sql`
    SELECT id
    FROM user_screen_sessions
    WHERE telegram_username = ${username}
      AND client_session_id = ${clientSessionId}
    LIMIT 1
  `;
  const isNew = existing.length === 0;

  let sessionActiveMs = 0;
  let endedAt: string | null = null;

  if (isNew) {
    const rows = end
      ? await sql`
          INSERT INTO user_screen_sessions (
            telegram_username,
            client_session_id,
            started_at,
            last_heartbeat_at,
            ended_at,
            active_ms,
            platform,
            user_agent
          )
          VALUES (
            ${username},
            ${clientSessionId},
            NOW(),
            NOW(),
            NOW(),
            ${deltaMs},
            ${platform},
            ${userAgent}
          )
          RETURNING active_ms, ended_at
        `
      : await sql`
          INSERT INTO user_screen_sessions (
            telegram_username,
            client_session_id,
            started_at,
            last_heartbeat_at,
            ended_at,
            active_ms,
            platform,
            user_agent
          )
          VALUES (
            ${username},
            ${clientSessionId},
            NOW(),
            NOW(),
            NULL,
            ${deltaMs},
            ${platform},
            ${userAgent}
          )
          RETURNING active_ms, ended_at
        `;
    const row = rows[0] as { active_ms?: unknown; ended_at?: unknown } | undefined;
    sessionActiveMs = asMs(row?.active_ms);
    endedAt = asIso(row?.ended_at);
  } else if (end) {
    const rows = await sql`
      UPDATE user_screen_sessions
      SET
        last_heartbeat_at = NOW(),
        active_ms = active_ms + ${deltaMs},
        ended_at = COALESCE(ended_at, NOW()),
        platform = COALESCE(${platform}, platform),
        user_agent = COALESCE(${userAgent}, user_agent),
        updated_at = NOW()
      WHERE telegram_username = ${username}
        AND client_session_id = ${clientSessionId}
      RETURNING active_ms, ended_at
    `;
    const row = rows[0] as { active_ms?: unknown; ended_at?: unknown } | undefined;
    sessionActiveMs = asMs(row?.active_ms);
    endedAt = asIso(row?.ended_at);
  } else {
    const rows = await sql`
      UPDATE user_screen_sessions
      SET
        last_heartbeat_at = NOW(),
        active_ms = active_ms + ${deltaMs},
        platform = COALESCE(${platform}, platform),
        user_agent = COALESCE(${userAgent}, user_agent),
        updated_at = NOW()
      WHERE telegram_username = ${username}
        AND client_session_id = ${clientSessionId}
      RETURNING active_ms, ended_at
    `;
    const row = rows[0] as { active_ms?: unknown; ended_at?: unknown } | undefined;
    sessionActiveMs = asMs(row?.active_ms);
    endedAt = asIso(row?.ended_at);
  }

  const sessionCountBump = isNew ? 1 : 0;
  const totalRows = await sql`
    INSERT INTO user_screen_time_totals (
      telegram_username,
      total_active_ms,
      session_count,
      last_active_at,
      updated_at
    )
    VALUES (
      ${username},
      ${deltaMs},
      ${sessionCountBump},
      NOW(),
      NOW()
    )
    ON CONFLICT (telegram_username) DO UPDATE
    SET
      total_active_ms = user_screen_time_totals.total_active_ms + ${deltaMs},
      session_count = user_screen_time_totals.session_count + ${sessionCountBump},
      last_active_at = NOW(),
      updated_at = NOW()
    RETURNING total_active_ms, session_count
  `;

  const totals = totalRows[0] as { total_active_ms?: unknown; session_count?: unknown } | undefined;

  return {
    session_active_ms: sessionActiveMs,
    total_active_ms: asMs(totals?.total_active_ms),
    session_count: asMs(totals?.session_count),
    ended: end || Boolean(endedAt),
  };
}

export async function getScreenTimeTotals(
  telegramUsername: string,
): Promise<ScreenTimeTotalsRow | null> {
  const username = normalizeUsername(telegramUsername);
  if (!username) return null;
  const rows = await sql`
    SELECT total_active_ms, session_count, last_active_at
    FROM user_screen_time_totals
    WHERE telegram_username = ${username}
    LIMIT 1
  `;
  const row = rows[0] as
    | { total_active_ms?: unknown; session_count?: unknown; last_active_at?: unknown }
    | undefined;
  if (!row) return null;
  return {
    total_active_ms: asMs(row.total_active_ms),
    session_count: asMs(row.session_count),
    last_active_at: asIso(row.last_active_at),
  };
}

export async function listRecentScreenSessions(
  telegramUsername: string,
  limit = 20,
): Promise<ScreenTimeSessionRow[]> {
  const username = normalizeUsername(telegramUsername);
  if (!username) return [];
  const lim = Math.max(1, Math.min(100, Math.round(limit)));
  const rows = await sql`
    SELECT
      client_session_id,
      started_at,
      last_heartbeat_at,
      ended_at,
      active_ms,
      platform
    FROM user_screen_sessions
    WHERE telegram_username = ${username}
    ORDER BY started_at DESC
    LIMIT ${lim}
  `;
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    client_session_id: String(row.client_session_id ?? ""),
    started_at: asIso(row.started_at) ?? "",
    last_heartbeat_at: asIso(row.last_heartbeat_at) ?? "",
    ended_at: asIso(row.ended_at),
    active_ms: asMs(row.active_ms),
    platform: typeof row.platform === "string" ? row.platform : null,
  }));
}
