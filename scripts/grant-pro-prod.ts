/**
 * Grant Pro on production Neon (uses DATABASE_URL_PROD from .env).
 * Usage:
 *   npx tsx scripts/grant-pro-prod.ts --username <user> [months] [priceUsd] [memo]
 *   npx tsx scripts/grant-pro-prod.ts --wallet <UQ...> [months] [priceUsd] [memo]
 */
import dotenv from "dotenv";
import { neon } from "@neondatabase/serverless";

dotenv.config({ path: ".env" });

function normalizeUsername(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

async function main() {
  const url = (process.env.DATABASE_URL_PROD || process.env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("DATABASE_URL_PROD / DATABASE_URL missing");
    process.exit(1);
  }
  const sql = neon(url);

  const args = process.argv.slice(2);
  let mode: "wallet" | "username" | null = null;
  let target = "";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--wallet" || a === "--username") {
      mode = a === "--wallet" ? "wallet" : "username";
      target = args[++i] ?? "";
      continue;
    }
    rest.push(a);
  }
  // Legacy positional wallet
  if (!mode && rest[0] && rest[0].startsWith("UQ")) {
    mode = "wallet";
    target = rest.shift()!;
  }
  if (!mode || !target.trim()) {
    console.error(
      "Usage: npx tsx scripts/grant-pro-prod.ts --username <user> | --wallet <UQ> [months] [priceUsd] [memo]",
    );
    process.exit(1);
  }

  const months = Math.max(1, Math.trunc(Number(rest[0]) || 1));
  const priceUsdRaw = Number(rest[1]);
  const priceUsd = Number.isFinite(priceUsdRaw) && priceUsdRaw >= 0 ? priceUsdRaw : 5;
  const memo = String(rest[2] ?? "").trim();

  console.log("db_host", new URL(url).hostname);

  let usernames: string[] = [];
  if (mode === "username") {
    usernames = [normalizeUsername(target)];
  } else {
    const rows = (await sql`
      SELECT DISTINCT telegram_username
      FROM wallets
      WHERE lower(wallet_address) = lower(${target.trim()})
      ORDER BY telegram_username ASC
      LIMIT 50
    `) as Array<{ telegram_username?: unknown }>;
    usernames = rows.map((r) => normalizeUsername(r.telegram_username)).filter(Boolean);
  }

  console.log("usernames", usernames);
  if (usernames.length === 0) {
    console.error("no users found");
    process.exit(2);
  }

  const expires = new Date();
  expires.setMonth(expires.getMonth() + months);
  const expiresAt = expires.toISOString();

  for (const username of usernames) {
    await sql`
      INSERT INTO user_ai_free_quota (username, tokens_used, pro_expires_at, updated_at)
      VALUES (${username}, 0, ${expiresAt}, NOW())
      ON CONFLICT (username) DO UPDATE SET
        pro_expires_at = EXCLUDED.pro_expires_at,
        updated_at = NOW()
    `;
    await sql`
      INSERT INTO pro_sales (username, plan_id, price_usd, months, expires_at, created_at)
      VALUES (${username}, ${"month"}, ${priceUsd}, ${months}, ${expiresAt}, NOW())
    `;
    console.log(
      JSON.stringify({
        ok: true,
        username,
        expiresAt,
        months,
        priceUsd,
        memo: memo || null,
      }),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
