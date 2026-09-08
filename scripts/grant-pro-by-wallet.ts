/**
 * One-shot / ops: grant Pro by registration wallet address.
 * Usage:
 *   npx tsx scripts/grant-pro-by-wallet.ts <wallet> [months] [priceUsd] [memo]
 */
import {
  findUsernamesByWalletAddress,
} from "../database/wallets.js";
import { syncAiFreeQuotaPro } from "../database/aiFreeQuota.js";
import { recordProSale } from "../database/proSales.js";

async function main() {
  const wallet = (process.argv[2] ?? "").trim();
  const months = Math.max(1, Math.trunc(Number(process.argv[3]) || 1));
  const priceUsd = Number(process.argv[4]);
  const memo = (process.argv[5] ?? "").trim();
  if (!wallet) {
    console.error("Usage: npx tsx scripts/grant-pro-by-wallet.ts <wallet> [months] [priceUsd] [memo]");
    process.exit(1);
  }
  const usernames = await findUsernamesByWalletAddress(wallet);
  if (usernames.length === 0) {
    console.error("wallet_not_found", wallet);
    process.exit(2);
  }
  const expires = new Date();
  expires.setMonth(expires.getMonth() + months);
  const expiresAt = expires.toISOString();
  const price = Number.isFinite(priceUsd) && priceUsd >= 0 ? priceUsd : 5;
  for (const username of usernames) {
    await syncAiFreeQuotaPro({ username, expiresAt });
    await recordProSale({
      username,
      planId: "month",
      priceUsd: price,
      months,
      expiresAt,
    });
    console.log(
      JSON.stringify({
        ok: true,
        username,
        expiresAt,
        months,
        priceUsd: price,
        memo: memo || null,
      }),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
