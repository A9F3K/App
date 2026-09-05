/**
 * Run a timed 1-user style traffic probe against production (screen-time cadence).
 * Usage: node scripts/founder-consumption-probe.mjs [minutes=5] [baseUrl]
 */
import { writeFileSync } from "fs";

const minutes = Math.max(1, Number(process.argv[2] || 5));
const base = (process.argv[3] || "https://program.hyperlinks.space").replace(/\/$/, "");
const durationMs = Math.round(minutes * 60_000);
const heartbeatMs = 30_000;

/** Published-ish defaults; overwritten if FOUNDER_PROBE uses live unit costs later. */
const UNIT = {
  functionInvocationUsd: 0.6 / 1_000_000,
  transferGbUsd: 0.15,
  perRequestCpuUsd: 0.00002,
};

const endpoints = [
  { path: "/api/ping", weight: 2 },
  { path: "/api/feed", weight: 1 },
  { path: "/api/ton-account-holdings?address=EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c", weight: 1 },
  { path: "/", weight: 1 },
];

function pickEndpoint() {
  const total = endpoints.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of endpoints) {
    r -= e.weight;
    if (r <= 0) return e.path;
  }
  return endpoints[0].path;
}

const stats = {
  requests: 0,
  bytesIn: 0,
  bytesOut: 0,
  errors: 0,
  byPath: /** @type {Record<string, { count: number; ok: number }>} */ ({}),
};

async function hit(path) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const started = Date.now();
  stats.requests += 1;
  const row = (stats.byPath[path] ||= { count: 0, ok: 0 });
  row.count += 1;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "*/*", "Cache-Control": "no-store" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    stats.bytesIn += buf.length;
    stats.bytesOut += url.length + 120;
    if (res.ok || res.status === 401 || res.status === 403) row.ok += 1;
    else stats.errors += 1;
    return Date.now() - started;
  } catch {
    stats.errors += 1;
    return Date.now() - started;
  }
}

function estimateUsd() {
  const transferGb = (stats.bytesIn + stats.bytesOut) / (1024 ** 3);
  return (
    stats.requests * UNIT.functionInvocationUsd +
    stats.requests * UNIT.perRequestCpuUsd +
    transferGb * UNIT.transferGbUsd
  );
}

const startedAt = Date.now();
console.log(`[probe] base=${base} duration=${minutes}m heartbeat=${heartbeatMs}ms`);

await hit("/api/ping");
await hit("/");

while (Date.now() - startedAt < durationMs) {
  const loopStart = Date.now();
  // Screen-time heartbeat cadence + a few on-demand API calls per tick.
  await hit("/api/ping");
  await hit(pickEndpoint());
  await hit(pickEndpoint());
  const elapsed = Date.now() - loopStart;
  const sleep = Math.max(0, heartbeatMs - elapsed);
  if (Date.now() - startedAt + sleep >= durationMs) break;
  await new Promise((r) => setTimeout(r, sleep));
}

const durationActual = Date.now() - startedAt;
const hours = durationActual / 3_600_000;
const usd = estimateUsd();
const perHour = usd / Math.max(hours, 1e-9);
const month = (h) => ({
  activeHoursMonth: h * 30,
  onDemandUsdMonth: Number((perHour * h * 30).toFixed(2)),
});

const result = {
  generatedAt: new Date().toISOString(),
  base,
  durationMs: durationActual,
  durationMinutes: Number((durationActual / 60_000).toFixed(2)),
  requests: stats.requests,
  bytesIn: stats.bytesIn,
  bytesOut: stats.bytesOut,
  errors: stats.errors,
  endpoints: Object.entries(stats.byPath).map(([path, v]) => ({
    path,
    count: v.count,
    ok: v.ok,
  })),
  estimatedOnDemandUsd: Number(usd.toFixed(6)),
  onDemandUsdPerActiveHour: Number(perHour.toFixed(6)),
  monthlyAtHoursPerDay: {
    h2: month(2),
    h2_5: month(2.5),
    h3: month(3),
  },
  method:
    "synthetic_1_user_screen_cadence: GET /api/ping + mixed APIs every 30s for probe window; priced with Function Invocation + transfer + CPU floor",
};

const outPath = "scripts/founder-consumption-probe-last.json";
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
console.log(`[probe] wrote ${outPath}`);
