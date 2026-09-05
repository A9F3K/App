/**
 * Live GCP daily spend via Cloud Billing export → BigQuery.
 * Falls back callers use FOUNDER_COST_GCP_* env when this returns null/errors.
 */
import { BigQuery } from "@google-cloud/bigquery";
import { parseGcpServiceAccountJson } from "./envelope-env.js";

export type GcpBillingDay = { day: string; usd: number };

export type GcpBigQueryResult =
  | {
      ok: true;
      table: string;
      byDay: GcpBillingDay[];
      usdMonth: number;
      detail: string;
    }
  | { ok: false; detail: string };

type SaCreds = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
  [key: string]: unknown;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseTableRef(table: string): { projectId: string; datasetId: string; tableId: string } | null {
  const parts = table.split(".").map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const [projectId, datasetId, tableId] = parts as [string, string, string];
  if (!projectId || !datasetId || !tableId) return null;
  return { projectId, datasetId, tableId };
}

function loadCredentials(): { credentials: SaCreds; projectId: string } | { error: string } {
  const parsed = parseGcpServiceAccountJson();
  if (parsed.ok) {
    const credentials = parsed.credentials as SaCreds;
    const projectId =
      process.env.GCP_BILLING_PROJECT_ID?.trim() ||
      (typeof credentials.project_id === "string" ? credentials.project_id : "") ||
      "";
    if (!projectId) {
      return { error: "GCP SA JSON missing project_id (set GCP_BILLING_PROJECT_ID)." };
    }
    return { credentials, projectId };
  }

  // Local / ADC: let BigQuery client pick up GOOGLE_APPLICATION_CREDENTIALS or key file.
  const projectId =
    process.env.GCP_BILLING_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    "";
  if (!projectId && parsed.error === "missing") {
    return {
      error:
        "GCP_SERVICE_ACCOUNT_JSON unset — upload SA with BigQuery Data Viewer on the billing export dataset.",
    };
  }
  if (parsed.error !== "missing") {
    return { error: parsed.message };
  }
  if (!projectId) {
    return { error: "Set GCP_BILLING_PROJECT_ID (or project_id in SA) for BigQuery billing." };
  }
  return { credentials: {}, projectId };
}

function makeClient(projectId: string, credentials: SaCreds): BigQuery {
  if (credentials.client_email && credentials.private_key) {
    return new BigQuery({
      projectId,
      credentials: {
        client_email: String(credentials.client_email),
        private_key: String(credentials.private_key),
        ...(credentials.project_id ? { project_id: String(credentials.project_id) } : {}),
      },
    });
  }
  return new BigQuery({ projectId });
}

const BILLING_TABLE_RE = /^gcp_billing_export(_resource)?_v1_/i;

async function discoverBillingTable(
  bq: BigQuery,
  projectId: string,
): Promise<string | null> {
  const preferredDataset = process.env.GCP_BIGQUERY_BILLING_DATASET?.trim();
  const datasets = preferredDataset
    ? [{ id: preferredDataset }]
    : await bq.getDatasets().then(([ds]) => ds);

  for (const ds of datasets) {
    const datasetId = ds.id || preferredDataset;
    if (!datasetId) continue;
    try {
      const [tables] = await bq.dataset(datasetId).getTables();
      const match = tables.find((t) => t.id && BILLING_TABLE_RE.test(t.id));
      if (match?.id) {
        return `${projectId}.${datasetId}.${match.id}`;
      }
    } catch {
      /* no access / empty */
    }
  }
  return null;
}

async function queryDailySpend(
  bq: BigQuery,
  tableFq: string,
  days: number,
): Promise<GcpBillingDay[]> {
  const ref = parseTableRef(tableFq);
  if (!ref) throw new Error(`Invalid GCP_BIGQUERY_BILLING_TABLE: ${tableFq}`);

  // Standard Cloud Billing export schema (cost + usage_start_time).
  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day,
      SUM(cost) AS usd
    FROM \`${ref.projectId}.${ref.datasetId}.${ref.tableId}\`
    WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
    GROUP BY day
    ORDER BY day
  `;

  const [rows] = await bq.query({
    query: sql,
    params: { days },
    location: process.env.GCP_BIGQUERY_LOCATION?.trim() || undefined,
  });

  return (rows as Array<{ day?: string; usd?: number | string }>)
    .map((r) => ({
      day: String(r.day ?? ""),
      usd: round4(Number(r.usd ?? 0)),
    }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day));
}

/**
 * Query billing export for the last `periodDays` (capped 1–90).
 * Auto-discovers `gcp_billing_export_v1_*` when table env is unset.
 */
export async function fetchGcpBillingFromBigQuery(
  periodDays = 14,
): Promise<GcpBigQueryResult> {
  const days = Math.max(1, Math.min(90, Math.round(periodDays)));
  const loaded = loadCredentials();
  if ("error" in loaded) {
    return { ok: false, detail: loaded.error };
  }

  const { credentials, projectId } = loaded;
  const bq = makeClient(projectId, credentials);

  let table = process.env.GCP_BIGQUERY_BILLING_TABLE?.trim() || "";
  if (!table) {
    try {
      table = (await discoverBillingTable(bq, projectId)) || "";
    } catch (err) {
      return {
        ok: false,
        detail:
          err instanceof Error
            ? `BigQuery discover failed: ${err.message}`
            : "BigQuery discover failed",
      };
    }
  }

  if (!table) {
    return {
      ok: false,
      detail:
        "No Cloud Billing → BigQuery export table yet. One-time Console step: Billing → Billing export → enable Standard usage cost into dataset gcp_billing_export (project hyperlinksspacebot). Data appears within ~24h. https://console.cloud.google.com/billing/012A7B-1A56F5-EA0A98/export?project=hyperlinksspacebot",
    };
  }

  try {
    const byDay = await queryDailySpend(bq, table, days);
    const windowSum = byDay.reduce((a, d) => a + d.usd, 0);
    const usdMonth =
      byDay.length > 0 ? round4(windowSum * (30 / Math.max(1, byDay.length))) : 0;
    return {
      ok: true,
      table,
      byDay,
      usdMonth,
      detail: `BigQuery billing export · ${table} · ${byDay.length} days`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `BigQuery query failed (${table}): ${msg.slice(0, 240)}`,
    };
  }
}
