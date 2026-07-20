/**
 * /api/voice-debug — in-memory freeze / longtask log collector.
 *
 * POST { event: string, details: object, ts: number } — append a freeze event.
 * GET  ?n=50 — return last N events as JSON (default 100).
 * GET  ?html=1 — return a self-refreshing HTML viewer.
 *
 * Events are kept in a per-process ring buffer (max 500). This is enough for
 * development / debugging without a database. The buffer resets on cold start.
 */

type FreezeEvent = {
  event: string;
  details: Record<string, unknown>;
  ts: number;
  receivedAt: string;
};

const MAX_EVENTS = 500;
const events: FreezeEvent[] = [];

function pushEvent(ev: FreezeEvent) {
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function htmlViewer(recent: FreezeEvent[]): Response {
  const rows = recent
    .slice()
    .reverse()
    .map((e) => {
      const isError =
        String((e.details as Record<string, unknown>).level) === "error";
      const color = isError ? "#ff4444" : "#ffaa00";
      const durationMs =
        (e.details as Record<string, unknown>).durationMs ??
        (e.details as Record<string, unknown>).gapMs ??
        "";
      return `<tr style="color:${color}">
      <td style="white-space:nowrap;padding:2px 8px">${e.receivedAt.replace("T", " ").replace("Z", "")}</td>
      <td style="padding:2px 8px">${e.event}</td>
      <td style="padding:2px 8px">${durationMs ? durationMs + "ms" : ""}</td>
      <td style="padding:2px 8px;font-size:11px;color:#aaa">${JSON.stringify(e.details).slice(0, 200)}</td>
    </tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Voice Freeze Log</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body { background:#111; color:#eee; font-family:monospace; font-size:13px; margin:0; padding:16px }
    h1 { color:#fff; font-size:16px; margin:0 0 12px }
    table { border-collapse:collapse; width:100% }
    tr:nth-child(even) { background:#1a1a1a }
    th { text-align:left; padding:4px 8px; color:#888; border-bottom:1px solid #333 }
  </style>
</head>
<body>
  <h1>Voice Dialog Freeze Events — ${recent.length} total (auto-refresh every 3s)</h1>
  <p style="color:#666;margin:0 0 8px">POST to /api/voice-debug to add events. Showing most recent first.</p>
  <table>
    <tr><th>Time (UTC)</th><th>Event</th><th>Duration</th><th>Details</th></tr>
    ${rows || '<tr><td colspan="4" style="color:#555;padding:8px">No freeze events recorded yet.</td></tr>'}
  </table>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRes({ ok: false, error: "invalid_json" }, 400);
    }
    const b = body as Record<string, unknown>;
    pushEvent({
      event: String(b.event ?? "unknown"),
      details: (b.details as Record<string, unknown>) ?? {},
      ts: typeof b.ts === "number" ? b.ts : Date.now(),
      receivedAt: new Date().toISOString(),
    });
    return jsonRes({ ok: true, total: events.length });
  }

  // GET
  const n = Math.min(500, Math.max(1, Number(url.searchParams.get("n") ?? "100")));
  const recent = events.slice(-n);

  if (url.searchParams.get("html") === "1") {
    return htmlViewer(recent);
  }

  return jsonRes({ ok: true, count: recent.length, total: events.length, events: recent });
}

export default handler;
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
