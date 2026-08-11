import type { SwapJetton } from "./swapJettonsTypes";

/**
 * Off-chain brands / products that do not issue a real TON jetton.
 * Scammers mint lookalikes (e.g. preOPENAI / OPENAI with the OpenAI mark) and
 * ride a thin-pool price into a fantasy market cap near the top of the list.
 */
const IMPERSONATED_BRAND_PATTERNS: readonly RegExp[] = [
  /\bopenai\b/i,
  /\bchatgpt\b/i,
  /\bgpt-?4\b/i,
  /\bclaude\b/i,
  /\banthropic\b/i,
  /\btesla\b/i,
  /\bnvidia\b/i,
  /\bmicrosoft\b/i,
  /\bgoogle\b/i,
  /\balphabet\b/i,
  /\bapple\b/i,
  /\bamazon\b/i,
  /\bmeta\b/i,
  /\bfacebook\b/i,
  /\binstagram\b/i,
  /\btwitter\b/i,
  /\bx\.com\b/i,
  /\bnetflix\b/i,
  /\bspacex\b/i,
  /\bstarlink\b/i,
];

function labelsFor(jetton: SwapJetton): string[] {
  return [jetton.symbol ?? "", jetton.name ?? ""]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * True when an unverified jetton impersonates a well-known brand that is not
 * a TON issuance. Whitelisted rows are left alone (Swap.Coffee already vetted).
 */
export function jettonImpersonatesKnownBrand(jetton: SwapJetton): boolean {
  if (jetton.verification === "WHITELISTED") return false;
  const labels = labelsFor(jetton);
  if (labels.length === 0) return false;
  return labels.some((label) => IMPERSONATED_BRAND_PATTERNS.some((re) => re.test(label)));
}
