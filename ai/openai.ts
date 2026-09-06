import OpenAI from "openai";
import type { HspAiAction } from "./intentActions.js";

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
  provider: "openai";
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

const OPENAI = process.env.OPENAI?.trim() || "";

const client = OPENAI ? new OpenAI({ apiKey: OPENAI }) : null;

/** Pick a model for the agent column — light prompts stay cheap; complex ones use the flagship. */
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

export async function callOpenAiChat(
  mode: AiMode,
  params: AiRequestBase & { model?: string },
): Promise<AiResponseBase> {
  if (!client) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "OPENAI env is not configured on the server.",
    };
  }

  const trimmed = params.input?.trim();
  if (!trimmed) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "input is required.",
    };
  }

  const prefix =
    mode === "token_info"
      ? "You are a blockchain and token analyst. Answer clearly and briefly.\n\n"
      : "";

  const model =
    params.model?.trim() ||
    (mode === "chat" ? selectSmartChatModel(trimmed) : "gpt-5.2");

  try {
    const response = await client.responses.create({
      model,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      input: `${prefix}${trimmed}`,
    });

    return {
      ok: true,
      provider: "openai",
      mode,
      output_text: (response as any).output_text ?? undefined,
      usage: (response as any).usage ?? undefined,
      meta: { ...(params as any).meta, model },
    };
  } catch (e: any) {
    const message =
      e?.message ?? "Failed to call OpenAI. Check OPENAI env and network.";
    return {
      ok: false,
      provider: "openai",
      mode,
      error: message,
      meta: { model },
    };
  }
}

/** Call OpenAI with streaming; onDelta(textSoFar) is called for each chunk. Returns final response. */
export async function callOpenAiChatStream(
  mode: AiMode,
  params: AiRequestBase,
  onDelta: (text: string) => void | Promise<void>,
  opts?: { isCancelled?: () => boolean; getAbortSignal?: () => Promise<boolean> },
): Promise<AiResponseBase> {
  if (!client) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "OPENAI env is not configured on the server.",
    };
  }

  const trimmed = params.input?.trim();
  if (!trimmed) {
    return {
      ok: false,
      provider: "openai",
      mode,
      error: "input is required.",
    };
  }

  const prefix =
    mode === "token_info"
      ? "You are a blockchain and token analyst. Answer clearly and briefly.\n\n"
      : "";

  try {
    const stream = client.responses.stream({
      model: "gpt-5.2",
      ...(params.instructions ? { instructions: params.instructions } : {}),
      input: `${prefix}${trimmed}`,
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
    const r = response as any;
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
      return {
        ok: false,
        provider: "openai",
        mode,
        error: "OpenAI returned no text.",
        usage: r.usage ?? undefined,
      };
    }
    return {
      ok: true,
      provider: "openai",
      mode,
      output_text,
      usage: r.usage ?? undefined,
    };
  } catch (e: any) {
    const message =
      (e && typeof e === "object" && "message" in e ? (e as Error).message : null) ??
      (e != null ? String(e) : "Failed to call OpenAI. Check OPENAI env and network.");
    return {
      ok: false,
      provider: "openai",
      mode,
      error: message,
    };
  }
}
