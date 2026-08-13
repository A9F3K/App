import {
  CHART_MAX_RETRIES,
  CHART_RATE_LIMIT_MS,
  DYOR_CHART_API_BASE,
  SWAP_COFFEE_TOKENS_API_BASE,
  SWAP_MAX_TIME_RANGE_DAYS,
  TON_JETTON_ADDRESS,
  type SwapChartResolution,
} from "./swapChartConstants";
import type { SwapChartPoint } from "./swapChartFormat";
import { swapChartError, swapChartLog, swapChartWarn } from "./swapChartDebug";

export type SwapMarketStats = {
  priceUsd: number | null;
  mcap: number | null;
  fdmc: number | null;
  volume24h: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
};

export type NormalizedChartSeries = {
  points: SwapChartPoint[];
  normalized: number[];
  minPrice: number;
  maxPrice: number;
  firstTimestamp: Date | null;
  lastTimestamp: Date | null;
};

let lastChartApiCallMs = 0;

async function respectChartRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastChartApiCallMs;
  if (elapsed < CHART_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, CHART_RATE_LIMIT_MS - elapsed));
  }
  lastChartApiCallMs = Date.now();
}

function getTimeRange(resolution: SwapChartResolution): { from: string; to: string } {
  const now = new Date();
  const maxDays = SWAP_MAX_TIME_RANGE_DAYS[resolution] ?? 30;
  const from = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

function parseChartPoints(raw: unknown): SwapChartPoint[] {
  if (!raw || typeof raw !== "object") {
    swapChartWarn("parse_empty_raw", { rawType: typeof raw });
    return [];
  }
  const envelope = raw as Record<string, unknown>;
  if ("code" in envelope && !("points" in envelope)) {
    swapChartWarn("parse_api_error_envelope", {
      code: envelope.code,
      message: envelope.message,
    });
    return [];
  }
  const points = envelope.points;
  if (!Array.isArray(points)) {
    swapChartWarn("parse_no_points_array", { keys: Object.keys(envelope) });
    return [];
  }

  const out: SwapChartPoint[] = [];
  let skipped = 0;
  for (const point of points) {
    if (!point || typeof point !== "object") {
      skipped += 1;
      continue;
    }
    const valueObj = (point as { value?: unknown }).value;
    const timeStr = (point as { time?: unknown }).time;
    if (!valueObj || typeof valueObj !== "object" || typeof timeStr !== "string") {
      skipped += 1;
      continue;
    }

    const valueStr = (valueObj as { value?: unknown }).value;
    const decimals = (valueObj as { decimals?: unknown }).decimals;
    if (typeof valueStr !== "string" || typeof decimals !== "number") {
      skipped += 1;
      continue;
    }

    const value = Number.parseInt(valueStr, 10);
    if (!Number.isFinite(value)) {
      skipped += 1;
      continue;
    }
    const realValue = value * 10 ** -decimals;

    const timestamp = new Date(timeStr);
    if (Number.isNaN(timestamp.getTime())) {
      skipped += 1;
      continue;
    }

    out.push({ price: realValue, timestamp });
  }

  swapChartLog("parse_done", {
    rawCount: points.length,
    parsedCount: out.length,
    skipped,
    sampleFirst: out[0]
      ? { price: out[0].price, time: out[0].timestamp.toISOString() }
      : null,
    sampleLast: out[out.length - 1]
      ? {
          price: out[out.length - 1]!.price,
          time: out[out.length - 1]!.timestamp.toISOString(),
        }
      : null,
  });

  return out.reverse();
}

export function normalizeChartSeries(points: SwapChartPoint[]): NormalizedChartSeries | null {
  if (points.length === 0) return null;

  const prices = points.map((p) => p.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice;

  const normalized =
    range > 0
      ? prices.map((price) => (price - minPrice) / range)
      : prices.map(() => 0.5);

  return {
    points,
    normalized,
    minPrice,
    maxPrice,
    firstTimestamp: points[0]?.timestamp ?? null,
    lastTimestamp: points[points.length - 1]?.timestamp ?? null,
  };
}

export async function fetchJettonChartSeries(
  jettonAddress: string,
  resolution: SwapChartResolution,
  opts?: { respectGlobalRateLimit?: boolean },
): Promise<{ ok: true; series: NormalizedChartSeries } | { ok: false; error: string; retryable: boolean }> {
  if (opts?.respectGlobalRateLimit !== false) {
    await respectChartRateLimit();
  }

  const address = jettonAddress.trim();
  if (!address) {
    return { ok: false, error: "Missing jetton address", retryable: false };
  }

  const timeRange = getTimeRange(resolution);
  const url = new URL(
    `${DYOR_CHART_API_BASE}/v1/jettons/${encodeURIComponent(address)}/price/chart`,
  );
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("currency", "usd");
  url.searchParams.set("from", timeRange.from);
  url.searchParams.set("to", timeRange.to);

  swapChartLog("fetch_start", {
    jettonAddress: address,
    resolution,
    url: url.toString(),
    from: timeRange.from,
    to: timeRange.to,
  });

  try {
    const startedAt = Date.now();
    const response = await fetch(url.toString(), { credentials: "omit" });
    const elapsedMs = Date.now() - startedAt;

    swapChartLog("fetch_response", {
      jettonAddress: address,
      status: response.status,
      ok: response.ok,
      elapsedMs,
    });

    if (response.status === 429) {
      return { ok: false, error: "Rate limit exceeded. Retrying…", retryable: true };
    }
    if (!response.ok) {
      let bodyPreview = "";
      try {
        bodyPreview = (await response.text()).slice(0, 240);
      } catch {
        bodyPreview = "(unreadable body)";
      }
      swapChartWarn("fetch_http_error", {
        jettonAddress: address,
        status: response.status,
        bodyPreview,
      });
      return {
        ok: false,
        error: `Failed to load chart (${response.status})`,
        retryable: response.status >= 500,
      };
    }

    const data = await response.json();
    swapChartLog("fetch_json", {
      jettonAddress: address,
      topLevelKeys: data && typeof data === "object" ? Object.keys(data as object) : [],
    });

    const parsed = parseChartPoints(data);
    if (parsed.length === 0) {
      swapChartWarn("fetch_no_parsed_points", { jettonAddress: address });
      return { ok: false, error: "No price data available", retryable: false };
    }

    const series = normalizeChartSeries(parsed);
    if (!series) {
      swapChartWarn("fetch_normalize_failed", { jettonAddress: address });
      return { ok: false, error: "No price data available", retryable: false };
    }

    swapChartLog("fetch_success", {
      jettonAddress: address,
      pointCount: series.points.length,
      minPrice: series.minPrice,
      maxPrice: series.maxPrice,
      firstTs: series.firstTimestamp?.toISOString() ?? null,
      lastTs: series.lastTimestamp?.toISOString() ?? null,
    });

    return { ok: true, series };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    swapChartError("fetch_exception", {
      jettonAddress: address,
      message,
      name: e instanceof Error ? e.name : "unknown",
    });
    return { ok: false, error: `Network error: ${message}`, retryable: true };
  }
}

export async function fetchSwapChartSeries(
  resolution: SwapChartResolution,
  jettonAddress: string = TON_JETTON_ADDRESS,
): Promise<{ ok: true; series: NormalizedChartSeries } | { ok: false; error: string; retryable: boolean }> {
  return fetchJettonChartSeries(jettonAddress, resolution);
}

export async function fetchSwapMarketStats(
  jettonAddress: string = TON_JETTON_ADDRESS,
): Promise<SwapMarketStats> {
  const empty: SwapMarketStats = {
    priceUsd: null,
    mcap: null,
    fdmc: null,
    volume24h: null,
    priceChange5m: null,
    priceChange1h: null,
    priceChange6h: null,
    priceChange24h: null,
  };

  const address = jettonAddress.trim() || TON_JETTON_ADDRESS;

  try {
    const url = `${SWAP_COFFEE_TOKENS_API_BASE.replace(/\/$/, "")}/api/v3/jettons/${encodeURIComponent(address)}`;
    swapChartLog("market_stats_start", { url, jettonAddress: address });
    const response = await fetch(url, { credentials: "omit" });
    swapChartLog("market_stats_response", {
      status: response.status,
      ok: response.ok,
      jettonAddress: address,
    });
    if (!response.ok) return empty;

    const data = await response.json();
    const marketStats =
      data && typeof data === "object" ? (data as { market_stats?: unknown }).market_stats : null;
    if (!marketStats || typeof marketStats !== "object") return empty;

    const m = marketStats as Record<string, unknown>;
    const num = (k: string) => {
      const v = m[k];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };

    const stats = {
      priceUsd: num("price_usd"),
      mcap: num("mcap"),
      fdmc: num("fdmc"),
      volume24h: num("volume_usd_24h"),
      priceChange5m: num("price_change_5m"),
      priceChange1h: num("price_change_1h"),
      priceChange6h: num("price_change_6h"),
      priceChange24h: num("price_change_24h"),
    };
    swapChartLog("market_stats_success", { ...stats, jettonAddress: address });
    return stats;
  } catch (e) {
    swapChartWarn("market_stats_exception", {
      jettonAddress: address,
      message: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

export function chartRetryDelayMs(attempt: number): number {
  return 2 ** Math.max(0, attempt - 1) * 1000;
}

export function chartMaxRetries(): number {
  return CHART_MAX_RETRIES;
}
