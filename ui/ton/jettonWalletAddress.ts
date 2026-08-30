import { Address, beginCell } from "@ton/core";
import { TonClient } from "@ton/ton";

const MAINNET_RPC = "https://toncenter.com/api/v2/jsonRPC";

let client: TonClient | null = null;

function getTonClient(): TonClient {
  if (!client) {
    client = new TonClient({ endpoint: MAINNET_RPC });
  }
  return client;
}

/** Resolve a jetton wallet contract address for an owner via the minter `get_wallet_address`. */
export async function resolveJettonWalletAddress(
  jettonMaster: string,
  ownerAddress: string,
): Promise<string> {
  const minter = Address.parse(jettonMaster);
  const owner = Address.parse(ownerAddress);
  const result = await getTonClient().runMethod(minter, "get_wallet_address", [
    { type: "slice", cell: beginCell().storeAddress(owner).endCell() },
  ]);
  return result.stack.readAddress().toString();
}
