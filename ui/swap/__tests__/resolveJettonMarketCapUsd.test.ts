import {
  jettonFailsVolumeToMcapFilter,
  rankJettonMarketCapUsd,
  RANK_MCAP_TO_VOLUME_TARGET,
  resolveJettonMarketCapUsd,
} from "../resolveJettonMarketCapUsd";
import { SwapJetton } from "../swapJettonsTypes";

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

  it("rejects preOPENAI / OPENAI $8.9B fantasy (live API regression)", () => {
    // Live: price×~10M supply → $8.86B while pool TVL is ~$5.3M and 24h vol ~$89k.
    // Old max mcap/TVL of 10_000 still accepted ratio ≈ 1_680.
    const raw = resolveJettonMarketCapUsd(
      jetton({
        symbol: "OPENAI",
        name: "preOPENAI",
        verification: "UNKNOWN",
        market_stats: {
          price_usd: 886.176363405419,
          mcap: 8_861_763_600,
          fdmc: 8_861_763_600,
          tvl_usd: 5_275_200,
          volume_usd_24h: 89_166.7,
        },
      }),
    );
    expect(raw).toBeNull();
  });

  it("rejects when mcap dwarfs 24h volume even if TVL looks mid-size", () => {
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "UNKNOWN",
          market_stats: {
            mcap: 200_000_000,
            tvl_usd: 600_000,
            volume_usd_24h: 20_000,
          },
        }),
      ),
    ).toBeNull();
  });

  it("excludes when mcap/volume exceeds hard coefficient (~0.05% turnover)", () => {
    // $50M mcap / $20k vol = 2_500 > 2_000 hard gate.
    expect(
      jettonFailsVolumeToMcapFilter({
        verification: "UNKNOWN",
        market_stats: {
          mcap: 50_000_000,
          tvl_usd: 200_000,
          volume_usd_24h: 20_000,
        },
      }),
    ).toBe(true);
    expect(
      resolveJettonMarketCapUsd(
        jetton({
          verification: "UNKNOWN",
          market_stats: {
            mcap: 50_000_000,
            tvl_usd: 200_000,
            volume_usd_24h: 20_000,
          },
        }),
      ),
    ).toBeNull();
  });

  it("keeps healthy turnover tokens (≈1%+ daily volume)", () => {
    // $10M mcap / $150k vol ≈ 67 ≤ 100 target — full trust + full rank.
    const j = jetton({
      verification: "COMMUNITY",
      market_stats: {
        mcap: 10_000_000,
        tvl_usd: 400_000,
        volume_usd_24h: 150_000,
      },
    });
    expect(resolveJettonMarketCapUsd(j)).toBe(10_000_000);
    expect(rankJettonMarketCapUsd(10_000_000, 150_000)).toBe(10_000_000);
  });

  it("soft-demotes thin but not excluded turnover toward volume × 100", () => {
    // $20M mcap / $50k vol = 400 (between target 100 and hard 2_000).
    const trusted = 20_000_000;
    const volume = 50_000;
    expect(jettonFailsVolumeToMcapFilter({
      verification: "UNKNOWN",
      market_stats: { mcap: trusted, tvl_usd: 200_000, volume_usd_24h: volume },
    })).toBe(false);
    expect(resolveJettonMarketCapUsd(
      jetton({
        verification: "UNKNOWN",
        market_stats: { mcap: trusted, tvl_usd: 200_000, volume_usd_24h: volume },
      }),
    )).toBe(trusted);
    expect(rankJettonMarketCapUsd(trusted, volume)).toBe(volume * RANK_MCAP_TO_VOLUME_TARGET);
    expect(rankJettonMarketCapUsd(trusted, volume)).toBe(5_000_000);
  });

  it("ranks dead-volume trusted small caps below any live book", () => {
    // Floor = 1% of SMALL_CAP_WITHOUT_LIQUIDITY ($1M) → $10k max when volume is 0.
    expect(rankJettonMarketCapUsd(500_000, 0)).toBe(10_000);
    expect(rankJettonMarketCapUsd(500_000, 0)).toBeLessThan(
      rankJettonMarketCapUsd(50_000, 5_000),
    );
  });
});
