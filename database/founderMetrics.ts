/**
 * Aggregate screen-time + user metrics for the founder financial model.
 */
import { sql } from "./start.js";

function asNum(raw: unknown): number {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
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

export type FounderScreenTimeSnapshot = {
  tablesExist: boolean;
  usersWithScreenTime: number;
  totalActiveMs: number;
  totalActiveHours: number;
  avgActiveMsPerUser: number;
  avgActiveHoursPerUser: number;
  totalSessions: number;
  last7d: {
    activeMs: number;
    activeHours: number;
    sessions: number;
    distinctUsers: number;
  };
  last30d: {
    activeMs: number;
    activeHours: number;
    sessions: number;
    distinctUsers: number;
  };
  /** Average active hours / user / day among users with activity in last 7d. */
  avgHoursPerActiveUserPerDay7d: number;
  topUsers: Array<{
    telegramUsername: string;
    totalActiveMs: number;
    sessionCount: number;
    lastActiveAt: string | null;
  }>;
  recentSessions: Array<{
    telegramUsername: string;
    clientSessionId: string;
    startedAt: string;
    lastHeartbeatAt: string;
    endedAt: string | null;
    activeMs: number;
    platform: string | null;
  }>;
  dailyLast14d: Array<{
    day: string;
    activeMs: number;
    distinctUsers: number;
    sessions: number;
    /** Mean active time among users who had ≥1 session that day. */
    avgActiveMsPerUser: number;
  }>;
  /** Same shape as dailyLast14d, extended window for the daily consumption table. */
  dailyLast30d: Array<{
    day: string;
    activeMs: number;
    distinctUsers: number;
    sessions: number;
    avgActiveMsPerUser: number;
  }>;
};

async function tableExists(name: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function getFounderScreenTimeSnapshot(): Promise<FounderScreenTimeSnapshot> {
  const empty: FounderScreenTimeSnapshot = {
    tablesExist: false,
    usersWithScreenTime: 0,
    totalActiveMs: 0,
    totalActiveHours: 0,
    avgActiveMsPerUser: 0,
    avgActiveHoursPerUser: 0,
    totalSessions: 0,
    last7d: { activeMs: 0, activeHours: 0, sessions: 0, distinctUsers: 0 },
    last30d: { activeMs: 0, activeHours: 0, sessions: 0, distinctUsers: 0 },
    avgHoursPerActiveUserPerDay7d: 0,
    topUsers: [],
    recentSessions: [],
    dailyLast14d: [],
    dailyLast30d: [],
  };

  const [hasTotals, hasSessions] = await Promise.all([
    tableExists("user_screen_time_totals"),
    tableExists("user_screen_sessions"),
  ]);
  if (!hasTotals || !hasSessions) return empty;

  const [totalsRows, d7, d30, top, recent, daily] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS users,
        COALESCE(SUM(total_active_ms), 0)::float AS total_ms,
        COALESCE(AVG(total_active_ms), 0)::float AS avg_ms,
        COALESCE(SUM(session_count), 0)::float AS sessions
      FROM user_screen_time_totals
    `,
    sql`
      SELECT
        COALESCE(SUM(active_ms), 0)::float AS ms,
        COUNT(*)::int AS sessions,
        COUNT(DISTINCT telegram_username)::int AS users
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '7 days'
    `,
    sql`
      SELECT
        COALESCE(SUM(active_ms), 0)::float AS ms,
        COUNT(*)::int AS sessions,
        COUNT(DISTINCT telegram_username)::int AS users
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '30 days'
    `,
    sql`
      SELECT telegram_username, total_active_ms, session_count, last_active_at
      FROM user_screen_time_totals
      ORDER BY total_active_ms DESC
      LIMIT 10
    `,
    sql`
      SELECT
        telegram_username,
        client_session_id,
        started_at,
        last_heartbeat_at,
        ended_at,
        active_ms,
        platform
      FROM user_screen_sessions
      ORDER BY started_at DESC
      LIMIT 20
    `,
    sql`
      SELECT
        to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        COALESCE(SUM(active_ms), 0)::float AS ms,
        COUNT(DISTINCT telegram_username) FILTER (WHERE active_ms > 0)::int AS users,
        COUNT(*) FILTER (WHERE active_ms > 0)::int AS sessions
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `,
  ]);

  const t = totalsRows[0] as Record<string, unknown> | undefined;
  const r7 = d7[0] as Record<string, unknown> | undefined;
  const r30 = d30[0] as Record<string, unknown> | undefined;
  const totalMs = asNum(t?.total_ms);
  const users = asNum(t?.users);
  const ms7 = asNum(r7?.ms);
  const users7 = asNum(r7?.users);
  const avgHoursPerActiveUserPerDay7d =
    users7 > 0 ? ms7 / users7 / 7 / 3_600_000 : 0;

  return {
    tablesExist: true,
    usersWithScreenTime: users,
    totalActiveMs: totalMs,
    totalActiveHours: totalMs / 3_600_000,
    avgActiveMsPerUser: asNum(t?.avg_ms),
    avgActiveHoursPerUser: asNum(t?.avg_ms) / 3_600_000,
    totalSessions: asNum(t?.sessions),
    last7d: {
      activeMs: ms7,
      activeHours: ms7 / 3_600_000,
      sessions: asNum(r7?.sessions),
      distinctUsers: users7,
    },
    last30d: {
      activeMs: asNum(r30?.ms),
      activeHours: asNum(r30?.ms) / 3_600_000,
      sessions: asNum(r30?.sessions),
      distinctUsers: asNum(r30?.users),
    },
    avgHoursPerActiveUserPerDay7d,
    topUsers: (top as Array<Record<string, unknown>>).map((row) => ({
      telegramUsername: String(row.telegram_username ?? ""),
      totalActiveMs: asNum(row.total_active_ms),
      sessionCount: asNum(row.session_count),
      lastActiveAt: asIso(row.last_active_at),
    })),
    recentSessions: (recent as Array<Record<string, unknown>>).map((row) => ({
      telegramUsername: String(row.telegram_username ?? ""),
      clientSessionId: String(row.client_session_id ?? ""),
      startedAt: asIso(row.started_at) ?? "",
      lastHeartbeatAt: asIso(row.last_heartbeat_at) ?? "",
      endedAt: asIso(row.ended_at),
      activeMs: asNum(row.active_ms),
      platform: typeof row.platform === "string" ? row.platform : null,
    })),
    dailyLast14d: mapDailyRows(daily as Array<Record<string, unknown>>).slice(-14),
    dailyLast30d: fillDailyCalendar(
      mapDailyRows(daily as Array<Record<string, unknown>>),
      30,
    ),
  };
}

function mapDailyRows(rows: Array<Record<string, unknown>>): Array<{
  day: string;
  activeMs: number;
  distinctUsers: number;
  sessions: number;
  avgActiveMsPerUser: number;
}> {
  return rows.map((row) => {
    const activeMs = asNum(row.ms);
    const distinctUsers = asNum(row.users);
    return {
      day: String(row.day ?? ""),
      activeMs,
      distinctUsers,
      sessions: asNum(row.sessions),
      avgActiveMsPerUser: distinctUsers > 0 ? activeMs / distinctUsers : 0,
    };
  });
}

/** Ensure a contiguous UTC day series so the founder table has a row per day. */
function fillDailyCalendar(
  rows: Array<{
    day: string;
    activeMs: number;
    distinctUsers: number;
    sessions: number;
    avgActiveMsPerUser: number;
  }>,
  days: number,
): Array<{
  day: string;
  activeMs: number;
  distinctUsers: number;
  sessions: number;
  avgActiveMsPerUser: number;
}> {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: typeof rows = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.push(
      byDay.get(key) ?? {
        day: key,
        activeMs: 0,
        distinctUsers: 0,
        sessions: 0,
        avgActiveMsPerUser: 0,
      },
    );
  }
  return out;
}

export async function getFounderUserCounts(): Promise<{
  totalUsers: number;
  telegramConnected: number;
}> {
  try {
    const users = await sql`SELECT COUNT(*)::int AS n FROM users`;
    let telegramConnected = 0;
    if (await tableExists("telegram_messages_connections")) {
      const conn = await sql`
        SELECT COUNT(*)::int AS n
        FROM telegram_messages_connections
        WHERE status = 'active'
      `;
      telegramConnected = asNum((conn[0] as { n?: unknown })?.n);
    } else if (await tableExists("telegram_mtproto_sessions")) {
      const conn = await sql`
        SELECT COUNT(*)::int AS n
        FROM telegram_mtproto_sessions
        WHERE status = 'active'
      `;
      telegramConnected = asNum((conn[0] as { n?: unknown })?.n);
    }
    return {
      totalUsers: asNum((users[0] as { n?: unknown })?.n),
      telegramConnected,
    };
  } catch {
    return { totalUsers: 0, telegramConnected: 0 };
  }
}
