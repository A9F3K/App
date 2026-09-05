/**
 * Live Vercel FOCUS billing — period totals + per-day spend from ChargePeriodStart.
 * Fetches in short day windows to avoid truncated gzip dumps on serverless.
 */
import { gunzipSync } from "zlib";

export type VercelDaySpend = {
  day: string;
  totalUsd: number;
  fixedUsd: number;
  onDemandUsd: number;
  chargeRows: number;
};

export type VercelUsageBreakdown = {
  source: "live" | "unavailable";
  detail: string;
  periodDays: number;
  from: string;
  to: string;
  totalUsd: number;
  fixedUsd: number;
  onDemandUsd: number;
  onDemandUsdMonth: number;
  fixedUsdMonth: number;
  byDay: VercelDaySpend[];
  byService: Array<{
    name: string;
    usd: number;
    quantity: number;
    unit: string | null;
    kind: "fixed" | "ondemand" | "other";
  }>;
  unitCosts: {
    functionInvocationUsd: number | null;
    fluidActiveCpuHourUsd: number | null;
    fastOriginTransferGbUsd: number | null;
  };
};

const FIXED_SERVICES = new Set(["Pro", "Build CPU Minutes"]);
const ONDEMAND_SERVICES = new Set([
  "Fast Origin Transfer",
  "Fast Data Transfer",
  "Fluid Provisioned Memory",
  "Fluid Active CPU",
  "Function Invocations",
  "Observability Events",
  "Web Analytics Events",
  "Edge Requests - Additional CPU Duration",
  "Edge Requests (Flat Rate)",
  "ISR Reads",
  "Image Optimization Transformation",
  "Image Optimization Cache Writes",
  "Image Optimization Cache Reads",
]);

function classify(name: string): "fixed" | "ondemand" | "other" {
  if (FIXED_SERVICES.has(name)) return "fixed";
  if (ONDEMAND_SERVICES.has(name)) return "ondemand";
  const lower = name.toLowerCase();
  if (lower.includes("build")) return "fixed";
  if (lower.includes("pro") && lower.length < 6) return "fixed";
  if (
    lower.includes("transfer") ||
    lower.includes("invocation") ||
    lower.includes("fluid") ||
    lower.includes("edge") ||
    lower.includes("analytics") ||
    lower.includes("observability")
  ) {
    return "ondemand";
  }
  return "other";
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function chargeUsd(row: Record<string, unknown>): number {
  const billed = num(row.BilledCost);
  if (billed !== 0) return billed;
  return num(row.EffectiveCost);
}

type Agg = {
  byService: Map<
    string,
    { usd: number; quantity: number; unit: string | null; kind: "fixed" | "ondemand" | "other" }
  >;
  byDay: Map<string, { totalUsd: number; fixedUsd: number; onDemandUsd: number; chargeRows: number }>;
  rowCount: number;
};

function emptyAgg(): Agg {
  return {
    byService: new Map(),
    byDay: new Map(),
    rowCount: 0,
  };
}

function mergeAgg(into: Agg, from: Agg): void {
  into.rowCount += from.rowCount;
  for (const [name, v] of from.byService) {
    const cur = into.byService.get(name) ?? {
      usd: 0,
      quantity: 0,
      unit: null,
      kind: v.kind,
    };
    cur.usd += v.usd;
    cur.quantity += v.quantity;
    cur.unit = v.unit ?? cur.unit;
    cur.kind = v.kind;
    into.byService.set(name, cur);
  }
  for (const [day, v] of from.byDay) {
    const cur = into.byDay.get(day) ?? {
      totalUsd: 0,
      fixedUsd: 0,
      onDemandUsd: 0,
      chargeRows: 0,
    };
    cur.totalUsd += v.totalUsd;
    cur.fixedUsd += v.fixedUsd;
    cur.onDemandUsd += v.onDemandUsd;
    cur.chargeRows += v.chargeRows;
    into.byDay.set(day, cur);
  }
}

async function aggregateBillingCharges(url: string, token: string): Promise<Agg> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Accept-Encoding": "identity",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`vercel_billing_http_${res.status}:${text.slice(0, 160)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let text: string;
  try {
    text =
      buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
        ? gunzipSync(buf).toString("utf8")
        : buf.toString("utf8");
  } catch {
    text = buf.toString("utf8");
  }

  const agg = emptyAgg();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.error) continue;
    agg.rowCount += 1;
    const name = String(row.ServiceName ?? "Unknown");
    const kind = classify(name);
    const cost = chargeUsd(row);
    const cur = agg.byService.get(name) ?? { usd: 0, quantity: 0, unit: null, kind };
    cur.usd += cost;
    cur.quantity += num(row.ConsumedQuantity);
    cur.unit = typeof row.ConsumedUnit === "string" ? row.ConsumedUnit : cur.unit;
    cur.kind = kind;
    agg.byService.set(name, cur);

    const day = String(row.ChargePeriodStart ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const d = agg.byDay.get(day) ?? {
        totalUsd: 0,
        fixedUsd: 0,
        onDemandUsd: 0,
        chargeRows: 0,
      };
      d.totalUsd += cost;
      d.chargeRows += 1;
      if (kind === "fixed") d.fixedUsd += cost;
      else if (kind === "ondemand") d.onDemandUsd += cost;
      else {
        d.fixedUsd += cost * 0.5;
        d.onDemandUsd += cost * 0.5;
      }
      agg.byDay.set(day, d);
    }
  }
  return agg;
}

function emptyUnavailable(
  periodDays: number,
  from: string,
  to: string,
  detail: string,
): VercelUsageBreakdown {
  return {
    source: "unavailable",
    detail,
    periodDays,
    from,
    to,
    totalUsd: 0,
    fixedUsd: 0,
    onDemandUsd: 0,
    onDemandUsdMonth: 0,
    fixedUsdMonth: 0,
    byDay: [],
    byService: [],
    unitCosts: {
      functionInvocationUsd: null,
      fluidActiveCpuHourUsd: null,
      fastOriginTransferGbUsd: null,
    },
  };
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function fetchWindow(
  token: string,
  teamId: string,
  fromIso: string,
  toIso: string,
): Promise<{ label: string; agg: Agg }> {
  const attempts: Array<{ label: string; qs: URLSearchParams }> = [
    { label: "account", qs: new URLSearchParams({ from: fromIso, to: toIso }) },
  ];
  if (teamId) {
    attempts.push({
      label: `team:${teamId}`,
      qs: new URLSearchParams({ from: fromIso, to: toIso, teamId }),
    });
  }
  let lastErr = "vercel_billing_failed";
  for (const attempt of attempts) {
    try {
      const agg = await aggregateBillingCharges(
        `https://api.vercel.com/v1/billing/charges?${attempt.qs.toString()}`,
        token,
      );
      if (agg.rowCount > 0) return { label: attempt.label, agg };
      lastErr = `vercel_billing_empty:${attempt.label}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : "vercel_billing_failed";
    }
  }
  throw new Error(lastErr);
}

export async function fetchVercelUsageBreakdown(
  periodDays = 14,
): Promise<VercelUsageBreakdown> {
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId =
    process.env.VERCEL_TEAM_ID?.trim() ||
    process.env.VERCEL_ORG_ID?.trim() ||
    "";
  if (!token) {
    return emptyUnavailable(
      periodDays,
      "",
      "",
      "VERCEL_TOKEN not set on the deployment — cannot fetch live billing.",
    );
  }

  const days = Math.max(1, Math.min(30, Math.round(periodDays)));
  const to = utcDayStart(new Date());
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to.getTime() - days * 86_400_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  try {
    const merged = emptyAgg();
    let scopeLabel = "account";
    const chunkDays = 2;
    const windows: Array<{ fromIso: string; toIso: string }> = [];
    for (let offset = 0; offset < days; offset += chunkDays) {
      const chunkStart = new Date(from.getTime() + offset * 86_400_000);
      const chunkEnd = new Date(
        Math.min(to.getTime(), chunkStart.getTime() + chunkDays * 86_400_000),
      );
      windows.push({
        fromIso: chunkStart.toISOString(),
        toIso: chunkEnd.toISOString(),
      });
    }
    // Fetch a few windows in parallel to stay under serverless time limits.
    const concurrency = 4;
    for (let i = 0; i < windows.length; i += concurrency) {
      const batch = windows.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((w) => fetchWindow(token, teamId, w.fromIso, w.toIso)),
      );
      for (const { label, agg } of results) {
        scopeLabel = label;
        mergeAgg(merged, agg);
      }
    }

    if (merged.rowCount === 0) {
      return emptyUnavailable(days, fromIso, toIso, "vercel_billing_empty");
    }

    let fixedUsd = 0;
    let onDemandUsd = 0;
    let otherUsd = 0;
    const byServiceList = [...merged.byService.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.usd - a.usd);
    for (const row of byServiceList) {
      if (row.kind === "fixed") fixedUsd += row.usd;
      else if (row.kind === "ondemand") onDemandUsd += row.usd;
      else otherUsd += row.usd;
    }
    onDemandUsd += otherUsd * 0.5;
    fixedUsd += otherUsd * 0.5;

    const scale = 30 / Math.max(1, days);
    const inv = merged.byService.get("Function Invocations");
    const cpu = merged.byService.get("Fluid Active CPU");
    const xfer =
      merged.byService.get("Fast Origin Transfer") ??
      merged.byService.get("Fast Data Transfer");

    const byDayList: VercelDaySpend[] = [...merged.byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({
        day,
        totalUsd: round4(v.totalUsd),
        fixedUsd: round4(v.fixedUsd),
        onDemandUsd: round4(v.onDemandUsd),
        chargeRows: v.chargeRows,
      }));

    return {
      source: "live",
      detail: `FOCUS billing ${days}d · ${scopeLabel} · ${merged.rowCount} charge rows · ${byDayList.length} days · ${chunkDays}d chunks`,
      periodDays: days,
      from: fromIso,
      to: toIso,
      totalUsd: round4(fixedUsd + onDemandUsd),
      fixedUsd: round4(fixedUsd),
      onDemandUsd: round4(onDemandUsd),
      onDemandUsdMonth: round4(onDemandUsd * scale),
      fixedUsdMonth: round4(fixedUsd * scale),
      byDay: byDayList,
      byService: byServiceList.filter((r) => r.usd > 0).slice(0, 24),
      unitCosts: {
        functionInvocationUsd:
          inv && inv.quantity > 0 ? inv.usd / inv.quantity : null,
        fluidActiveCpuHourUsd: cpu && cpu.quantity > 0 ? cpu.usd / cpu.quantity : null,
        fastOriginTransferGbUsd:
          xfer && xfer.quantity > 0 ? xfer.usd / xfer.quantity : null,
      },
    };
  } catch (err) {
    return emptyUnavailable(
      days,
      fromIso,
      toIso,
      err instanceof Error ? err.message : "vercel_billing_failed",
    );
  }
}
