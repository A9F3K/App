import { jettonImpersonatesKnownBrand } from "../jettonImpersonatesKnownBrand";
import type { SwapJetton } from "../swapJettonsTypes";

function jetton(partial: Partial<SwapJetton>): SwapJetton {
  return {
    address: partial.address ?? "0:test",
    decimals: partial.decimals ?? 9,
    symbol: partial.symbol ?? "TEST",
    name: partial.name ?? "Test",
    verification: partial.verification ?? "UNKNOWN",
    market_stats: partial.market_stats,
  };
}

describe("jettonImpersonatesKnownBrand", () => {
  it("flags preOPENAI / OPENAI lookalikes", () => {
    expect(
      jettonImpersonatesKnownBrand(
        jetton({ symbol: "OPENAI", name: "preOPENAI", verification: "UNKNOWN" }),
      ),
    ).toBe(true);
  });

  it("ignores whitelisted rows", () => {
    expect(
      jettonImpersonatesKnownBrand(
        jetton({ symbol: "OPENAI", name: "preOPENAI", verification: "WHITELISTED" }),
      ),
    ).toBe(false);
  });

  it("leaves ordinary tickers alone", () => {
    expect(
      jettonImpersonatesKnownBrand(
        jetton({ symbol: "NOT", name: "Not a brand", verification: "UNKNOWN" }),
      ),
    ).toBe(false);
  });
});
