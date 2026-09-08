/**
 * Issued Pro payment memos — unique per attempt, bound to the signed-in user.
 * Lets founder recover Pro from a memo when client sync fails after payment.
 */
import { sql } from "./start.js";
import { normalizeUsername } from "./users.js";

export type ProPaymentMemoPlanId = "month" | "quarter" | "year";

export type ProPaymentMemoStatus = "issued" | "activated" | "cancelled";

export type ProPaymentMemoRow = {
  memo: string;
  username: string;
  planId: ProPaymentMemoPlanId;
  priceUsd: number;
  months: number;
  status: ProPaymentMemoStatus;
  createdAt: string;
  activatedAt: string | null;
};

let tableReady: Promise<void> | null = null;

function planMonths(planId: ProPaymentMemoPlanId): number {
  if (planId === "quarter") return 3;
  if (planId === "year") return 12;
  return 1;
}

function normalizePlanId(raw: unknown): ProPaymentMemoPlanId {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "quarter" || s === "year" || s === "month") return s;
  return "month";
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

function asNum(raw: unknown): number {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function mapRow(row: Record<string, unknown> | null | undefined): ProPaymentMemoRow | null {
  if (!row) return null;
  const memo = typeof row.memo === "string" ? row.memo.trim() : "";
  const username = normalizeUsername(row.username);
  if (!memo || !username) return null;
  const statusRaw = String(row.status ?? "issued").toLowerCase();
  const status: ProPaymentMemoStatus =
    statusRaw === "activated" || statusRaw === "cancelled" ? statusRaw : "issued";
  return {
    memo,
    username,
    planId: normalizePlanId(row.plan_id),
    priceUsd: asNum(row.price_usd),
    months: Math.max(1, Math.trunc(asNum(row.months) || 1)),
    status,
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
    activatedAt: asIso(row.activated_at),
  };
}

export async function ensureProPaymentMemosTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS pro_payment_memos (
          memo TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          price_usd DOUBLE PRECISION NOT NULL,
          months INT NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'issued',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          activated_at TIMESTAMPTZ
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS pro_payment_memos_username_created_idx
        ON pro_payment_memos (username, created_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS pro_payment_memos_status_created_idx
        ON pro_payment_memos (status, created_at DESC)
      `;
    })().catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  await tableReady;
}

/** Build HSP2-{plan}-{millicents}-{nonce} and insert until unique. */
export async function issueProPaymentMemo(opts: {
  username: string;
  planId: string;
  priceUsd: number;
}): Promise<ProPaymentMemoRow | null> {
  const username = normalizeUsername(opts.username);
  if (!username) return null;
  const planId = normalizePlanId(opts.planId);
  const priceUsd = Number(opts.priceUsd);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  const months = planMonths(planId);
  const millis = Math.max(1, Math.round(priceUsd * 1000));

  await ensureProPaymentMemosTable();

  for (let attempt = 0; attempt < 8; attempt++) {
    const nonce = Math.random().toString(36).slice(2, 8).toUpperCase();
    const memo = `HSP2-${planId}-${millis}-${nonce}`;
    try {
      const rows = await sql`
        INSERT INTO pro_payment_memos (
          memo, username, plan_id, price_usd, months, status, created_at
        )
        VALUES (
          ${memo},
          ${username},
          ${planId},
          ${priceUsd},
          ${months},
          ${"issued"},
          NOW()
        )
        RETURNING
          memo, username, plan_id, price_usd, months, status, created_at, activated_at
      `;
      return mapRow(rows[0] as Record<string, unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) continue;
      throw err;
    }
  }
  return null;
}

export async function getProPaymentMemo(memo: string): Promise<ProPaymentMemoRow | null> {
  const m = memo.trim();
  if (!m) return null;
  await ensureProPaymentMemosTable();
  const rows = await sql`
    SELECT memo, username, plan_id, price_usd, months, status, created_at, activated_at
    FROM pro_payment_memos
    WHERE memo = ${m}
    LIMIT 1
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

/** Insert a historical / recovery memo if missing (idempotent). */
export async function upsertProPaymentMemo(opts: {
  memo: string;
  username: string;
  planId?: string;
  priceUsd?: number;
  months?: number;
  status?: ProPaymentMemoStatus;
}): Promise<ProPaymentMemoRow | null> {
  const memo = opts.memo.trim();
  const username = normalizeUsername(opts.username);
  if (!memo || !username) return null;
  const planId = normalizePlanId(opts.planId);
  const priceUsd =
    typeof opts.priceUsd === "number" && Number.isFinite(opts.priceUsd) && opts.priceUsd > 0
      ? opts.priceUsd
      : 0;
  const months =
    typeof opts.months === "number" && opts.months > 0
      ? Math.trunc(opts.months)
      : planMonths(planId);
  const status: ProPaymentMemoStatus = opts.status ?? "issued";

  await ensureProPaymentMemosTable();
  const rows = await sql`
    INSERT INTO pro_payment_memos (
      memo, username, plan_id, price_usd, months, status, created_at, activated_at
    )
    VALUES (
      ${memo},
      ${username},
      ${planId},
      ${priceUsd},
      ${months},
      ${status},
      NOW(),
      ${status === "activated" ? new Date().toISOString() : null}
    )
    ON CONFLICT (memo) DO UPDATE SET
      username = EXCLUDED.username,
      plan_id = COALESCE(NULLIF(EXCLUDED.plan_id, ''), pro_payment_memos.plan_id),
      price_usd = CASE
        WHEN EXCLUDED.price_usd > 0 THEN EXCLUDED.price_usd
        ELSE pro_payment_memos.price_usd
      END,
      months = EXCLUDED.months,
      status = CASE
        WHEN pro_payment_memos.status = 'activated' THEN pro_payment_memos.status
        ELSE EXCLUDED.status
      END,
      activated_at = CASE
        WHEN pro_payment_memos.activated_at IS NOT NULL THEN pro_payment_memos.activated_at
        WHEN EXCLUDED.status = 'activated' THEN NOW()
        ELSE NULL
      END
    RETURNING
      memo, username, plan_id, price_usd, months, status, created_at, activated_at
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function markProPaymentMemoActivated(
  memo: string,
): Promise<ProPaymentMemoRow | null> {
  const m = memo.trim();
  if (!m) return null;
  await ensureProPaymentMemosTable();
  const rows = await sql`
    UPDATE pro_payment_memos
    SET
      status = 'activated',
      activated_at = COALESCE(activated_at, NOW())
    WHERE memo = ${m}
    RETURNING
      memo, username, plan_id, price_usd, months, status, created_at, activated_at
  `;
  return mapRow(rows[0] as Record<string, unknown>);
}

export async function listRecentProPaymentMemos(limit = 40): Promise<ProPaymentMemoRow[]> {
  await ensureProPaymentMemosTable();
  const n = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await sql`
    SELECT memo, username, plan_id, price_usd, months, status, created_at, activated_at
    FROM pro_payment_memos
    ORDER BY created_at DESC
    LIMIT ${n}
  `;
  const out: ProPaymentMemoRow[] = [];
  for (const row of rows) {
    const mapped = mapRow(row as Record<string, unknown>);
    if (mapped) out.push(mapped);
  }
  return out;
}
