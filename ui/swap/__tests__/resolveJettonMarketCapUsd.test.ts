import { resolveJettonMarketCapUsd } from "../resolveJettonMarketCapUsd";
import type { SwapJetton } from "../swapJettonsTypes";

function jetton(partial: Partial<SwapJetton> & { market_stats?: SwapJetton["market_stats"] }): SwapJetton {
  return {
    address: partial.address ?? "0:test",
    decimals: partial.decimals ?? 9,
    symbol: partial.symbol ?? "TEST",
    name: partial.name ?? "Test",
    verification: partial.verification ?? "UNKNOWN",
    market_stats: partial.market_stats,
  };
}

describe("resolveJettonMarketCapUsd", () => {
  it("rejects GAZZA-style $1.5B fantasy (root-cause regression)", () => {
    const raw = resolveJettonMarketCapUsd(
      jetton({
        symbol: "GAZZA",
        name: "Gazza coin",
        verification: "UNKNOWN",
        market_stats: {
          price_usd: 0.0000144336,
          mcap: 1_475_100_030,
          fdmc: 1_475_100_030,
          tvl_usd: 3962.06,
          volume_usd_24h: 0,
        },
      }),
    );
    expect(raw).toBeNull();
  });

  it("allows small caps with thin liquidity", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "COMMUNITY",
          market_stats: { mcap: 50_000, tvl_usd: 10 },
        }),
      ),
    ).toBe(50_000);
  });

  it("rejects large caps with almost no TVL", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "UNKNOWN",
          market_stats: { mcap: 5_000_000, tvl_usd: 20 },
        }),
      ),
    ).toBeNull();
  });

  it("passes whitelisted majors unchanged", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "WHITELISTED",
          market_stats: { mcap: 2_000_000_000_000, tvl_usd: 1 },
        }),
      ),
    ).toBe(2_000_000_000_000);
  });

  it("rejects thin BTC-wrap style trillion caps on UNKNOWN", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          symbol: "BTC",
          verification: "UNKNOWN",
          market_stats: {
            price_usd: 41967,
            mcap: 2_098_367_300_000,
            fdmc: 2_098_367_300_000,
            tvl_usd: 4_196_730,
          },
        }),
      ),
    ).toBeNull();
  });

  it("rejects dead-volume eight-figure claims on thin pools", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "UNKNOWN",
          market_stats: {
            mcap: 25_000_000,
            fdmc: 25_000_000,
            tvl_usd: 8_000,
            volume_usd_24h: 0,
          },
        }),
      ),
    ).toBeNull();
  });
});
