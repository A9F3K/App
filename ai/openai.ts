import OpenAI from "openai";
import type { HspAiAction } from "./intentActions.js";
import {
  gatewayAuthKey,
  gatewayBaseUrl,
  isOpenAiConfigured,
  isVercelGatewayConfigured,
  resolveLlmRoute,
  selectSmartChatModel,
  type LlmBackend,
} from "./llmRouter.js";
import type { TinyModelEnrichmentMeta } from "./tinymodel.js";
import {
  classifyAiProviderError,
  isAiCapacityError,
  toPublicAiErrorCode,
} from "./publicAiErrors.js";

export type AiMode = "chat" | "token_info";

export type ThreadContext = {
  telegram_username: string;
  thread_id: number;
  type: "bot" | "app";
  telegram_update_id?: number | null;
  /** When true, skip claim insert (e.g. same handler retrying token_info -> chat); still use history and persist assistant. */
  skipClaim?: boolean;
};

export type AiRequestBase = {
  input: string;
  userId?: string;
  context?: Record<string, unknown>;
  /** When set, AI layer persists user/assistant and uses thread history for chat. */
  threadContext?: ThreadContext;
  /** Optional instructions for the model (e.g. length limit); passed to OpenAI native `instructions` field. */
  instructions?: string;
};

export type AiResponseBase = {
  ok: boolean;
  provider: LlmBackend | "openai";
  output_text?: string;
  error?: string;
  mode: AiMode;
  /** True when claim insert failed (another instance or duplicate); caller should not send. */
  skipped?: boolean;
  /** Optional shell actions (navigate, feature focus) derived from intent routing. */
  actions?: HspAiAction[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  meta?: Record<string, unknown>;
};

export { selectSmartChatModel } from "./llmRouter.js";

function openAiDirectClient(): OpenAI | null {
  const key = process.env.OPENAI?.trim() || "";
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

function gatewayClient(): OpenAI | null {
  const key = gatewayAuthKey();
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: gatewayBaseUrl(),
  });
}

function modePrefix(mode: AiMode): string {
  return mode === "token_info"
    ? "You are a blockchain and token analyst. Answer clearly and briefly.\n\n"
    : "";
}

async function runResponsesCreate(
  client: OpenAI,
  args: {
    model: string;
    input: string;
    instructions?: string;
  },
): Promise<{ output_text?: string; usage?: AiResponseBase["usage"] }> {
  const response = await client.responses.create({
    model: args.model,
    ...(args.instructions ? { instructions: args.instructions } : {}),
    input: args.input,
  });
  const r = response as {
    output_text?: string;
    usage?: AiResponseBase["usage"];
  };
  return { output_text: r.output_text, usage: r.usage };
}

/**
 * Chat completion with cheapest-sufficient backend:
 * Vercel AI Gateway → direct OpenAI (TinyModel-only is handled in transmitter).
 */
export async function callOpenAiChat(
  mode: AiMode,
  params: AiRequestBase & {
    model?: string;
    /** Soft hint from TinyModel; used only for route logging / future gates. */
    tinymodel?: TinyModelEnrichmentMeta;
    /** Force frontier-class model when true. */
    preferFrontier?: boolean;
    /** Skip gateway and use OpenAI only (rare). */
    forceOpenAi?: boolean;
    routePreference?: {
      modelMode?: "auto" | "tinymodel" | "model";
      modelId?: string | null;
    } | null;
  },
): Promise<AiResponseBase> {
  const trimmed = params.input?.trim();
  if (!trimmed) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "input is required.",
    };
  }

  const route = params.forceOpenAi
    ? isOpenAiConfigured()
      ? {
          backend: "openai" as const,
          tier: "mini" as const,
          model: params.model?.trim() || selectSmartChatModel(trimmed),
          reason: "force_openai",
        }
      : { error: "OPENAI env is not configured on the server." }
    : resolveLlmRoute(trimmed, params.tinymodel, {
        preferFrontier: params.preferFrontier || mode === "token_info",
        allowTinyOnly: false,
        preference: params.routePreference,
      });

  if ("error" in route) {
    return {
      ok: false,
      provider: isVercelGatewayConfigured() ? "vercel_gateway" : "openai",
      mode,
      error: toPublicAiErrorCode(route.error),
    };
  }

  const model = params.model?.trim() || route.model;
  const prefix = modePrefix(mode);
  const input = `${prefix}${trimmed}`;

  const tryGateway = route.backend === "vercel_gateway" || isVercelGatewayConfigured();
  const tryOpenAi = isOpenAiConfigured();

  const attempts: Array<{ backend: LlmBackend; client: OpenAI; model: string }> = [];
  if (!params.forceOpenAi && tryGateway) {
    const gw = gatewayClient();
    if (gw) {
      attempts.push({
        backend: "vercel_gateway",
        client: gw,
        model: route.backend === "vercel_gateway" ? model : model.includes("/") ? model : `openai/${model}`,
      });
    }
  }
  if (tryOpenAi) {
    const oa = openAiDirectClient();
    if (oa) {
      const directModel = model.includes("/")
        ? model.split("/").pop() || selectSmartChatModel(trimmed)
        : model;
      attempts.push({ backend: "openai", client: oa, model: directModel });
    }
  }

  if (attempts.length === 0) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "ai_not_configured",
    };
  }

  // Prefer primary route, then a cheap Gateway mini, then OpenAI direct (already listed).
  const seen = new Set<string>();
  const uniqueAttempts: typeof attempts = [];
  for (const a of attempts) {
    const key = `${a.backend}:${a.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAttempts.push(a);
  }
  if (isVercelGatewayConfigured()) {
    const gw = gatewayClient();
    const cheap = process.env.AI_GATEWAY_MINI_MODEL?.trim() || "openai/gpt-4.1-mini";
    if (gw && !seen.has(`vercel_gateway:${cheap}`)) {
      uniqueAttempts.push({ backend: "vercel_gateway", client: gw, model: cheap });
    }
  }

  let lastError = "ai_unavailable";
  let sawCapacity = false;
  for (const attempt of uniqueAttempts) {
    try {
      const { output_text, usage } = await runResponsesCreate(attempt.client, {
        model: attempt.model,
        input,
        instructions: params.instructions,
      });
      if (!output_text?.trim()) {
        lastError = "ai_unavailable";
        continue;
      }
      return {
        ok: true,
        provider: attempt.backend,
        mode,
        output_text,
        usage,
        meta: {
          ...(params as { meta?: Record<string, unknown> }).meta,
          model: attempt.model,
          backend: attempt.backend,
          route_reason: route.reason,
        },
      };
    } catch (e: unknown) {
      const classified = classifyAiProviderError(e);
      if (classified.rateLimited || isAiCapacityError(e)) sawCapacity = true;
      lastError = classified.code;
      // Try next backend/model — never surface vendor messages.
      continue;
    }
  }

  return {
    ok: false,
    provider: uniqueAttempts[0]?.backend ?? "openai",
    mode,
    error: sawCapacity ? "ai_capacity" : toPublicAiErrorCode(lastError),
    meta: { attempted: uniqueAttempts.map((a) => a.backend) },
  };
}

/** Call with streaming; Gateway first, then OpenAI. */
export async function callOpenAiChatStream(
  mode: AiMode,
  params: AiRequestBase & {
    tinymodel?: TinyModelEnrichmentMeta;
    preferFrontier?: boolean;
    routePreference?: {
      modelMode?: "auto" | "tinymodel" | "model";
      modelId?: string | null;
    } | null;
  },
  onDelta: (text: string) => void | Promise<void>,
  opts?: { isCancelled?: () => boolean; getAbortSignal?: () => Promise<boolean> },
): Promise<AiResponseBase> {
  const trimmed = params.input?.trim();
  if (!trimmed) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "input is required.",
    };
  }

  const route = resolveLlmRoute(trimmed, params.tinymodel, {
    preferFrontier: params.preferFrontier || mode === "token_info",
    allowTinyOnly: false,
    preference: params.routePreference,
  });
  if ("error" in route) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: toPublicAiErrorCode(route.error),
    };
  }

  const prefix = modePrefix(mode);
  const input = `${prefix}${trimmed}`;

  const attempts: Array<{ backend: LlmBackend; client: OpenAI; model: string }> = [];
  if (isVercelGatewayConfigured()) {
    const gw = gatewayClient();
    if (gw) {
      attempts.push({
        backend: "vercel_gateway",
        client: gw,
        model:
          route.backend === "vercel_gateway"
            ? route.model
            : gatewayModelOrFallback(trimmed),
      });
    }
  }
  if (isOpenAiConfigured()) {
    const oa = openAiDirectClient();
    if (oa) {
      attempts.push({
        backend: "openai",
        client: oa,
        model: selectSmartChatModel(trimmed) === "gpt-5.2" ? "gpt-5.2" : "gpt-4.1-mini",
      });
    }
  }

  if (attempts.length === 0) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "ai_not_configured",
    };
  }

  let lastError = "ai_unavailable";
  let sawCapacity = false;
  for (const attempt of attempts) {
    try {
      const stream = attempt.client.responses.stream({
        model: attempt.model,
        ...(params.instructions ? { instructions: params.instructions } : {}),
        input,
      });

      stream.on("response.output_text.delta", async (event: { snapshot?: string }) => {
        if (opts?.isCancelled && opts.isCancelled()) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stream as any)?.abort?.();
          } catch {
            /* ignore */
          }
          return;
        }
        if (opts?.getAbortSignal && (await opts.getAbortSignal())) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (stream as any)?.abort?.();
          } catch {
            /* ignore */
          }
          return;
        }
        const text = event?.snapshot ?? "";
        if (text.length > 0) void Promise.resolve(onDelta(text));
      });

      const response = await stream.finalResponse();
      const r = response as {
        output_text?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
        usage?: AiResponseBase["usage"];
      };
      let output_text = r.output_text;
      if (output_text == null || String(output_text).trim() === "") {
        const parts: string[] = [];
        for (const item of r.output ?? []) {
          if (item?.type === "message" && Array.isArray(item.content)) {
            for (const content of item.content) {
              if (content?.type === "output_text" && typeof content.text === "string") {
                parts.push(content.text);
              }
            }
          }
        }
        output_text = parts.join("");
      }
      if (output_text == null || String(output_text).trim() === "") {
        lastError = "ai_unavailable";
        continue;
      }
      return {
        ok: true,
        provider: attempt.backend,
        mode,
        output_text,
        usage: r.usage ?? undefined,
        meta: { model: attempt.model, backend: attempt.backend },
      };
    } catch (e: unknown) {
      const classified = classifyAiProviderError(e);
      if (classified.rateLimited || isAiCapacityError(e)) sawCapacity = true;
      lastError = classified.code;
      continue;
    }
  }

  return {
    ok: false,
    provider: attempts[0]?.backend ?? "openai",
    mode,
    error: sawCapacity ? "ai_capacity" : toPublicAiErrorCode(lastError),
  };
}

function gatewayModelOrFallback(input: string): string {
  return selectSmartChatModel(input) === "gpt-5.2"
    ? process.env.AI_GATEWAY_FRONTIER_MODEL?.trim() || "openai/gpt-4.1"
    : process.env.AI_GATEWAY_MINI_MODEL?.trim() || "openai/gpt-4.1-mini";
}

/** @deprecated Prefer isOpenAiConfigured / isVercelGatewayConfigured from llmRouter. */
export function isOpenAiClientReady(): boolean {
  return isOpenAiConfigured() || isVercelGatewayConfigured();
}
