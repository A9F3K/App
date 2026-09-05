/**
 * Rolling founder cost↔screen-time calibration.
 * Snapshots accumulate; confidence rises with evidence so estimates improve over time.
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

export type ProviderCostSample = {
  vercelFixedUsd: number;
  vercelOnDemandUsd: number;
  railwayUsd: number;
  gcpUsd: number;
  /** Sum of usage-like provider spend for the window. */
  onDemandUsd: number;
  fixedUsd: number;
};

export type FounderCalibrationEvidence = {
  screenActiveHours30d: number;
  screenActiveHours7d: number;
  distinctUsers30d: number;
  distinctUsers7d: number;
  activeDays30d: number;
  sessionCount30d: number;
  snapshotDays: number;
  /** Days where both screen hours and on-demand $ were > 0. */
  pairedSnapshotDays: number;
};

export type FounderCalibrationResult = {
  onDemandUsdPerActiveHour: number;
  priorUsdPerActiveHour: number;
  liveUsdPerActiveHour: number | null;
  regressionUsdPerActiveHour: number | null;
  confidence: number;
  source: string;
  evidence: FounderCalibrationEvidence;
  avgUser: {
    hoursPerDay7d: number;
    onDemandUsdMonthAtObserved: number;
    onDemandUsdMonthAt2h: number;
    onDemandUsdMonthAt3h: number;
  };
  notes: string[];
};

async function tableExists(name: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Idempotent — also created in database/start.ts migrations. */
export async function ensureFounderCalibrationSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS founder_cost_snapshots (
      day                   DATE PRIMARY KEY,
      screen_active_ms      BIGINT NOT NULL DEFAULT 0,
      screen_users          INT NOT NULL DEFAULT 0,
      screen_sessions       INT NOT NULL DEFAULT 0,
      vercel_fixed_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
      vercel_ondemand_usd   DOUBLE PRECISION NOT NULL DEFAULT 0,
      railway_usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
      gcp_usd               DOUBLE PRECISION NOT NULL DEFAULT 0,
      ondemand_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
      fixed_usd             DOUBLE PRECISION NOT NULL DEFAULT 0,
      source                TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Upsert today's snapshot from live provider pulls + today's screen-time rollup.
 * Re-running founder refresh improves the same day's row as data arrives.
 */
export async function upsertTodayFounderCostSnapshot(input: {
  screenActiveMsToday: number;
  screenUsersToday: number;
  screenSessionsToday: number;
  costs: ProviderCostSample;
  source: string;
}): Promise<void> {
  await ensureFounderCalibrationSchema();
  const day = new Date().toISOString().slice(0, 10);
  // Provider totals are typically trailing-30d; store as daily-average contribution
  // so multi-day regression stays on comparable units.
  const scale = 1 / 30;
  await sql`
    INSERT INTO founder_cost_snapshots (
      day, screen_active_ms, screen_users, screen_sessions,
      vercel_fixed_usd, vercel_ondemand_usd, railway_usd, gcp_usd,
      ondemand_usd, fixed_usd, source, updated_at
    ) VALUES (
      ${day}::date,
      ${Math.max(0, Math.round(input.screenActiveMsToday))},
      ${Math.max(0, Math.round(input.screenUsersToday))},
      ${Math.max(0, Math.round(input.screenSessionsToday))},
      ${input.costs.vercelFixedUsd * scale},
      ${input.costs.vercelOnDemandUsd * scale},
      ${input.costs.railwayUsd * scale},
      ${input.costs.gcpUsd * scale},
      ${input.costs.onDemandUsd * scale},
      ${input.costs.fixedUsd * scale},
      ${input.source.slice(0, 200)},
      NOW()
    )
    ON CONFLICT (day) DO UPDATE SET
      screen_active_ms = EXCLUDED.screen_active_ms,
      screen_users = EXCLUDED.screen_users,
      screen_sessions = EXCLUDED.screen_sessions,
      vercel_fixed_usd = EXCLUDED.vercel_fixed_usd,
      vercel_ondemand_usd = EXCLUDED.vercel_ondemand_usd,
      railway_usd = EXCLUDED.railway_usd,
      gcp_usd = EXCLUDED.gcp_usd,
      ondemand_usd = EXCLUDED.ondemand_usd,
      fixed_usd = EXCLUDED.fixed_usd,
      source = EXCLUDED.source,
      updated_at = NOW()
  `;
}

export async function getTodayScreenRollup(): Promise<{
  activeMs: number;
  users: number;
  sessions: number;
}> {
  if (!(await tableExists("user_screen_sessions"))) {
    return { activeMs: 0, users: 0, sessions: 0 };
  }
  const rows = await sql`
    SELECT
      COALESCE(SUM(active_ms), 0)::float AS ms,
      COUNT(DISTINCT telegram_username)::int AS users,
      COUNT(*)::int AS sessions
    FROM user_screen_sessions
    WHERE started_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    activeMs: asNum(row?.ms),
    users: asNum(row?.users),
    sessions: asNum(row?.sessions),
  };
}

export async function getScreenEvidence(): Promise<FounderCalibrationEvidence> {
  const empty: FounderCalibrationEvidence = {
    screenActiveHours30d: 0,
    screenActiveHours7d: 0,
    distinctUsers30d: 0,
    distinctUsers7d: 0,
    activeDays30d: 0,
    sessionCount30d: 0,
    snapshotDays: 0,
    pairedSnapshotDays: 0,
  };
  if (!(await tableExists("user_screen_sessions"))) return empty;

  const [d7, d30, days, snaps] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM(active_ms), 0)::float AS ms,
        COUNT(DISTINCT telegram_username)::int AS users
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '7 days'
    `,
    sql`
      SELECT
        COALESCE(SUM(active_ms), 0)::float AS ms,
        COUNT(DISTINCT telegram_username)::int AS users,
        COUNT(*)::int AS sessions
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '30 days'
    `,
    sql`
      SELECT COUNT(DISTINCT date_trunc('day', started_at AT TIME ZONE 'UTC'))::int AS days
      FROM user_screen_sessions
      WHERE started_at > NOW() - INTERVAL '30 days'
        AND active_ms > 0
    `,
    (async () => {
      if (!(await tableExists("founder_cost_snapshots"))) {
        return [{ n: 0, paired: 0 }];
      }
      return sql`
        SELECT
          COUNT(*)::int AS n,
          COUNT(*) FILTER (
            WHERE screen_active_ms > 0 AND ondemand_usd > 0
          )::int AS paired
        FROM founder_cost_snapshots
        WHERE day > (CURRENT_DATE - INTERVAL '45 days')
      `;
    })(),
  ]);

  const r7 = d7[0] as Record<string, unknown>;
  const r30 = d30[0] as Record<string, unknown>;
  const rDays = days[0] as Record<string, unknown>;
  const rSnap = snaps[0] as Record<string, unknown>;

  return {
    screenActiveHours30d: asNum(r30?.ms) / 3_600_000,
    screenActiveHours7d: asNum(r7?.ms) / 3_600_000,
    distinctUsers30d: asNum(r30?.users),
    distinctUsers7d: asNum(r7?.users),
    activeDays30d: asNum(rDays?.days),
    sessionCount30d: asNum(r30?.sessions),
    snapshotDays: asNum(rSnap?.n),
    pairedSnapshotDays: asNum(rSnap?.paired),
  };
}

/** Ordinary least squares slope: ondemand_usd ~ screen_hours (daily snapshots). */
export async function regressOnDemandPerScreenHour(): Promise<number | null> {
  if (!(await tableExists("founder_cost_snapshots"))) return null;
  const rows = await sql`
    SELECT
      (screen_active_ms::float / 3600000.0) AS hours,
      ondemand_usd AS usd
    FROM founder_cost_snapshots
    WHERE day > (CURRENT_DATE - INTERVAL '45 days')
      AND screen_active_ms > 0
      AND ondemand_usd > 0
  `;
  if (rows.length < 3) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  const n = rows.length;
  for (const raw of rows) {
    const row = raw as { hours?: unknown; usd?: unknown };
    const x = asNum(row.hours);
    const y = asNum(row.usd);
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  return slope;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Confidence 0→1 from how much real usage evidence we have.
 * More screen hours, users, active days, and paired cost snapshots → trust live rates more.
 */
export function computeCalibrationConfidence(e: FounderCalibrationEvidence): number {
  const hoursPart = clamp01(e.screenActiveHours30d / 80);
  const usersPart = clamp01(e.distinctUsers30d / 25);
  const daysPart = clamp01(e.activeDays30d / 21);
  const snapPart = clamp01(e.pairedSnapshotDays / 14);
  return clamp01(0.35 * hoursPart + 0.25 * usersPart + 0.2 * daysPart + 0.2 * snapPart);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Blend prior (probe/env) with live provider$/screen-hours and optional regression.
 * As confidence rises, the estimate tracks real DB + billing data.
 */
export function calibrateFromEvidence(input: {
  evidence: FounderCalibrationEvidence;
  /** Trailing ~30d on-demand $ across providers. */
  liveOnDemandUsdMonth: number;
  /** Trailing ~30d fixed $ (plan fees, builds). */
  liveFixedUsdMonth: number;
  probeUsdPerActiveHour: number | null;
  envFallbackUsdPerActiveHour: number;
  regressionUsdPerActiveHour: number | null;
  /** Share of on-demand attributed to interactive screen time. */
  attribution?: number;
}): FounderCalibrationResult {
  const attr = input.attribution ?? 0.55;
  const intensity = Number(process.env.FOUNDER_CONNECTED_INTENSITY_MULTIPLIER ?? "15");
  const intensitySafe = Number.isFinite(intensity) && intensity > 0 ? intensity : 15;

  const prior =
    input.probeUsdPerActiveHour && input.probeUsdPerActiveHour > 0
      ? input.probeUsdPerActiveHour * intensitySafe
      : input.envFallbackUsdPerActiveHour;

  const hours = Math.max(input.evidence.screenActiveHours30d, 0);
  let liveRate: number | null = null;
  if (hours >= 1 && input.liveOnDemandUsdMonth > 0) {
    liveRate = (input.liveOnDemandUsdMonth * attr) / hours;
    // Soft cap vs prior while evidence is still thin.
    const confPreview = computeCalibrationConfidence(input.evidence);
    const maxMult = 2 + confPreview * 10;
    liveRate = Math.min(liveRate, prior * maxMult);
  }

  const regression = input.regressionUsdPerActiveHour;
  const confidence = computeCalibrationConfidence(input.evidence);

  // Mix: prior ↔ live ↔ regression (when available).
  let rate = prior;
  let source = "prior_probe_or_env";
  const notes: string[] = [];

  if (liveRate != null && regression != null && Number.isFinite(regression)) {
    const liveW = confidence * 0.65;
    const regW = confidence * 0.25;
    const priorW = 1 - liveW - regW;
    rate = priorW * prior + liveW * liveRate + regW * regression;
    source = `confidence_${confidence.toFixed(2)}_prior+live+regression`;
    notes.push("OLS slope from founder_cost_snapshots included.");
  } else if (liveRate != null) {
    rate = (1 - confidence) * prior + confidence * liveRate;
    source = `confidence_${confidence.toFixed(2)}_prior+live_ondemand/screen_hours`;
  } else {
    notes.push("Live $/hour not used yet — need ≥1h of stored screen time in 30d.");
  }

  if (confidence < 0.25) {
    notes.push("Low confidence — estimates still lean on probe/prior until more screen-time accrues.");
  } else if (confidence < 0.6) {
    notes.push("Medium confidence — blending prior with real usage; keep the app open to improve.");
  } else {
    notes.push("High confidence — rates track observed screen-time and provider on-demand spend.");
  }

  const hoursPerDay7d =
    input.evidence.distinctUsers7d > 0
      ? input.evidence.screenActiveHours7d / input.evidence.distinctUsers7d / 7
      : 0;

  return {
    onDemandUsdPerActiveHour: round4(rate),
    priorUsdPerActiveHour: round4(prior),
    liveUsdPerActiveHour: liveRate != null ? round4(liveRate) : null,
    regressionUsdPerActiveHour: regression != null ? round4(regression) : null,
    confidence: round4(confidence),
    source,
    evidence: input.evidence,
    avgUser: {
      hoursPerDay7d: round4(hoursPerDay7d),
      onDemandUsdMonthAtObserved: round2(rate * hoursPerDay7d * 30),
      onDemandUsdMonthAt2h: round2(rate * 2 * 30),
      onDemandUsdMonthAt3h: round2(rate * 3 * 30),
    },
    notes,
  };
}

export type FounderCostSnapshotRow = {
  day: string;
  screenActiveMs: number;
  screenUsers: number;
  screenSessions: number;
  vercelFixedUsd: number;
  vercelOnDemandUsd: number;
  railwayUsd: number;
  gcpUsd: number;
  onDemandUsd: number;
  fixedUsd: number;
  source: string | null;
  updatedAt: string | null;
};

export async function listFounderCostSnapshots(days = 30): Promise<FounderCostSnapshotRow[]> {
  await ensureFounderCalibrationSchema();
  const windowDays = Math.max(1, Math.min(90, Math.round(days)));
  const rows = await sql`
    SELECT
      to_char(day, 'YYYY-MM-DD') AS day,
      screen_active_ms,
      screen_users,
      screen_sessions,
      vercel_fixed_usd,
      vercel_ondemand_usd,
      railway_usd,
      gcp_usd,
      ondemand_usd,
      fixed_usd,
      source,
      updated_at
    FROM founder_cost_snapshots
    WHERE day >= (CURRENT_DATE - ${windowDays}::int)
    ORDER BY day ASC
  `;
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    day: String(row.day ?? ""),
    screenActiveMs: asNum(row.screen_active_ms),
    screenUsers: asNum(row.screen_users),
    screenSessions: asNum(row.screen_sessions),
    vercelFixedUsd: asNum(row.vercel_fixed_usd),
    vercelOnDemandUsd: asNum(row.vercel_ondemand_usd),
    railwayUsd: asNum(row.railway_usd),
    gcpUsd: asNum(row.gcp_usd),
    onDemandUsd: asNum(row.ondemand_usd),
    fixedUsd: asNum(row.fixed_usd),
    source: typeof row.source === "string" ? row.source : null,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === "string"
          ? row.updated_at
          : null,
  }));
}

export type DailyUsageRow = {
  day: string;
  activeMs: number;
  activeHours: number;
  distinctUsers: number;
  sessions: number;
  avgActiveMsPerUser: number;
  avgActiveHoursPerUser: number;
  /** Real provider spend for the day (Vercel FOCUS + Railway + GCP). */
  vercelUsd: number | null;
  railwayUsd: number | null;
  gcpUsd: number | null;
  providerTotalUsd: number | null;
  vercelSource: "live" | "unavailable" | null;
  railwaySource: "live" | "env" | "unavailable" | null;
  gcpSource: "live" | "env" | "unavailable" | null;
  /** Legacy estimate kept for calibration comparison only. */
  estimatedOnDemandUsd: number;
  estimatedFixedUsd: number;
  estimatedTotalUsd: number;
  snapshotOnDemandUsd: number | null;
  snapshotFixedUsd: number | null;
  snapshotUpdatedAt: string | null;
};

/** Merge live screen rollups with real provider day-spend + calibrated estimate. */
export function buildDailyUsageSeries(input: {
  days: Array<{
    day: string;
    activeMs: number;
    distinctUsers: number;
    sessions: number;
    avgActiveMsPerUser: number;
  }>;
  onDemandUsdPerActiveHour: number;
  fixedUsdPerDay: number;
  snapshots: FounderCostSnapshotRow[];
  vercelByDay?: Array<{ day: string; totalUsd: number; source?: "live" | "unavailable" }>;
  railwayByDay?: Array<{ day: string; usd: number; source: "live" | "env" | "unavailable" }>;
  gcpByDay?: Array<{ day: string; usd: number; source: "live" | "env" | "unavailable" }>;
}): DailyUsageRow[] {
  const snaps = new Map(input.snapshots.map((s) => [s.day, s]));
  const vercel = new Map((input.vercelByDay ?? []).map((r) => [r.day, r]));
  const railway = new Map((input.railwayByDay ?? []).map((r) => [r.day, r]));
  const gcp = new Map((input.gcpByDay ?? []).map((r) => [r.day, r]));

  return input.days.map((d) => {
    const hours = d.activeMs / 3_600_000;
    const estimatedOnDemandUsd = round4(hours * input.onDemandUsdPerActiveHour);
    const estimatedFixedUsd = round4(input.fixedUsdPerDay);
    const snap = snaps.get(d.day);
    const v = vercel.get(d.day);
    const r = railway.get(d.day);
    const g = gcp.get(d.day);
    const vercelUsd = v != null ? round4(v.totalUsd) : null;
    const railwayUsd = r != null ? round4(r.usd) : null;
    const gcpUsd = g != null ? round4(g.usd) : null;
    const parts = [vercelUsd, railwayUsd, gcpUsd].filter(
      (x): x is number => x != null && Number.isFinite(x),
    );
    const providerTotalUsd = parts.length > 0 ? round4(parts.reduce((a, b) => a + b, 0)) : null;

    return {
      day: d.day,
      activeMs: d.activeMs,
      activeHours: round4(hours),
      distinctUsers: d.distinctUsers,
      sessions: d.sessions,
      avgActiveMsPerUser: d.avgActiveMsPerUser,
      avgActiveHoursPerUser: round4(d.avgActiveMsPerUser / 3_600_000),
      vercelUsd,
      railwayUsd,
      gcpUsd,
      providerTotalUsd,
      vercelSource: v ? (v.source ?? "live") : null,
      railwaySource: r?.source ?? null,
      gcpSource: g?.source ?? null,
      estimatedOnDemandUsd,
      estimatedFixedUsd,
      estimatedTotalUsd: round4(estimatedOnDemandUsd + estimatedFixedUsd),
      snapshotOnDemandUsd: snap ? round4(snap.onDemandUsd) : null,
      snapshotFixedUsd: snap ? round4(snap.fixedUsd) : null,
      snapshotUpdatedAt: snap?.updatedAt ?? null,
    };
  });
}
