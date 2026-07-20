/**
 * Mint an `hs_auth_session` cookie token against production Neon for Playwright tests.
 *
 * Usage:
 *   MINT_SESSION_USERNAME=your_telegram_username npx tsx scripts/mint-prod-session.ts
 *
 * Writes `mint-session-out.json` with `{ token, telegram_username }`.
 * Loads DATABASE_URL_PROD from `.env` / `.env.local` (see scripts/load-env.ts).
 */
import { writeFileSync } from "node:fs";
import { loadEnv } from "./load-env.js";

async function main(): Promise<void> {
  loadEnv();
  const prodUrl = process.env.DATABASE_URL_PROD?.trim();
  if (prodUrl) {
    process.env.DATABASE_URL = prodUrl;
  }
  const telegramUsername =
    process.env.MINT_SESSION_USERNAME?.trim() ||
    process.argv[2]?.trim() ||
    "";
  if (!telegramUsername) {
    console.error(
      "Set MINT_SESSION_USERNAME or pass telegram username as first arg.",
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL_PROD or DATABASE_URL is not set.");
    process.exitCode = 1;
    return;
  }

  const { issueAuthSession } = await import("../api/_lib/auth-session-issue.js");
  const { sessionToken } = await issueAuthSession({
    telegramUsername,
    secure: true,
    ip: "127.0.0.1",
    userAgent: "mint-prod-session",
  });

  const out = {
    token: sessionToken,
    telegram_username: telegramUsername,
  };
  writeFileSync("mint-session-out.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ok: true, telegram_username: telegramUsername }));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
