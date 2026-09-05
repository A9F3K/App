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
      // Billing export cold queries can exceed the default ~60s on first pull.
      autoRetry: true,
      maxRetries: 5,
    });
  }
  return new BigQuery({ projectId, autoRetry: true, maxRetries: 5 });
}

const BILLING_TABLE_RE = /^gcp_billing_export(_resource)?_v1_/i;

/** Prefer detailed resource export when both standard + resource tables exist. */
function pickBillingTableId(tableIds: string[]): string | null {
  const matches = tableIds.filter((id) => BILLING_TABLE_RE.test(id));
  if (matches.length === 0) return null;
  const resource = matches.find((id) => /_resource_v1_/i.test(id));
  return resource ?? matches[0] ?? null;
}

async function listDatasetTableIds(bq: BigQuery, datasetId: string): Promise<string[]> {
  const [tables] = await bq.dataset(datasetId).getTables();
  return tables.map((t) => t.id).filter((id): id is string => Boolean(id));
}

async function discoverBillingTable(
  bq: BigQuery,
  projectId: string,
): Promise<{ table: string | null; scannedDatasets: string[]; emptyPreferred: boolean }> {
  const preferredDataset = process.env.GCP_BIGQUERY_BILLING_DATASET?.trim();
  const scannedDatasets: string[] = [];
  let emptyPreferred = false;

  const tryDataset = async (datasetId: string): Promise<string | null> => {
    scannedDatasets.push(datasetId);
    try {
      const ids = await listDatasetTableIds(bq, datasetId);
      if (preferredDataset && datasetId === preferredDataset && ids.length === 0) {
        emptyPreferred = true;
      }
      const pick = pickBillingTableId(ids);
      return pick ? `${projectId}.${datasetId}.${pick}` : null;
    } catch {
      return null;
    }
  };

  if (preferredDataset) {
    const hit = await tryDataset(preferredDataset);
    if (hit) return { table: hit, scannedDatasets, emptyPreferred };
  }

  try {
    const [datasets] = await bq.getDatasets();
    for (const ds of datasets) {
      const datasetId = ds.id;
      if (!datasetId || datasetId === preferredDataset) continue;
      const hit = await tryDataset(datasetId);
      if (hit) return { table: hit, scannedDatasets, emptyPreferred };
    }
  } catch {
    /* list datasets may fail without broader IAM */
  }

  return { table: null, scannedDatasets, emptyPreferred };
}

async function queryDailySpend(
  bq: BigQuery,
  tableFq: string,
  days: number,
  useConversionRate: boolean,
): Promise<GcpBillingDay[]> {
  const ref = parseTableRef(tableFq);
  if (!ref) throw new Error(`Invalid GCP_BIGQUERY_BILLING_TABLE: ${tableFq}`);

  const costExpr = useConversionRate
    ? "IFNULL(cost, 0) * IFNULL(currency_conversion_rate, 1)"
    : "IFNULL(cost, 0)";

  const sql = `
    SELECT
      FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time)) AS day,
      SUM(${costExpr}) AS usd
    FROM \`${ref.projectId}.${ref.datasetId}.${ref.tableId}\`
    WHERE DATE(usage_start_time) >= DATE_SUB(CURRENT_DATE(), INTERVAL @days DAY)
    GROUP BY day
    ORDER BY day
  `;

  const [rows] = await bq.query({
    query: sql,
    params: { days },
    location: process.env.GCP_BIGQUERY_LOCATION?.trim() || undefined,
    // First export pulls / cold jobs can be slow from serverless.
    jobTimeoutMs: 120_000,
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
 * Auto-discovers `gcp_billing_export_v1_*` / `gcp_billing_export_resource_v1_*`.
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
  let emptyPreferred = false;
  let scannedDatasets: string[] = [];
  if (!table) {
    try {
      const discovered = await discoverBillingTable(bq, projectId);
      table = discovered.table || "";
      emptyPreferred = discovered.emptyPreferred;
      scannedDatasets = discovered.scannedDatasets;
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
    const dsHint =
      process.env.GCP_BIGQUERY_BILLING_DATASET?.trim() || "gcp_billing_export";
    if (emptyPreferred) {
      return {
        ok: false,
        detail: `Billing export dataset ${projectId}.${dsHint} is empty — Google usually creates gcp_billing_export_v1_* within ~24h after enabling export. Scanned: ${scannedDatasets.join(", ") || dsHint}.`,
      };
    }
    return {
      ok: false,
      detail:
        "No Cloud Billing → BigQuery export table yet. Enable Standard usage cost export into dataset gcp_billing_export (project hyperlinksspacebot). https://console.cloud.google.com/billing/012A7B-1A56F5-EA0A98/export?project=hyperlinksspacebot",
    };
  }

  try {
    let byDay: GcpBillingDay[];
    try {
      byDay = await queryDailySpend(bq, table, days, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/currency_conversion_rate|Unrecognized name/i.test(msg)) throw err;
      byDay = await queryDailySpend(bq, table, days, false);
    }
    const windowSum = byDay.reduce((a, d) => a + d.usd, 0);
    const usdMonth =
      byDay.length > 0 ? round4(windowSum * (30 / Math.max(1, byDay.length))) : 0;
    return {
      ok: true,
      table,
      byDay,
      usdMonth,
      detail:
        byDay.length > 0
          ? `BigQuery billing export · ${table} · ${byDay.length} days · $${windowSum.toFixed(4)} window`
          : `BigQuery billing export · ${table} · table live but no cost rows in last ${days}d (often $0 / still backfilling)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `BigQuery query failed (${table}): ${msg.slice(0, 240)}`,
    };
  }
}
