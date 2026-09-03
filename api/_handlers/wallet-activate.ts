/**
 * POST /api/wallet-activate
 * After the built-in wallet has on-chain balance but is still uninit/nonexist,
 * deploy Wallet V4 via a tiny self-transfer (gas paid from wallet balance).
 */
import {
  deleteSession,
  getSessionByHash,
  touchSession,
} from "../../database/telegramAuth.js";
import { getDefaultWalletByUsername } from "../../database/wallets.js";
import { upsertUserFromTma } from "../../database/users.js";
import { activateBuiltInWallet } from "../../services/wallet/activateBuiltInWallet.js";
import { authByInitData } from "../wallet/_auth.js";
import { getSessionTokenFromRequest } from "../_lib/session-auth.js";
import { sha256Hex } from "../_lib/telegram-oidc.js";
import { unwrapMnemonicFromWalletRow } from "../_lib/unwrapWalletMnemonic.js";
import { appLog } from "../../shared/appLog.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const LOG_TAG = "[api/wallet-activate]";

type NodeRes = {
  setHeader(name: string, value: string): void;
  status(code: number): void;
  end(body?: string): void;
};

function sendJson(res: NodeRes | undefined, body: object, status: number): Response | void {
  const json = JSON.stringify(body);
  if (res) {
    res.setHeader("Content-Type", "application/json");
    res.status(status);
    res.end(json);
    return;
  }
  return new Response(json, { status, headers: JSON_HEADERS });
}

async function resolveUsername(
  request: Request,
  postBody?: { initData?: unknown },
): Promise<string | null> {
  const sessionToken = getSessionTokenFromRequest(request);
  if (sessionToken) {
    const hash = sha256Hex(sessionToken);
    const row = await getSessionByHash(hash);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      await deleteSession(hash);
      return null;
    }
    await touchSession(hash);
    return row.telegram_username;
  }

  const initData = typeof postBody?.initData === "string" ? postBody.initData.trim() : "";
  if (!initData) return null;
  const auth = authByInitData(initData);
  await upsertUserFromTma({
    telegramUsername: auth.telegramUsername,
    locale: auth.locale,
    displayName: auth.displayName,
    pictureUrl: auth.pictureUrl,
    authProvider: "telegram",
    loginSubject: auth.telegramUserId ?? auth.telegramUsername,
    telegramUsernameActual: auth.telegramUsername,
    providerUsername: auth.telegramUsername,
    telegramUserId: auth.telegramUserId,
  });
  return auth.telegramUsername;
}

async function handler(request: Request, res?: NodeRes): Promise<Response | void> {
  const method = (request as { method?: string }).method ?? "GET";
  if (method !== "POST") {
    return sendJson(res, { ok: false, error: "method_not_allowed" }, 405);
  }

  let postBody: { initData?: unknown } = {};
  try {
    postBody = (await request.json()) as { initData?: unknown };
  } catch {
    postBody = {};
  }

  try {
    const username = await resolveUsername(request, postBody);
    if (!username) {
      return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    }

    const wallet = await getDefaultWalletByUsername(username);
    if (!wallet) {
      return sendJson(res, { ok: false, error: "no_wallet_row" }, 404);
    }

    const mnemonic = await unwrapMnemonicFromWalletRow(wallet);
    const result = await activateBuiltInWallet({
      mnemonic,
      expectedAddress: wallet.wallet_address,
    });

    appLog(LOG_TAG, result.ok ? "activate_result" : "activate_failed", {
      usernamePrefix: `${username.slice(0, 3)}***`,
      walletId: wallet.id,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      alreadyActive: result.ok ? result.alreadyActive : undefined,
      status: result.ok
        ? result.alreadyActive
          ? result.status
          : result.statusBefore
        : result.status,
    });

    if (!result.ok) {
      const status =
        result.error === "insufficient_balance_for_deploy"
          ? 409
          : result.error === "address_mismatch"
            ? 422
            : 400;
      return sendJson(res, result, status);
    }

    return sendJson(res, result, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "internal_error";
    appLog(LOG_TAG, "handler_error", { error: msg });
    const status =
      msg === "bot_token_not_configured"
        ? 500
        : msg === "invalid_initdata" || msg === "username_required"
          ? 401
          : msg === "wallet_row_missing_envelope"
            ? 422
            : 500;
    return sendJson(res, { ok: false, error: msg }, status);
  }
}

export default handler;
export const GET = handler;
export const POST = handler;
