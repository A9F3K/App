/**
 * Backfill a known payment memo → user binding on prod.
 * Usage: npx tsx scripts/backfill-pro-memo.ts <memo> <username> [priceUsd] [planId] [status]
 */
import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: ".env" });

async function main() {
  const url = (process.env.DATABASE_URL_PROD || process.env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("DATABASE_URL_PROD missing");
    process.exit(1);
  }
  const sql = neon(url);
  const memo = (process.argv[2] ?? "").trim();
  const username = (process.argv[3] ?? "").trim().toLowerCase();
  const priceUsd = Number(process.argv[4] ?? 5);
  const planId = (process.argv[5] ?? "month").trim().toLowerCase();
  const status = (process.argv[6] ?? "activated").trim().toLowerCase();
  if (!memo || !username) {
    console.error("Usage: npx tsx scripts/backfill-pro-memo.ts <memo> <username> [price] [plan] [status]");
    process.exit(1);
  }
  const months = planId === "year" ? 12 : planId === "quarter" ? 3 : 1;

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
    INSERT INTO pro_payment_memos (
      memo, username, plan_id, price_usd, months, status, created_at, activated_at
    )
    VALUES (
      ${memo},
      ${username},
      ${planId},
      ${Number.isFinite(priceUsd) ? priceUsd : 0},
      ${months},
      ${status},
      NOW(),
      ${status === "activated" ? new Date().toISOString() : null}
    )
    ON CONFLICT (memo) DO UPDATE SET
      username = EXCLUDED.username,
      plan_id = EXCLUDED.plan_id,
      price_usd = EXCLUDED.price_usd,
      months = EXCLUDED.months,
      status = EXCLUDED.status,
      activated_at = COALESCE(pro_payment_memos.activated_at, EXCLUDED.activated_at)
  `;
  const rows = await sql`
    SELECT * FROM pro_payment_memos WHERE memo = ${memo} LIMIT 1
  `;
  console.log(JSON.stringify(rows[0], null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
