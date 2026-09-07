/**
 * Pro Access sales ledger for founder analytics.
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

function dayKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type ProSalePlanId = "month" | "quarter" | "year";

export type ProSaleRow = {
  id: number;
  username: string;
  planId: ProSalePlanId;
  priceUsd: number;
  months: number;
  expiresAt: string | null;
  createdAt: string;
};

export type ProSalesSnapshot = {
  tablesExist: boolean;
  totalSales: number;
  totalRevenueUsd: number;
  activeSubscribers: number;
  last7d: { sales: number; revenueUsd: number };
  last30d: { sales: number; revenueUsd: number };
  byPlan: Array<{ planId: ProSalePlanId; sales: number; revenueUsd: number }>;
  dailyLast30d: Array<{ day: string; sales: number; revenueUsd: number }>;
  recent: ProSaleRow[];
};

let tableReady: Promise<void> | null = null;

export async function ensureProSalesTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS pro_sales (
          id BIGSERIAL PRIMARY KEY,
          username TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          price_usd DOUBLE PRECISION NOT NULL,
          months INT NOT NULL,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS pro_sales_created_at_idx
        ON pro_sales (created_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS pro_sales_username_idx
        ON pro_sales (username)
      `;
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  await tableReady;
}

function normalizePlanId(raw: unknown): ProSalePlanId {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "quarter" || s === "year" || s === "month") return s;
  return "month";
}

export async function recordProSale(opts: {
  username: string;
  planId: string;
  priceUsd: number;
  months: number;
  expiresAt: string | null;
}): Promise<ProSaleRow | null> {
  const username = opts.username.trim();
  if (!username) return null;
  const priceUsd = Number(opts.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return null;
  const months = Math.max(1, Math.trunc(Number(opts.months) || 1));
  const planId = normalizePlanId(opts.planId);
  const expiresAt =
    opts.expiresAt && Date.parse(opts.expiresAt) > Date.now() ? opts.expiresAt : null;

  await ensureProSalesTable();
  const rows = await sql`
    INSERT INTO pro_sales (username, plan_id, price_usd, months, expires_at, created_at)
    VALUES (
      ${username},
      ${planId},
      ${priceUsd},
      ${months},
      ${expiresAt},
      NOW()
    )
    RETURNING id, username, plan_id, price_usd, months, expires_at, created_at
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: asNum(row.id),
    username: String(row.username ?? username),
    planId: normalizePlanId(row.plan_id),
    priceUsd: asNum(row.price_usd),
    months: asNum(row.months) || months,
    expiresAt: asIso(row.expires_at),
    createdAt: asIso(row.created_at) ?? new Date().toISOString(),
  };
}

export async function getProSalesSnapshot(): Promise<ProSalesSnapshot> {
  const empty: ProSalesSnapshot = {
    tablesExist: false,
    totalSales: 0,
    totalRevenueUsd: 0,
    activeSubscribers: 0,
    last7d: { sales: 0, revenueUsd: 0 },
    last30d: { sales: 0, revenueUsd: 0 },
    byPlan: [
      { planId: "month", sales: 0, revenueUsd: 0 },
      { planId: "quarter", sales: 0, revenueUsd: 0 },
      { planId: "year", sales: 0, revenueUsd: 0 },
    ],
    dailyLast30d: [],
    recent: [],
  };

  try {
    await ensureProSalesTable();
  } catch {
    return empty;
  }

  const [totals, week, month, byPlanRows, dailyRows, recentRows, activeRows] =
    await Promise.all([
      sql`
        SELECT COUNT(*)::int AS sales, COALESCE(SUM(price_usd), 0)::float AS revenue
        FROM pro_sales
      `,
      sql`
        SELECT COUNT(*)::int AS sales, COALESCE(SUM(price_usd), 0)::float AS revenue
        FROM pro_sales
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `,
      sql`
        SELECT COUNT(*)::int AS sales, COALESCE(SUM(price_usd), 0)::float AS revenue
        FROM pro_sales
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `,
      sql`
        SELECT plan_id, COUNT(*)::int AS sales, COALESCE(SUM(price_usd), 0)::float AS revenue
        FROM pro_sales
        GROUP BY plan_id
      `,
      sql`
        SELECT
          to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS sales,
          COALESCE(SUM(price_usd), 0)::float AS revenue
        FROM pro_sales
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      sql`
        SELECT id, username, plan_id, price_usd, months, expires_at, created_at
        FROM pro_sales
        ORDER BY created_at DESC
        LIMIT 50
      `,
      sql`
        SELECT COUNT(*)::int AS n
        FROM user_ai_free_quota
        WHERE pro_expires_at IS NOT NULL AND pro_expires_at > NOW()
      `.catch(() => [{ n: 0 }]),
    ]);

  const byPlanMap: Record<ProSalePlanId, { sales: number; revenueUsd: number }> = {
    month: { sales: 0, revenueUsd: 0 },
    quarter: { sales: 0, revenueUsd: 0 },
    year: { sales: 0, revenueUsd: 0 },
  };
  for (const row of byPlanRows as Array<Record<string, unknown>>) {
    const id = normalizePlanId(row.plan_id);
    byPlanMap[id] = { sales: asNum(row.sales), revenueUsd: asNum(row.revenue) };
  }

  const dailyMap = new Map<string, { sales: number; revenueUsd: number }>();
  for (const row of dailyRows as Array<Record<string, unknown>>) {
    const day = String(row.day ?? "").slice(0, 10);
    if (!day) continue;
    dailyMap.set(day, { sales: asNum(row.sales), revenueUsd: asNum(row.revenue) });
  }
  const dailyLast30d: ProSalesSnapshot["dailyLast30d"] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKeyUtc(d);
    const hit = dailyMap.get(key);
    dailyLast30d.push({
      day: key,
      sales: hit?.sales ?? 0,
      revenueUsd: hit?.revenueUsd ?? 0,
    });
  }

  const recent: ProSaleRow[] = (recentRows as Array<Record<string, unknown>>).map((row) => ({
    id: asNum(row.id),
    username: String(row.username ?? ""),
    planId: normalizePlanId(row.plan_id),
    priceUsd: asNum(row.price_usd),
    months: asNum(row.months) || 1,
    expiresAt: asIso(row.expires_at),
    createdAt: asIso(row.created_at) ?? new Date().toISOString(),
  }));

  return {
    tablesExist: true,
    totalSales: asNum((totals[0] as Record<string, unknown> | undefined)?.sales),
    totalRevenueUsd: asNum((totals[0] as Record<string, unknown> | undefined)?.revenue),
    activeSubscribers: asNum((activeRows[0] as Record<string, unknown> | undefined)?.n),
    last7d: {
      sales: asNum((week[0] as Record<string, unknown> | undefined)?.sales),
      revenueUsd: asNum((week[0] as Record<string, unknown> | undefined)?.revenue),
    },
    last30d: {
      sales: asNum((month[0] as Record<string, unknown> | undefined)?.sales),
      revenueUsd: asNum((month[0] as Record<string, unknown> | undefined)?.revenue),
    },
    byPlan: (["month", "quarter", "year"] as const).map((planId) => ({
      planId,
      sales: byPlanMap[planId].sales,
      revenueUsd: byPlanMap[planId].revenueUsd,
    })),
    dailyLast30d,
    recent,
  };
}
