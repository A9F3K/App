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

function buildJettonTransferBody(params: {
  toOwner: Address;
  amount: bigint;
  responseOwner: Address;
  forwardTonAmount?: bigint;
  queryId?: bigint;
}) {
  return beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(params.queryId ?? 0n, 64)
    .storeCoins(params.amount)
    .storeAddress(params.toOwner)
    .storeAddress(params.responseOwner)
    .storeBit(0)
    .storeCoins(params.forwardTonAmount ?? toNano("0.001"))
    .storeBit(0)
    .endCell();
}

/** Build a TonConnect request that tops up the app built-in wallet from a connected external wallet. */
export async function buildGetTopUpTransaction(opts: {
  amount: string;
  token: SwapPairToken;
  fromWalletAddress: string;
  toBuiltInWalletAddress: string;
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

  if (isNativeTonToken(opts.token)) {
    return {
      validUntil,
      network: TONCONNECT_MAINNET,
      messages: [
        {
          address: depositAddr.toString(),
          amount: units.toString(),
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
  });

  return {
    validUntil,
    network: TONCONNECT_MAINNET,
    messages: [
      {
        address: senderJettonWallet,
        amount: toNano("0.05").toString(),
        payload: body.toBoc().toString("base64"),
      },
    ],
  };
}
