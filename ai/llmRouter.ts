/**
 * Cheapest-sufficient LLM routing for HSP AI column / transmitter.
 *
 * Order:
 *  1. TinyModel (+ transmitter context) when retrieve/route quality is enough
 *  2. Vercel AI Gateway (mini → frontier by complexity)
 *  3. Direct OpenAI (same mini/frontier split)
 */

import type { TinyModelEnrichment, TinyModelEnrichmentMeta } from "./tinymodel.js";

export type LlmBackend = "tinymodel" | "vercel_gateway" | "openai";
export type LlmTier = "none" | "mini" | "frontier";

export type LlmRouteDecision = {
  backend: LlmBackend;
  tier: LlmTier;
  /** Provider model id (gateway uses `provider/model`). */
  model: string;
  reason: string;
};

const GATEWAY_BASE = "https://ai-gateway.vercel.sh/v1";

/** Strong enough retrieve hit to answer from corpus without a frontier LLM. */
const TINY_RETRIEVE_SCORE_MIN = 0.28;
const TINY_TOP_LABEL_PROB_MIN = 0.45;

/** Pick complexity class — light prompts stay cheap; complex ones use frontier. */
export function selectSmartChatModel(input: string): string {
  const t = input.trim();
  const len = t.length;
  const complex =
    len > 280 ||
    /\b(analy[sz]e|compare|architect|debug|refactor|prove|derive|code|sql|contract|security|plan)\b/i.test(
      t,
    ) ||
    (t.match(/\?/g) ?? []).length >= 2;
  return complex ? "gpt-5.2" : "gpt-4.1-mini";
}

export function isVercelGatewayConfigured(): boolean {
  const key =
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_OIDC_TOKEN?.trim() ||
    "";
  return key.length > 0;
}

export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI?.trim());
}

export function gatewayAuthKey(): string {
  return (
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.VERCEL_OIDC_TOKEN?.trim() ||
    ""
  );
}

export function gatewayBaseUrl(): string {
  return (process.env.AI_GATEWAY_BASE_URL?.trim() || GATEWAY_BASE).replace(/\/$/, "");
}

/** Map HSP complexity to Gateway model ids (cheap mini first). */
export function gatewayModelForInput(input: string, preferFrontier: boolean): string {
  if (preferFrontier || selectSmartChatModel(input) === "gpt-5.2") {
    return process.env.AI_GATEWAY_FRONTIER_MODEL?.trim() || "openai/gpt-4.1";
  }
  return process.env.AI_GATEWAY_MINI_MODEL?.trim() || "openai/gpt-4.1-mini";
}

/** Direct OpenAI model ids. */
export function openAiModelForInput(input: string, preferFrontier: boolean): string {
  if (preferFrontier) return "gpt-5.2";
  return selectSmartChatModel(input);
}

/**
 * True when TinyModel RAG / route hints can satisfy the user without an LLM call.
 * Keeps quality bar: factual HSP help, navigation, or high-confidence retrieve.
 */
export function canAnswerWithTinyModel(
  input: string,
  meta?: TinyModelEnrichmentMeta | null,
): boolean {
  if (!meta) return false;
  const trimmed = input.trim();
  if (!trimmed) return false;

  // Multi-step / analysis / code → need a real LLM.
  if (selectSmartChatModel(trimmed) === "gpt-5.2") return false;
  if (trimmed.length > 400) return false;

  // Local corpus / route-only answers (no TinyModel sidecar) still count when strong.
  if (meta.route && (meta.configured || meta.local_corpus)) return true;

  if (!meta.configured && !meta.local_corpus) return false;
  if (meta.health_ok === false && !meta.local_corpus) return false;

  const hits = meta.retrieve_hits ?? [];
  if (hits.length === 0) return false;
  const best = Math.max(...hits.map((h) => h.score));
  const scoreMin = meta.local_corpus ? 0.18 : TINY_RETRIEVE_SCORE_MIN;
  if (best < scoreMin) return false;

  const labelOk =
    meta.top_label_prob == null || meta.top_label_prob >= TINY_TOP_LABEL_PROB_MIN;
  const looksLikeProductHelp =
    /\b(how|what|where|when|why|can i|does|feature|pro|swap|wallet|telegram|ai|price|cost|subscribe)\b/i.test(
      trimmed,
    ) || trimmed.length < 160;

  return labelOk && looksLikeProductHelp;
}

/** Build a user-facing reply from TinyModel retrieve hits (no LLM). */
export function buildTinyModelOnlyAnswer(
  input: string,
  enrichment: TinyModelEnrichment,
): string {
  const hits = enrichment.meta.retrieve_hits ?? [];
  const route = enrichment.meta.route;
  const lines: string[] = [];

  if (route?.startsWith("navigate:")) {
    const path = route.slice("navigate:".length);
    lines.push(
      `I can take you to **${path}**. Use the suggested action, or open it from the menu.`,
    );
  } else if (route?.startsWith("feature:")) {
    const feature = route.slice("feature:".length).replace(/_/g, " ");
    lines.push(`That relates to **${feature}** in Hyperlinks Space Program.`);
  }

  if (enrichment.contextBlock) {
    const parts = enrichment.contextBlock.split(/\[Program excerpt \d+\]\n/);
    const excerpts = parts
      .slice(1)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 2);
    if (excerpts.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(excerpts.join("\n\n"));
    }
  } else if (hits.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(hits.map((h) => h.title).filter(Boolean).join("\n\n"));
  }

  if (lines.length === 0) {
    lines.push(
      "I found related Hyperlinks Space Program context, but not a full answer. Try rephrasing, or ask again for a deeper reply.",
    );
  }

  lines.push("");
  lines.push("_Quick answer from program knowledge._");
  return lines.join("\n").trim();
}

export type LlmRoutePreference = {
  /** auto = smart cheapest-sufficient; tinymodel = RAG only; model = fixed id. */
  modelMode?: "auto" | "tinymodel" | "model";
  /** Gateway (`provider/model`) or OpenAI model id when modelMode is `model`. */
  modelId?: string | null;
};

/**
 * Pick backend + model. Prefer TinyModel-only when capable; else Gateway then OpenAI.
 */
export function resolveLlmRoute(
  input: string,
  tinymodel?: TinyModelEnrichmentMeta | null,
  opts?: {
    preferFrontier?: boolean;
    allowTinyOnly?: boolean;
    preference?: LlmRoutePreference | null;
  },
): LlmRouteDecision | { error: string } {
  const allowTiny = opts?.allowTinyOnly !== false;
  const preferFrontier = opts?.preferFrontier === true;
  const pref = opts?.preference;
  const mode = pref?.modelMode ?? "auto";
  const forcedId = typeof pref?.modelId === "string" ? pref.modelId.trim() : "";

  if (mode === "tinymodel") {
    return {
      backend: "tinymodel",
      tier: "none",
      model: "tinymodel/rag",
      reason: "user_tinymodel_only",
    };
  }

  if (mode === "model" && forcedId) {
    const looksGateway = forcedId.includes("/");
    if (looksGateway && isVercelGatewayConfigured()) {
      return {
        backend: "vercel_gateway",
        tier: forcedId.includes("mini") ? "mini" : "frontier",
        model: forcedId,
        reason: "user_fixed_gateway_model",
      };
    }
    if (isOpenAiConfigured()) {
      const direct = looksGateway ? forcedId.split("/").pop() || forcedId : forcedId;
      return {
        backend: "openai",
        tier: direct.includes("mini") ? "mini" : "frontier",
        model: direct,
        reason: "user_fixed_openai_model",
      };
    }
    if (isVercelGatewayConfigured()) {
      const gw = looksGateway ? forcedId : `openai/${forcedId}`;
      return {
        backend: "vercel_gateway",
        tier: gw.includes("mini") ? "mini" : "frontier",
        model: gw,
        reason: "user_fixed_gateway_fallback",
      };
    }
    return {
      error:
        "Selected model needs AI_GATEWAY_API_KEY or OPENAI configured on the server.",
    };
  }

  if (allowTiny && canAnswerWithTinyModel(input, tinymodel)) {
    return {
      backend: "tinymodel",
      tier: "none",
      model: "tinymodel/rag",
      reason: "strong_retrieve_or_route",
    };
  }

  if (isVercelGatewayConfigured()) {
    const model = gatewayModelForInput(input, preferFrontier);
    return {
      backend: "vercel_gateway",
      tier: model.includes("mini") ? "mini" : "frontier",
      model,
      reason: "gateway_available",
    };
  }

  if (isOpenAiConfigured()) {
    const model = openAiModelForInput(input, preferFrontier);
    return {
      backend: "openai",
      tier: model.includes("mini") ? "mini" : "frontier",
      model,
      reason: "openai_direct",
    };
  }

  return {
    error:
      "No AI provider configured. Set AI_GATEWAY_API_KEY (Vercel AI Gateway), or OPENAI, and optionally TINYMODEL_API_URL for free program answers.",
  };
}

/** Curated models offered in the AI tools dialog (Gateway + OpenAI). */
export const AI_TOOLS_MODEL_OPTIONS: Array<{
  id: string;
  label: string;
  backend: "vercel_gateway" | "openai";
}> = [
  // Vercel AI Gateway — popular, well-known models for messenger, market, and in-app actions
  // https://vercel.com/docs/ai-gateway · https://ai-gateway.vercel.sh/v1/models
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", backend: "vercel_gateway" },
  { id: "openai/gpt-5.2", label: "GPT-5.2", backend: "vercel_gateway" },
  { id: "openai/gpt-6-astra", label: "GPT-6 Astra", backend: "vercel_gateway" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", backend: "vercel_gateway" },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", backend: "vercel_gateway" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", backend: "vercel_gateway" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", backend: "vercel_gateway" },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", backend: "vercel_gateway" },
  { id: "alibaba/qwen3.8-max-0902", label: "Qwen3.8 Max", backend: "vercel_gateway" },
  { id: "zai/glm-5.3", label: "GLM-5.3", backend: "vercel_gateway" },
  { id: "spacexai/grok-4.3", label: "Grok 4.3", backend: "vercel_gateway" },
  { id: "mistral/mistral-large-3", label: "Mistral Large 3", backend: "vercel_gateway" },
  // Direct OpenAI fallbacks when Gateway is unavailable
  { id: "gpt-5.2", label: "GPT-5.2 (OpenAI)", backend: "openai" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini (OpenAI)", backend: "openai" },
];
