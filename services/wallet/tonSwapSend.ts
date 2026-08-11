import { Address, Cell, beginCell } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { Buffer as BufferPolyfill } from "buffer";

if (typeof globalThis !== "undefined" && !(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = BufferPolyfill;
}

export type SwapCoffeeTxMessage = {
  address: string;
  value: string;
  cell?: string | null;
  payload?: string | null;
  state_init?: string | null;
  stateInit?: string | null;
};

function parseBocBase64(boc: string): Cell {
  const bytes = BufferPolyfill.from(boc, "base64");
  return Cell.fromBoc(bytes)[0]!;
}

function parseOptionalStateInit(raw: string | null | undefined):
  | { code?: Cell; data?: Cell }
  | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const cell = parseBocBase64(raw.trim());
    const slice = cell.beginParse();
    if (slice.remainingRefs >= 2) {
      return { code: slice.loadRef(), data: slice.loadRef() };
    }
  } catch {
    // Fall through — some SDKs send empty / unused stateInit.
  }
  return undefined;
}

/**
 * Sign + broadcast Swap.Coffee `buildTransactionsV2` messages with WalletContractV4
 * (whatswap uses TonConnect; HSP uses the built-in wallet).
 */
export async function sendSwapCoffeeTransactions(opts: {
  mnemonic: string[];
  transactions: readonly SwapCoffeeTxMessage[];
  endpoint: string;
  apiKey?: string;
}): Promise<{ seqno: number }> {
  if (!opts.mnemonic.length) {
    throw new Error("missing_mnemonic");
  }
  if (!opts.transactions.length) {
    throw new Error("no_transactions");
  }
  if (opts.transactions.length > 4) {
    throw new Error("too_many_messages_for_v4");
  }

  const keyPair = await mnemonicToPrivateKey(opts.mnemonic);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const client = new TonClient({
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
  });
  const contract = client.open(wallet);
  const seqno = await contract.getSeqno();

  const messages = opts.transactions.map((tx) => {
    const bodyRaw = (tx.cell ?? tx.payload ?? "").trim();
    const body = bodyRaw ? parseBocBase64(bodyRaw) : beginCell().endCell();
    const init = parseOptionalStateInit(tx.state_init ?? tx.stateInit);
    return internal({
      to: Address.parse(tx.address),
      value: BigInt(tx.value),
      body,
      bounce: true,
      ...(init ? { init } : {}),
    });
  });

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages,
  });

  return { seqno };
}
