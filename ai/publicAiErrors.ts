/**
 * Map provider/SDK failures to stable public codes — never leak vendor copy or URLs.
 */

export type PublicAiErrorCode =
  | "ai_capacity"
  | "ai_unavailable"
  | "ai_not_configured"
  | "input_required"
  | "free_ai_limit";

export function errorMessageFromUnknown(err: unknown): string {
  if (err instanceof Error) return err.message || "";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err ?? "");
  }
}

/** True when the upstream is rate-limiting free/paid quota (Gateway, OpenAI, etc.). */
export function isAiCapacityError(err: unknown): boolean {
  const msg = errorMessageFromUnknown(err).toLowerCase();
  if (!msg) return false;
  return (
    /\b429\b/.test(msg) ||
    msg.includes("rate-limited") ||
    msg.includes("rate limited") ||
    msg.includes("rate_limit") ||
    msg.includes("free tier") ||
    msg.includes("paid credits") ||
    msg.includes("insufficient_quota") ||
    msg.includes("insufficient quota") ||
    msg.includes("quota exceeded") ||
    msg.includes("billing") ||
    msg.includes("top-up") ||
    msg.includes("vercel.com") ||
    msg.includes("ai-gateway")
  );
}

export function classifyAiProviderError(err: unknown): {
  code: PublicAiErrorCode;
  rateLimited: boolean;
} {
  const msg = errorMessageFromUnknown(err).toLowerCase();
  if (msg.includes("input is required")) {
    return { code: "input_required", rateLimited: false };
  }
  if (
    msg.includes("no ai provider") ||
    msg.includes("not configured") ||
    msg.includes("openai env")
  ) {
    return { code: "ai_not_configured", rateLimited: false };
  }
  if (isAiCapacityError(err)) {
    return { code: "ai_capacity", rateLimited: true };
  }
  return { code: "ai_unavailable", rateLimited: false };
}

/** Only allow known public codes through to clients. */
export function toPublicAiErrorCode(raw: unknown): PublicAiErrorCode {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (
    s === "ai_capacity" ||
    s === "ai_unavailable" ||
    s === "ai_not_configured" ||
    s === "input_required" ||
    s === "free_ai_limit"
  ) {
    return s;
  }
  return classifyAiProviderError(raw).code;
}
