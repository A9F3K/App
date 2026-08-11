import { waitForRouteResults } from "@swap-coffee/sdk";

import {
  buildSwapRouteQuote,
  swapCoffeeRoutingApi,
  toApiTokenAddress,
} from "../../ui/swap/swapCoffeeRouting";
import type { SwapPairToken } from "../../ui/swap/swapPairTypes";
import {
  sendSwapCoffeeTransactions,
  type SwapCoffeeTxMessage,
} from "../wallet/tonSwapSend";

export type ExecuteSwapParams = {
  fromToken: SwapPairToken;
  toToken: SwapPairToken;
  fromAmount: string;
  slippage?: number;
  senderAddress: string;
  mnemonic: string[];
  tonRpcUrl: string;
  tonRpcKey?: string;
};

export type ExecuteSwapResult = {
  success: boolean;
  routeId?: string;
  error?: string;
  routeStatus?: string;
};

/**
 * Mirror of whatswap `swap-service.ts` without TonConnect:
 * buildRoute → buildTransactionsV2 → V4 sendTransfer → waitForRouteResults.
 */
export async function executeSwap(params: ExecuteSwapParams): Promise<ExecuteSwapResult> {
  try {
    const inputAmount = Number(String(params.fromAmount).replace(",", ".").trim());
    if (!(inputAmount > 0) || !Number.isFinite(inputAmount)) {
      return { success: false, error: "invalid_amount" };
    }
    if (!params.senderAddress.trim()) {
      return { success: false, error: "wallet_required" };
    }
    if (!params.mnemonic.length) {
      return { success: false, error: "wallet_locked" };
    }

    const route = await buildSwapRouteQuote({
      sellToken: params.fromToken,
      buyToken: params.toToken,
      amount: inputAmount,
      direction: "exact_in",
    });

    const transactions = await swapCoffeeRoutingApi.buildTransactionsV2({
      sender_address: params.senderAddress.trim(),
      slippage: params.slippage ?? 0.05,
      paths: route.paths as never,
    });

    const data = transactions.data as {
      route_id?: string;
      transactions?: SwapCoffeeTxMessage[];
    } | null;

    if (!data?.transactions?.length) {
      return { success: false, error: "failed_to_build_transactions" };
    }

    await sendSwapCoffeeTransactions({
      mnemonic: params.mnemonic,
      transactions: data.transactions,
      endpoint: params.tonRpcUrl,
      apiKey: params.tonRpcKey,
    });

    let routeStatus: string | undefined;
    if (data.route_id) {
      const results = await waitForRouteResults(data.route_id, swapCoffeeRoutingApi);
      routeStatus =
        results && typeof results === "object" && "status" in results
          ? String((results as { status?: unknown }).status ?? "")
          : undefined;
    }

    return {
      success: true,
      routeId: data.route_id,
      routeStatus,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "swap_failed",
    };
  }
}

/** Server-side: build txs only (signing happens after envelope unwrap). */
export async function buildSwapCoffeeTransactionsForSender(opts: {
  fromToken: SwapPairToken;
  toToken: SwapPairToken;
  fromAmount: string;
  senderAddress: string;
  slippage?: number;
}): Promise<{
  routeId: string;
  transactions: SwapCoffeeTxMessage[];
  inputAmount: number;
  outputAmount: number;
}> {
  const inputAmount = Number(String(opts.fromAmount).replace(",", ".").trim());
  if (!(inputAmount > 0) || !Number.isFinite(inputAmount)) {
    throw new Error("invalid_amount");
  }

  const quote = await buildSwapRouteQuote({
    sellToken: opts.fromToken,
    buyToken: opts.toToken,
    amount: inputAmount,
    direction: "exact_in",
  });

  // Keep RoutingApi aware of token shapes used by waiters / debug.
  void toApiTokenAddress;

  const transactions = await swapCoffeeRoutingApi.buildTransactionsV2({
    sender_address: opts.senderAddress.trim(),
    slippage: opts.slippage ?? 0.05,
    paths: quote.paths as never,
  });

  const data = transactions.data as {
    route_id?: string;
    transactions?: SwapCoffeeTxMessage[];
  } | null;

  if (!data?.route_id || !data.transactions?.length) {
    throw new Error("failed_to_build_transactions");
  }

  return {
    routeId: data.route_id,
    transactions: data.transactions,
    inputAmount: quote.inputAmount,
    outputAmount: quote.outputAmount,
  };
}
