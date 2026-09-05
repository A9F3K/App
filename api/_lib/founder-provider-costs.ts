/**
 * Railway + GCP cost signals — monthly totals and best-effort daily spend.
 *
 * Envs:
 *   RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_WORKSPACE_ID
 *   FOUNDER_COST_RAILWAY_USD_MONTH, FOUNDER_COST_RAILWAY_PLAN_USD_MONTH
 *   FOUNDER_COST_GCP_USD_MONTH / FOUNDER_COST_GCP_DAILY_JSON (manual fallback)
 *   GCP_SERVICE_ACCOUNT_JSON (+ optional GCP_BIGQUERY_BILLING_TABLE / DATASET)
 *   → live daily via Cloud Billing export in BigQuery (auto-discovers table)
 */
import { fetchGcpBillingFromBigQuery } from "./founder-gcp-billing.js";
export type ProviderDaySpend = {
  day: string;
  usd: number;
  source: "live" | "env" | "unavailable";
};

export type RailwayUsageBreakdown = {
  source: "live" | "env" | "unavailable";
  detail: string;
  usageUsdMonth: number;
  fixedPlanUsdMonth: number;
  totalUsdMonth: number;
  byDay: ProviderDaySpend[];
  raw?: unknown;
};

export type GcpUsageBreakdown = {
  source: "live" | "env" | "unavailable";
  detail: string;
  usdMonth: number;
  byDay: ProviderDaySpend[];
};

/** Approximate Railway list prices used when converting usage metrics → $. */
const RAILWAY_RATES_PER_UNIT: Record<string, number> = {
  // estimatedUsage values that already look like dollars (<500) are used as-is.
  MEMORY_USAGE_GB: 10,
  CPU_USAGE: 20,
  CPU_USAGE_2: 20,
  NETWORK_TX_GB: 0.05,
  DISK_USAGE_GB: 0.15,
  EPHEMERAL_DISK_USAGE_GB: 0.15,
  BACKUP_USAGE_GB: 0.15,
};

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function utcDayKeys(days: number): string[] {
  const out: string[] = [];
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Spread a monthly $ evenly across calendar days (marked source=env). */
function spreadMonthly(usdMonth: number, days: number, source: "env" | "unavailable"): ProviderDaySpend[] {
  const per = usdMonth / Math.max(1, days);
  return utcDayKeys(days).map((day) => ({ day, usd: round4(per), source }));
}

/** Project tokens are UUIDs and must use Project-Access-Token; account/team tokens use Bearer. */
function railwayAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  // Project tokens require Project-Access-Token; account/team tokens use Bearer.
  // Send both so either token type works.
  if (isUuid) {
    headers["Project-Access-Token"] = token;
  }
  headers.Authorization = `Bearer ${token}`;
  return headers;
}

function metricPointDay(ts: unknown): string | null {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // Railway metrics return unix seconds.
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(ts ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

async function railwayGraphql(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch("https://backboard.railway.app/graphql/v2", {
    method: "POST",
    headers: railwayAuthHeaders(token),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`railway_http_${res.status}`);
  }
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message ?? "err").join("; ").slice(0, 200));
  }
  return json.data;
}

/** Monthly $ from continuous gauges (CPU / RAM / disk) + egress sum. */
function usdMonthFromMetricSeries(
  metrics: Array<{
    measurement?: string;
    values?: Array<{ ts?: string | number; value?: number }>;
  }>,
  periodDays: number,
): { usageUsd: number; dayWeights: Map<string, number> } {
  const dayWeights = new Map<string, number>();
  let cpuSum = 0;
  let cpuN = 0;
  let memSum = 0;
  let memN = 0;
  let diskSum = 0;
  let diskN = 0;
  let networkSum = 0;

  for (const series of metrics) {
    const m = String(series.measurement ?? "");
    for (const point of series.values ?? []) {
      const v = Number(point.value ?? 0);
      if (!(Number.isFinite(v) && v >= 0)) continue;
      const day = metricPointDay(point.ts);
      if (m === "CPU_USAGE" || m === "CPU_USAGE_2") {
        cpuSum += v;
        cpuN += 1;
        if (day) dayWeights.set(day, (dayWeights.get(day) ?? 0) + v * RAILWAY_RATES_PER_UNIT.CPU_USAGE);
      } else if (m === "MEMORY_USAGE_GB") {
        memSum += v;
        memN += 1;
        if (day) {
          dayWeights.set(
            day,
            (dayWeights.get(day) ?? 0) + v * RAILWAY_RATES_PER_UNIT.MEMORY_USAGE_GB,
          );
        }
      } else if (m === "DISK_USAGE_GB" || m === "EPHEMERAL_DISK_USAGE_GB") {
        diskSum += v;
        diskN += 1;
        if (day) {
          dayWeights.set(
            day,
            (dayWeights.get(day) ?? 0) + v * RAILWAY_RATES_PER_UNIT.DISK_USAGE_GB,
          );
        }
      } else if (m === "NETWORK_TX_GB") {
        networkSum += v;
        if (day) {
          dayWeights.set(
            day,
            (dayWeights.get(day) ?? 0) + v * RAILWAY_RATES_PER_UNIT.NETWORK_TX_GB,
          );
        }
      }
    }
  }

  const cpuAvg = cpuN > 0 ? cpuSum / cpuN : 0;
  const memAvg = memN > 0 ? memSum / memN : 0;
  const diskAvg = diskN > 0 ? diskSum / diskN : 0;
  // Network series is often per-interval GB; scale window → ~30d.
  const networkMonth =
    networkSum * (30 / Math.max(1, periodDays)) * RAILWAY_RATES_PER_UNIT.NETWORK_TX_GB;

  const usageUsd =
    cpuAvg * RAILWAY_RATES_PER_UNIT.CPU_USAGE +
    memAvg * RAILWAY_RATES_PER_UNIT.MEMORY_USAGE_GB +
    diskAvg * RAILWAY_RATES_PER_UNIT.DISK_USAGE_GB +
    networkMonth;

  return { usageUsd: round4(Math.max(0, usageUsd)), dayWeights };
}

export async function fetchRailwayUsageBreakdown(
  periodDays = 14,
): Promise<RailwayUsageBreakdown> {
  const days = Math.max(1, Math.min(30, Math.round(periodDays)));
  const envUsage = envNum("FOUNDER_COST_RAILWAY_USD_MONTH", 15);
  const plan = envNum("FOUNDER_COST_RAILWAY_PLAN_USD_MONTH", 5);
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const workspaceId = process.env.RAILWAY_WORKSPACE_ID?.trim();

  if (!token) {
    return {
      source: "env",
      detail:
        "RAILWAY_API_TOKEN unset — set it + RAILWAY_PROJECT_ID on Vercel for live Railway spend. Using FOUNDER_COST_RAILWAY_USD_MONTH.",
      usageUsdMonth: Math.max(0, envUsage - plan),
      fixedPlanUsdMonth: plan,
      totalUsdMonth: envUsage,
      byDay: spreadMonthly(envUsage, days, "env"),
    };
  }

  const railwayMeasurements = [
    "CPU_USAGE",
    "MEMORY_USAGE_GB",
    "NETWORK_TX_GB",
    "DISK_USAGE_GB",
    "EPHEMERAL_DISK_USAGE_GB",
  ];

  try {
    let usageUsd = 0;
    let byDay: ProviderDaySpend[] = [];
    let raw: unknown = undefined;
    let detailCore = "Railway";

    // Prefer time-series metrics (works with project tokens via Project-Access-Token).
    if (projectId) {
      try {
        const start = new Date(Date.now() - days * 86_400_000).toISOString();
        const metricsData = (await railwayGraphql(
          token,
          `query($projectId: String!, $startDate: DateTime!, $measurements: [MetricMeasurement!]!) {
            metrics(projectId: $projectId, measurements: $measurements, startDate: $startDate) {
              measurement
              values { ts value }
            }
          }`,
          {
            projectId,
            startDate: start,
            measurements: railwayMeasurements,
          },
        )) as {
          metrics?: Array<{
            measurement?: string;
            values?: Array<{ ts?: string | number; value?: number }>;
          }>;
        };

        const series = metricsData.metrics ?? [];
        const fromMetrics = usdMonthFromMetricSeries(series, days);
        if (fromMetrics.usageUsd > 0) {
          usageUsd = fromMetrics.usageUsd;
          detailCore = `Railway metrics · ~$${usageUsd.toFixed(2)}/mo usage (CPU/RAM/disk/egress)`;
          raw = series.map((s) => ({
            measurement: s.measurement,
            points: s.values?.length ?? 0,
          }));
          const weightSum = [...fromMetrics.dayWeights.values()].reduce((a, b) => a + b, 0);
          if (weightSum > 0) {
            const total = usageUsd + plan;
            byDay = utcDayKeys(days).map((day) => {
              const w = fromMetrics.dayWeights.get(day) ?? 0;
              return {
                day,
                usd: round4((w / weightSum) * total),
                source: "live" as const,
              };
            });
          }
        }
      } catch {
        /* fall through to estimatedUsage */
      }
    }

    if (!(usageUsd > 0)) {
      // Current-cycle estimated usage — values are resource-seconds; convert with list rates.
      const usageData = (await railwayGraphql(
        token,
        projectId
          ? `query($projectId: String, $measurements: [MetricMeasurement!]!) {
              estimatedUsage(projectId: $projectId, measurements: $measurements) {
                measurement estimatedValue
              }
            }`
          : workspaceId
            ? `query($workspaceId: String, $measurements: [MetricMeasurement!]!) {
                estimatedUsage(workspaceId: $workspaceId, measurements: $measurements) {
                  measurement estimatedValue
                }
              }`
            : `query($measurements: [MetricMeasurement!]!) {
                estimatedUsage(measurements: $measurements) {
                  measurement estimatedValue
                }
              }`,
        projectId
          ? { projectId, measurements: railwayMeasurements }
          : workspaceId
            ? { workspaceId, measurements: railwayMeasurements }
            : { measurements: railwayMeasurements },
      )) as { estimatedUsage?: Array<{ measurement?: string; estimatedValue?: number }> };

      const rows = usageData.estimatedUsage ?? [];
      raw = rows.slice(0, 12);
      const secondsPerMonth = 30 * 24 * 3600;
      for (const row of rows) {
        const m = String(row.measurement ?? "");
        const v = Number(row.estimatedValue ?? 0);
        if (!(Number.isFinite(v) && v > 0)) continue;
        const rate = RAILWAY_RATES_PER_UNIT[m];
        if (rate) usageUsd += (v / secondsPerMonth) * rate;
      }
      detailCore = `Railway estimatedUsage (${rows.length} measurements)`;
    }

    if (!(usageUsd > 0) || usageUsd > Math.max(envUsage, 5) * 50) {
      usageUsd = Math.max(0, envUsage - plan);
      detailCore = `${detailCore} · clamped to env fallback`;
    }

    if (byDay.length === 0) {
      byDay = spreadMonthly(usageUsd + plan, days, "live").map((d) => ({
        ...d,
        source: "live" as const,
      }));
    }

    return {
      source: "live",
      detail: `${detailCore}${projectId ? ` · project ${projectId}` : ""}`,
      usageUsdMonth: round4(usageUsd),
      fixedPlanUsdMonth: plan,
      totalUsdMonth: round4(usageUsd + plan),
      byDay,
      raw,
    };
  } catch (err) {
    return {
      source: "env",
      detail: err instanceof Error ? err.message : "railway_failed",
      usageUsdMonth: Math.max(0, envUsage - plan),
      fixedPlanUsdMonth: plan,
      totalUsdMonth: envUsage,
      byDay: spreadMonthly(envUsage, days, "env"),
    };
  }
}

export async function fetchGcpUsageBreakdown(periodDays = 14): Promise<GcpUsageBreakdown> {
  const days = Math.max(1, Math.min(30, Math.round(periodDays)));
  const envUsd = envNum("FOUNDER_COST_GCP_USD_MONTH", 0);
  const saJson = process.env.GCP_SERVICE_ACCOUNT_JSON?.trim();

  // Prefer live BigQuery billing export (auto-discovers table when unset).
  let bigQueryDetail: string | undefined;
  if (saJson || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    try {
      const live = await fetchGcpBillingFromBigQuery(days);
      if (live.ok) {
        const byDay: ProviderDaySpend[] = utcDayKeys(days).map((day) => {
          const hit = live.byDay.find((d) => d.day === day);
          return {
            day,
            usd: hit ? hit.usd : 0,
            source: "live" as const,
          };
        });
        const windowSum = byDay.reduce((a, d) => a + d.usd, 0);
        return {
          source: "live",
          detail: live.detail,
          usdMonth:
            windowSum > 0
              ? round4(windowSum * (30 / days))
              : live.usdMonth > 0
                ? live.usdMonth
                : envUsd,
          byDay,
        };
      }
      // Keep discovery/query error visible; still allow manual JSON / monthly fallback.
      bigQueryDetail = live.detail;
    } catch (err) {
      bigQueryDetail =
        err instanceof Error ? err.message : "gcp_bigquery_failed";
    }
  }

  const dailyJson = process.env.FOUNDER_COST_GCP_DAILY_JSON?.trim();
  if (dailyJson) {
    try {
      const parsed = JSON.parse(dailyJson) as Array<{ day?: string; usd?: number }>;
      const byDay = parsed
        .filter((r) => r.day && Number.isFinite(Number(r.usd)))
        .map((r) => ({
          day: String(r.day),
          usd: round4(Number(r.usd)),
          source: "live" as const,
        }));
      if (byDay.length > 0) {
        const sum = byDay.reduce((a, d) => a + d.usd, 0);
        return {
          source: "live",
          detail: `FOUNDER_COST_GCP_DAILY_JSON · ${byDay.length} days`,
          usdMonth: round4(sum * (30 / byDay.length)),
          byDay,
        };
      }
    } catch {
      /* fall through */
    }
  }

  if (envUsd > 0) {
    return {
      source: "env",
      detail: bigQueryDetail
        ? `${bigQueryDetail} · using FOUNDER_COST_GCP_USD_MONTH`
        : "Using FOUNDER_COST_GCP_USD_MONTH. For live daily: enable Billing → BigQuery export + GCP_SERVICE_ACCOUNT_JSON.",
      usdMonth: envUsd,
      byDay: spreadMonthly(envUsd, days, "env"),
    };
  }

  return {
    source: saJson ? "env" : "unavailable",
    detail:
      bigQueryDetail ||
      (saJson
        ? "GCP SA present but billing export not readable — enable Cloud Billing → BigQuery export, grant BigQuery Data Viewer + Job User, or set FOUNDER_COST_GCP_DAILY_JSON / FOUNDER_COST_GCP_USD_MONTH."
        : "GCP billing not configured (set GCP_SERVICE_ACCOUNT_JSON or FOUNDER_COST_GCP_USD_MONTH)."),
    usdMonth: 0,
    byDay: utcDayKeys(days).map((day) => ({ day, usd: 0, source: "unavailable" as const })),
  };
}
