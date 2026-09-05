/**
 * Build a printable founder report and open the browser Save-as-PDF dialog.
 * Web-only — no PDF library dependency.
 */

type MoneyN = number;

function money(n: MoneyN): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function hoursFromMs(ms: number): string {
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type FounderPdfPayload = {
  generatedAt: string;
  screenTime: {
    usersWithScreenTime: number;
    totalActiveHours: number;
    totalSessions: number;
    avgHoursPerActiveUserPerDay7d: number;
    last7d: { activeHours: number; sessions: number; distinctUsers: number };
    last30d: { activeHours: number; sessions: number; distinctUsers: number };
  };
  users: { totalUsers: number; telegramConnected: number };
  dailyUsage?: Array<{
    day: string;
    activeMs: number;
    distinctUsers: number;
    sessions: number;
    avgActiveMsPerUser: number;
    estimatedOnDemandUsd: number;
    estimatedTotalUsd: number;
  }>;
  model: {
    tariffs: { monthUsd: number; blendedArpuMonthlyUsd: number };
    infraTotalUsdMonth: number;
    personalTotalUsdMonth: number;
    burnTotalUsdMonth: number;
    observedOnDemandUsdMonth?: number;
    costs: { variablePerActiveHourUsd: number };
    breakeven: {
      payingUsersInfraOnly: number;
      payingUsersWithPersonalBurn: number;
      assumptions: string;
    };
    launchExperiment: {
      estimatedFixedInfraUsdMonth: number;
      estimatedVariablePerActiveHourUsd: number;
      costIfOneUserOneHourUsd: number;
      costIfOneUserObservedDayUsd: number;
      costIfOneUserMonthAtObservedHoursUsd: number;
      onDemandMonthAt2hUsd?: number;
      onDemandMonthAt3hUsd?: number;
      windowNote: string;
    };
    calibration?: {
      onDemandUsdPerActiveHour: number;
      confidence?: number;
      source: string;
      avgUser?: {
        hoursPerDay7d: number;
        onDemandUsdMonthAtObserved: number;
        onDemandUsdMonthAt2h: number;
        onDemandUsdMonthAt3h: number;
      };
      evidence?: {
        distinctUsers30d: number;
        sessionCount30d: number;
        activeDays30d: number;
        pairedSnapshotDays: number;
        snapshotDays: number;
      } | null;
    };
    scenarios: Array<{
      label: string;
      payingUsers: number;
      avgScreenHoursPerDay: number;
      revenueMonthlyUsd: number;
      onDemandMonthlyUsd?: number;
      totalCostMonthlyUsd: number;
      profitMonthlyUsd: number;
    }>;
  };
  providers: Array<{
    label: string;
    usdMonthEstimate: number | null;
    source: string;
    detail?: string;
  }>;
  vercelUsage?: {
    source: string;
    periodDays?: number;
    fixedUsdMonth: number;
    onDemandUsdMonth: number;
    totalUsd: number;
  };
};

function buildHtml(data: FounderPdfPayload): string {
  const m = data.model;
  const cal = m.calibration;
  const daily = [...(data.dailyUsage ?? [])].reverse().slice(0, 30);
  const dailyRows = daily
    .map(
      (d) =>
        `<tr>
          <td>${esc(d.day)}</td>
          <td>${d.distinctUsers}</td>
          <td>${hoursFromMs(d.avgActiveMsPerUser)}</td>
          <td>${hoursFromMs(d.activeMs)}</td>
          <td>${d.sessions}</td>
          <td>${money(d.estimatedOnDemandUsd)}</td>
          <td>${money(d.estimatedTotalUsd)}</td>
        </tr>`,
    )
    .join("");

  const scenarios = m.scenarios
    .map(
      (s) =>
        `<tr>
          <td>${esc(s.label)}</td>
          <td>${s.payingUsers}</td>
          <td>${s.avgScreenHoursPerDay.toFixed(2)}h</td>
          <td>${money(s.revenueMonthlyUsd)}</td>
          <td>${money(s.onDemandMonthlyUsd ?? 0)}</td>
          <td>${money(s.totalCostMonthlyUsd)}</td>
          <td>${money(s.profitMonthlyUsd)}</td>
        </tr>`,
    )
    .join("");

  const providers = data.providers
    .map(
      (p) =>
        `<li><strong>${esc(p.label)}</strong>: ${money(p.usdMonthEstimate ?? 0)} · ${esc(p.source)}${
          p.detail ? ` — ${esc(p.detail)}` : ""
        }</li>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>HSP Founder model · ${esc(new Date(data.generatedAt).toISOString().slice(0, 10))}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: "Segoe UI", system-ui, sans-serif; color: #111; margin: 28px; font-size: 12px; line-height: 1.45; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
    .muted { color: #555; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin: 10px 0; }
    .metric { border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; }
    .metric .label { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric .value { font-size: 16px; font-weight: 700; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { border: 1px solid #ddd; padding: 5px 6px; text-align: left; }
    th { background: #f4f4f4; font-size: 10px; text-transform: uppercase; }
    ul { padding-left: 18px; margin: 6px 0; }
    @media print {
      body { margin: 12mm; }
      h2 { break-after: avoid; }
      table { break-inside: auto; }
      tr { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>Hyperlinks Space Program — Founder model</h1>
  <p class="muted">Generated ${esc(new Date(data.generatedAt).toLocaleString())} · Choose “Save as PDF” in the print dialog.</p>

  <h2>Breakeven</h2>
  <div class="grid">
    <div class="metric"><div class="label">Infra only</div><div class="value">${m.breakeven.payingUsersInfraOnly}</div></div>
    <div class="metric"><div class="label">Life burn</div><div class="value">${m.breakeven.payingUsersWithPersonalBurn}</div></div>
    <div class="metric"><div class="label">Blended ARPU</div><div class="value">${money(m.tariffs.blendedArpuMonthlyUsd)}</div></div>
    <div class="metric"><div class="label">Monthly burn</div><div class="value">${money(m.burnTotalUsdMonth)}</div></div>
    <div class="metric"><div class="label">Observed on-demand</div><div class="value">${money(m.observedOnDemandUsdMonth ?? 0)}</div></div>
    <div class="metric"><div class="label">Fixed infra</div><div class="value">${money(m.infraTotalUsdMonth)}</div></div>
  </div>
  <p class="muted">${esc(m.breakeven.assumptions)}</p>

  <h2>Launch experiment (1 user)</h2>
  <p class="muted">${esc(m.launchExperiment.windowNote)}</p>
  <div class="grid">
    <div class="metric"><div class="label">$/active hour</div><div class="value">${money(m.launchExperiment.estimatedVariablePerActiveHourUsd)}</div></div>
    <div class="metric"><div class="label">1 hour</div><div class="value">${money(m.launchExperiment.costIfOneUserOneHourUsd)}</div></div>
    <div class="metric"><div class="label">1 day</div><div class="value">${money(m.launchExperiment.costIfOneUserObservedDayUsd)}</div></div>
    <div class="metric"><div class="label">1 month</div><div class="value">${money(m.launchExperiment.costIfOneUserMonthAtObservedHoursUsd)}</div></div>
    <div class="metric"><div class="label">On-demand @ 2h/day</div><div class="value">${money(m.launchExperiment.onDemandMonthAt2hUsd ?? 0)}</div></div>
    <div class="metric"><div class="label">On-demand @ 3h/day</div><div class="value">${money(m.launchExperiment.onDemandMonthAt3hUsd ?? 0)}</div></div>
  </div>

  <h2>Calibration</h2>
  <div class="grid">
    <div class="metric"><div class="label">$/active hour</div><div class="value">${money(cal?.onDemandUsdPerActiveHour ?? m.costs.variablePerActiveHourUsd)}</div></div>
    <div class="metric"><div class="label">Confidence</div><div class="value">${Math.round((cal?.confidence ?? 0) * 100)}%</div></div>
    <div class="metric"><div class="label">Avg user h/day</div><div class="value">${(cal?.avgUser?.hoursPerDay7d ?? 0).toFixed(2)}h</div></div>
    <div class="metric"><div class="label">Avg user @ 2h</div><div class="value">${money(cal?.avgUser?.onDemandUsdMonthAt2h ?? 0)}</div></div>
  </div>
  <p class="muted">${esc(cal?.source ?? "")}</p>

  <h2>Screen time</h2>
  <div class="grid">
    <div class="metric"><div class="label">Users w/ totals</div><div class="value">${data.screenTime.usersWithScreenTime}</div></div>
    <div class="metric"><div class="label">7d hours</div><div class="value">${data.screenTime.last7d.activeHours.toFixed(2)}h</div></div>
    <div class="metric"><div class="label">7d users</div><div class="value">${data.screenTime.last7d.distinctUsers}</div></div>
    <div class="metric"><div class="label">30d hours</div><div class="value">${data.screenTime.last30d.activeHours.toFixed(2)}h</div></div>
    <div class="metric"><div class="label">App users</div><div class="value">${data.users.totalUsers}</div></div>
  </div>

  <h2>Daily usage (UTC)</h2>
  <table>
    <thead>
      <tr><th>Day</th><th>Users</th><th>Avg ST</th><th>Total ST</th><th>Sessions</th><th>On-demand</th><th>Total $</th></tr>
    </thead>
    <tbody>${dailyRows || "<tr><td colspan='7'>No daily rows</td></tr>"}</tbody>
  </table>

  <h2>Providers</h2>
  <ul>${providers}</ul>
  ${
    data.vercelUsage?.source === "live"
      ? `<p class="muted">Vercel live · ${data.vercelUsage.periodDays ?? "?"}d window · fixed ${money(data.vercelUsage.fixedUsdMonth)}/mo · on-demand ${money(data.vercelUsage.onDemandUsdMonth)}/mo · period total ${money(data.vercelUsage.totalUsd)}</p>`
      : ""
  }

  <h2>Scale scenarios</h2>
  <table>
    <thead>
      <tr><th>Scenario</th><th>Users</th><th>h/day</th><th>Revenue</th><th>On-demand</th><th>Total cost</th><th>Profit</th></tr>
    </thead>
    <tbody>${scenarios}</tbody>
  </table>
</body>
</html>`;
}

/** Open a print window so the user can Save as PDF. */
export function saveFounderPdf(data: FounderPdfPayload): void {
  if (typeof window === "undefined") return;
  const html = buildHtml(data);
  const w = window.open("", "_blank", "noopener,noreferrer,width=960,height=720");
  if (!w) {
    throw new Error("Popup blocked — allow popups to save PDF.");
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Let layout settle before the print dialog (Save as PDF).
  const run = () => {
    try {
      w.focus();
      w.print();
    } catch {
      /* user can print manually */
    }
  };
  if (w.document.readyState === "complete") {
    setTimeout(run, 250);
  } else {
    w.addEventListener("load", () => setTimeout(run, 250));
  }
}
