import { mapJettonToChooseCurrencyRow } from "../mapJettonToChooseCurrencyRow";
import { RANK_MCAP_TO_VOLUME_TARGET } from "../resolveJettonMarketCapUsd";
import { SwapJetton } from "../swapJettonsTypes";

describe("mapJettonToChooseCurrencyRow scam filters", () => {
  it("excludes preOPENAI brand impersonation from the list", () => {
    const jetton: SwapJetton = {
      address: "0:927d8424edbbb51671be2e9194610412dfe6cc31aea663e995658df34621f3fc",
      decimals: 9,
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
    };
    expect(mapJettonToChooseCurrencyRow(jetton, new Map(), "en")).toBeNull();
  });

  it("excludes extreme low-volume / high-mcap tokens from the list", () => {
    const jetton: SwapJetton = {
      address: "0:lowvolume",
      decimals: 9,
      symbol: "THIN",
      name: "Thin Book",
      verification: "UNKNOWN",
      market_stats: {
        mcap: 50_000_000,
        tvl_usd: 200_000,
        volume_usd_24h: 20_000, // mcap/vol = 2_500 > hard gate
      },
    };
    expect(mapJettonToChooseCurrencyRow(jetton, new Map(), "en")).toBeNull();
  });

  it("soft-demotes mid turnover via volume × 100 sort key", () => {
    const volume = 50_000;
    const jetton: SwapJetton = {
      address: "0:softdemote",
      decimals: 9,
      symbol: "MID",
      name: "Mid Turnover",
      verification: "UNKNOWN",
      market_stats: {
        mcap: 20_000_000,
        tvl_usd: 200_000,
        volume_usd_24h: volume, // ratio 400 — keep, demote
      },
    };
    const row = mapJettonToChooseCurrencyRow(jetton, new Map(), "en");
    expect(row).not.toBeNull();
    expect(row!.marketCap).not.toBe("—");
    expect(row!.marketCapUsd).toBe(volume * RANK_MCAP_TO_VOLUME_TARGET);
  });
});
