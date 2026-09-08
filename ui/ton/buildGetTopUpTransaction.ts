import { Address, beginCell, toNano } from "@ton/core";

import { isNativeTonToken, type SwapPairToken } from "../swap/swapPairTypes";
import { resolveJettonWalletAddress } from "./jettonWalletAddress";
import { parseTokenAmountToUnits } from "./parseTokenAmount";

export type TonConnectTransactionRequest = {
  validUntil: number;
  network: string;
  messages: Array<{
    address: string;
    amount: string;
    payload?: string;
  }>;
};

const TONCONNECT_MAINNET = "-239";
const JETTON_TRANSFER_OP = 0x0f8a7ea5;

function buildTextCommentCell(comment: string) {
  return beginCell().storeUint(0, 32).storeStringTail(comment).endCell();
}

function buildJettonTransferBody(params: {
  toOwner: Address;
  amount: bigint;
  responseOwner: Address;
  forwardTonAmount?: bigint;
  queryId?: bigint;
  /** On-chain memo (jetton forward comment) for payment matching. */
  comment?: string;
}) {
  const builder = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(params.queryId ?? 0n, 64)
    .storeCoins(params.amount)
    .storeAddress(params.toOwner)
    .storeAddress(params.responseOwner)
    .storeBit(0)
    .storeCoins(params.forwardTonAmount ?? toNano("0.05"));

  const comment = params.comment?.trim() ?? "";
  if (comment) {
    // either_forward_payload as a reference cell (text comment op 0).
    builder.storeBit(1).storeRef(buildTextCommentCell(comment));
  } else {
    builder.storeBit(0);
  }
  return builder.endCell();
}

/** Build a TonConnect request that tops up the app built-in wallet from a connected external wallet. */
export async function buildGetTopUpTransaction(opts: {
  amount: string;
  token: SwapPairToken;
  fromWalletAddress: string;
  toBuiltInWalletAddress: string;
  /** Optional on-chain memo / comment (used for Pro USDT payment verification). */
  comment?: string;
}): Promise<TonConnectTransactionRequest> {
  const deposit = opts.toBuiltInWalletAddress.trim();
  const from = opts.fromWalletAddress.trim();
  if (!deposit || !from) {
    throw new Error("missing_wallet_address");
  }

  const units = parseTokenAmountToUnits(opts.amount, opts.token.decimals);
  if (units == null) {
    throw new Error("invalid_amount");
  }

  const depositAddr = Address.parse(deposit);
  const fromAddr = Address.parse(from);
  const validUntil = Math.floor(Date.now() / 1000) + 300;
  const comment = opts.comment?.trim() ?? "";

  if (isNativeTonToken(opts.token)) {
    // Non-bounceable: first native top-up must land on an uninitialized built-in
    // wallet. Bounceable EQ… transfers reverse when status is still `nonexist`.
    return {
      validUntil,
      network: TONCONNECT_MAINNET,
      messages: [
        {
          address: depositAddr.toString({ urlSafe: true, bounceable: false }),
          amount: units.toString(),
          ...(comment
            ? { payload: buildTextCommentCell(comment).toBoc().toString("base64") }
            : null),
        },
      ],
    };
  }

  const jettonMaster = opts.token.address.trim();
  if (!jettonMaster) {
    throw new Error("missing_jetton_address");
  }

  const senderJettonWallet = await resolveJettonWalletAddress(jettonMaster, from);
  const body = buildJettonTransferBody({
    toOwner: depositAddr,
    amount: units,
    responseOwner: fromAddr,
    comment: comment || undefined,
  });

  return {
    validUntil,
    network: TONCONNECT_MAINNET,
    messages: [
      {
        address: senderJettonWallet,
        amount: toNano("0.08").toString(),
        payload: body.toBoc().toString("base64"),
      },
    ],
  };
}
