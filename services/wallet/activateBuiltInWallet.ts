import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, internal, toNano, TonClient, WalletContractV4 } from "@ton/ton";
import { Buffer as BufferPolyfill } from "buffer";

if (typeof globalThis !== "undefined" && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = BufferPolyfill;
}

const TONAPI_BASE = "https://tonapi.io/v2";
/** Keep a little headroom above self-transfer + deploy gas. */
export const WALLET_ACTIVATE_MIN_BALANCE_NANO = 5_000_000n; // 0.005 TON
const SELF_TRANSFER_AMOUNT = toNano("0.001");

export type WalletChainStatus = {
  status: string;
  balanceNano: bigint;
  address: string;
};

function tonapiHeaders(): HeadersInit {
  const token = (process.env.TONAPI_KEY || process.env.EXPO_PUBLIC_TONAPI_KEY || "").trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchWalletChainStatus(address: string): Promise<WalletChainStatus> {
  const trimmed = address.trim();
  const res = await fetch(`${TONAPI_BASE}/accounts/${encodeURIComponent(trimmed)}`, {
    headers: tonapiHeaders(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`tonapi_account_${res.status}:${text.slice(0, 120)}`);
  }
  const data = (await res.json()) as {
    address?: string;
    balance?: number | string;
    status?: string;
  };
  let balanceNano = 0n;
  try {
    balanceNano = BigInt(String(data.balance ?? 0));
  } catch {
    balanceNano = 0n;
  }
  return {
    status: String(data.status ?? "unknown"),
    balanceNano,
    address: data.address ?? trimmed,
  };
}

function getTonRpcClient(): TonClient {
  const endpoint =
    process.env.TONCENTER_RPC_URL?.trim() ||
    process.env.TON_RPC_URL?.trim() ||
    "https://toncenter.com/api/v2/jsonRPC";
  const apiKey =
    process.env.TONCENTER_API_KEY?.trim() ||
    process.env.TONCENTER_MAINNET_API_KEY?.trim() ||
    undefined;
  return new TonClient({ endpoint, apiKey });
}

export type ActivateBuiltInWalletResult =
  | { ok: true; alreadyActive: true; status: string; balanceNano: string }
  | {
      ok: true;
      alreadyActive: false;
      statusBefore: string;
      balanceNano: string;
      seqno: number;
    }
  | { ok: false; error: string; status?: string; balanceNano?: string };

/**
 * Deploy Wallet V4 on-chain when the account has funds but is not yet `active`.
 * Gas is paid from the wallet's own balance (tiny self-transfer + deploy fees).
 */
export async function activateBuiltInWallet(opts: {
  mnemonic: string[];
  expectedAddress?: string | null;
}): Promise<ActivateBuiltInWalletResult> {
  if (!opts.mnemonic.length) {
    return { ok: false, error: "missing_mnemonic" };
  }

  const keyPair = await mnemonicToPrivateKey(opts.mnemonic);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const friendly = wallet.address.toString({ urlSafe: true, bounceable: false });

  if (opts.expectedAddress?.trim()) {
    try {
      const expected = Address.parse(opts.expectedAddress.trim());
      if (!expected.equals(wallet.address)) {
        return { ok: false, error: "address_mismatch" };
      }
    } catch {
      return { ok: false, error: "invalid_expected_address" };
    }
  }

  const chain = await fetchWalletChainStatus(friendly);
  const status = chain.status.toLowerCase();

  if (status === "active") {
    return {
      ok: true,
      alreadyActive: true,
      status: chain.status,
      balanceNano: chain.balanceNano.toString(),
    };
  }

  if (chain.balanceNano < WALLET_ACTIVATE_MIN_BALANCE_NANO) {
    return {
      ok: false,
      error: "insufficient_balance_for_deploy",
      status: chain.status,
      balanceNano: chain.balanceNano.toString(),
    };
  }

  const client = getTonRpcClient();
  const contract = client.open(wallet);
  const seqno = await contract.getSeqno();

  // First outgoing transfer includes state_init when the contract is not deployed yet.
  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: wallet.address,
        value: SELF_TRANSFER_AMOUNT,
        bounce: false,
      }),
    ],
  });

  return {
    ok: true,
    alreadyActive: false,
    statusBefore: chain.status,
    balanceNano: chain.balanceNano.toString(),
    seqno,
  };
}
