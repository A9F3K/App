import {
  tradeHaramartaImage,
  tradePixakatsImage,
} from "./tradeAssets";

export type TradeCollectionItem = {
  image: number;
  title: string;
  subtitle: string;
};

/**
 * Collections used by the first-row grid.
 *
 * Ordering is defined per-slide by duplicating the same sample items with changed order.
 * Current slide 0 uses indices 0..3; slide 1 uses indices 4..7.
 */
export const TRADE_SAMPLE_COLLECTIONS: TradeCollectionItem[] = [
  // Slide 0
  { image: tradePixakatsImage, title: "pixa kats", subtitle: "Tandam" },
  { image: tradeHaramartaImage, title: "Haramarta", subtitle: "Bid Raits" },
  { image: tradePixakatsImage, title: "pixa kats", subtitle: "Tandam" },
  { image: tradeHaramartaImage, title: "Haramarta", subtitle: "Bid Raits" },

  // Slide 1 (reversed order)
  { image: tradeHaramartaImage, title: "Haramarta", subtitle: "Bid Raits" },
  { image: tradePixakatsImage, title: "pixa kats", subtitle: "Tandam" },
  { image: tradeHaramartaImage, title: "Haramarta", subtitle: "Bid Raits" },
  { image: tradePixakatsImage, title: "pixa kats", subtitle: "Tandam" },
];

export type TradeFeedItem = {
  primaryText: string;
  secondaryText: string;
  timestamp: string;
  rightText: string;
};

export const TRADE_SAMPLE_FEED_ITEMS: TradeFeedItem[] = [
  {
    primaryText: "Some walley",
    secondaryText: "777$",
    timestamp: "1",
    rightText: "10,123$",
  },
  {
    primaryText: "Sty. ker",
    secondaryText: "537$",
    timestamp: "2",
    rightText: "9,9999$",
  },
  {
    primaryText: "4iza",
    secondaryText: "157$",
    timestamp: "3",
    rightText: "7111$",
  },
];
