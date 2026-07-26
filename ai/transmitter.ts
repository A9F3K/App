import type { AiMode, AiRequestBase, AiResponseBase, ThreadContext } from "./openai.js";
import { callOpenAiChat, callOpenAiChatStream } from "./openai.js";
import { enrichWithTinyModel, type TinyModelEnrichmentMeta } from "./tinymodel.js";
import { actionsFromRouteHint } from "./intentActions.js";
import {
  getTokenBySymbol,
  normalizeSymbol,
  type TokenSearchResult,
} from "../blockchain/coffee.js";
import {
  insertMessage,
  getThreadHistory,
  type Message,
} from "../database/messages.js";
import { trustJettonMarketCapUsd } from "../ui/swap/resolveJettonMarketCapUsd.js";

export type AiRequest = AiRequestBase & {
  mode?: AiMode;
};

export type AiResponse = AiResponseBase;

const HISTORY_LIMIT = 50;

function formatHistoryForInput(history: Message[]): string {
  if (history.length === 0) return "";
  const lines = history.map((m) => {
    const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system";
    const content = (m.content ?? "").trim();
    return `${role}: ${content}`;
  });
  return "Previous conversation:\n" + lines.join("\n") + "\n\n";
}

/** Claim by insert; return skipped response if another instance won. */
async function claimUserMessage(
  thread: ThreadContext,
  content: string,
): Promise<AiResponse | null> {
  const inserted = await insertMessage({
    telegram_username: thread.telegram_username,
    thread_id: thread.thread_id,
    type: thread.type,
    role: "user",
    content,
    telegram_update_id: thread.telegram_update_id ?? undefined,
  });
  if (inserted === null) {
    return {
      ok: false,
      provider: "openai",
      mode: "chat",
      skipped: true,
    };
  }
  return null;
}

async function persistAssistantMessage(
  thread: ThreadContext,
  content: string,
): Promise<void> {
  await insertMessage({
    telegram_username: thread.telegram_username,
    thread_id: thread.thread_id,
    type: thread.type,
    role: "assistant",
    content,
  });
}

function extractSymbolCandidate(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // Simple patterns like "USDT", "$USDT", "USDT on TON".
  const parts = raw.split(/\s+/);
  const first = parts[0]?.replace(/^\$/g, "") ?? "";
  const normalized = normalizeSymbol(first);
  return normalized || null;
}

function buildTokenFactsBlock(symbol: string, token: any): string {
  const lines: string[] = [];

  const sym = token?.symbol ?? symbol;
  const name = token?.name ?? null;
  const address = token?.id ?? token?.address ?? null;
  const type = token?.type ?? "token";
  const decimals = token?.decimals ?? token?.metadata?.decimals ?? null;
  const verification =
    token?.verification ?? token?.metadata?.verification ?? null;

  const market = token?.market_stats ?? {};
  const holders =
    market?.holders_count ?? token?.holders ?? market?.holders ?? null;
  const priceUsd = market?.price_usd ?? null;
  // Same GAZZA-style supply×price fantasies must not reach AI context.
  const mcap = trustJettonMarketCapUsd({
    verification: verification ?? undefined,
    market_stats: market,
  });
  const volume24h = market?.volume_usd_24h ?? null;

  lines.push(`Symbol: ${sym}`);
  if (name) {
    lines.push(`Name: ${name}`);
  }
  lines.push(`Type: ${type}`);
  lines.push(`Blockchain: TON`);
  if (address) {
    lines.push(`Address: ${address}`);
  }
  if (decimals != null) {
    lines.push(`Decimals: ${decimals}`);
  }
  if (verification) {
    lines.push(`Verification: ${verification}`);
  }
  if (holders != null) {
    lines.push(`Holders: ${holders}`);
  }
  if (priceUsd != null) {
    lines.push(`Price (USD): ${priceUsd}`);
  }
  if (mcap != null) {
    lines.push(`Market cap (USD): ${mcap}`);
  }
  if (volume24h != null) {
    lines.push(`24h volume (USD): ${volume24h}`);
  }

  return lines.join("\n");
}

async function handleTokenInfo(
  request: AiRequest,
): Promise<AiResponse> {
  const trimmed = request.input?.trim() ?? "";
  const symbolCandidate = extractSymbolCandidate(trimmed);

  if (!symbolCandidate) {
    return {
      ok: false,
      provider: "openai",
      mode: "token_info",
      error: "Could not detect a token symbol. Try sending something like USDT.",
    };
  }

  const tokenResult: TokenSearchResult = await getTokenBySymbol(
    symbolCandidate,
  );

  if (!tokenResult.ok) {
    return {
      ok: false,
      provider: "openai",
      mode: "token_info",
      error:
        tokenResult.error === "not_found"
          ? `Token ${symbolCandidate} was not found on TON.`
          : "Token service is temporarily unavailable.",
      meta: {
        symbol: symbolCandidate,
        reason: tokenResult.reason,
        status_code: tokenResult.status_code,
      },
    };
  }

  const token = tokenResult.data;
  const facts = buildTokenFactsBlock(symbolCandidate, token);

  const promptParts = [
    "You are a concise TON token analyst.",
    "",
    "Facts about the token:",
    facts,
    "",
    "User question or context:",
    trimmed,
  ];

  const composedInput = promptParts.join("\n");

  const result = await callOpenAiChat("token_info", {
    input: composedInput,
    userId: request.userId,
    context: {
      ...request.context,
      symbol: symbolCandidate,
      token,
      source: "swap.coffee",
    },
    instructions: request.instructions,
  });

  return {
    ...result,
    mode: "token_info",
    meta: {
      ...(result.meta ?? {}),
      symbol: symbolCandidate,
      token,
    },
  };
}

async function applyTinyModelContext(
  request: AiRequest,
  inputWithHistory: string,
): Promise<{ input: string; tinymodel?: TinyModelEnrichmentMeta }> {
  if ((request.mode ?? "chat") !== "chat") {
    return { input: inputWithHistory };
  }
  const enriched = await enrichWithTinyModel(request.input, request.context);
  if (!enriched.contextBlock) {
    return { input: inputWithHistory, tinymodel: enriched.meta };
  }
  return {
    input: `${enriched.contextBlock}\n\n${inputWithHistory}`,
    tinymodel: enriched.meta,
  };
}

export async function transmit(request: AiRequest): Promise<AiResponse> {
  const mode: AiMode = request.mode ?? "chat";
  const thread = request.threadContext;

  if (thread && !thread.skipClaim) {
    const skipped = await claimUserMessage(thread, request.input);
    if (skipped) return skipped;
  }

  if (mode === "token_info") {
    const result = await handleTokenInfo(request);
    if (result.ok && result.output_text && thread) {
      await persistAssistantMessage(thread, result.output_text);
    }
    return result;
  }

  let input = request.input;
  if (thread) {
    const history = await getThreadHistory({
      telegram_username: thread.telegram_username,
      thread_id: thread.thread_id,
      type: thread.type,
      limit: HISTORY_LIMIT,
    });
    input = formatHistoryForInput(history) + "Current message:\nuser: " + request.input;
  }

  const { input: enrichedInput, tinymodel } = await applyTinyModelContext(
    request,
    input,
  );

  const result = await callOpenAiChat(mode, {
    input: enrichedInput,
    userId: request.userId,
    context: request.context,
    instructions: request.instructions,
  });

  if (result.ok && result.output_text && thread) {
    await persistAssistantMessage(thread, result.output_text);
  }
  const actions = actionsFromRouteHint(tinymodel?.route);
  return {
    ...result,
    ...(actions.length > 0 ? { actions } : {}),
    meta: {
      ...(result.meta ?? {}),
      ...(tinymodel ? { tinymodel } : {}),
    },
  };
}

/** Stream AI response; onDelta(accumulatedText) is called for each chunk. Only the final OpenAI call is streamed. */
export async function transmitStream(
  request: AiRequest,
  onDelta: (text: string) => void | Promise<void>,
  opts?: { isCancelled?: () => boolean; getAbortSignal?: () => Promise<boolean> },
): Promise<AiResponse> {
  const mode: AiMode = request.mode ?? "chat";
  const thread = request.threadContext;

  if (thread && !thread.skipClaim) {
    const skipped = await claimUserMessage(thread, request.input);
    if (skipped) return skipped;
  }

  if (mode === "token_info") {
    const tokenResult = await (async () => {
      const trimmed = request.input?.trim() ?? "";
      const symbolCandidate = extractSymbolCandidate(trimmed);
      if (!symbolCandidate) {
        return null;
      }
      return getTokenBySymbol(symbolCandidate);
    })();

    if (!tokenResult) {
      return {
        ok: false,
        provider: "openai",
        mode: "token_info",
        error: "Could not detect a token symbol. Try sending something like USDT.",
      };
    }
    if (!tokenResult.ok) {
      const symbolCandidate = extractSymbolCandidate(request.input?.trim() ?? "");
      return {
        ok: false,
        provider: "openai",
        mode: "token_info",
        error:
          tokenResult.error === "not_found"
            ? `Token ${symbolCandidate ?? ""} was not found on TON.`
            : "Token service is temporarily unavailable.",
        meta: {
          symbol: tokenResult.symbol,
          reason: tokenResult.reason,
          status_code: tokenResult.status_code,
        },
      };
    }

    const token = tokenResult.data;
    const symbolCandidate = extractSymbolCandidate(request.input?.trim() ?? "")!;
    const facts = buildTokenFactsBlock(symbolCandidate, token);
    const trimmed = request.input?.trim() ?? "";
    const promptParts = [
      "You are a concise TON token analyst.",
      "",
      "Facts about the token:",
      facts,
      "",
      "User question or context:",
      trimmed,
    ];
    const composedInput = promptParts.join("\n");

    const result = await callOpenAiChatStream(
      "token_info",
      {
        input: composedInput,
        userId: request.userId,
        context: {
          ...request.context,
          symbol: symbolCandidate,
          token,
          source: "swap.coffee",
        },
        instructions: request.instructions,
      },
      onDelta,
      opts,
    );

    if (result.ok && result.output_text && thread) {
      await persistAssistantMessage(thread, result.output_text);
    }
    return {
      ...result,
      mode: "token_info",
      meta: {
        ...(result.meta ?? {}),
        symbol: symbolCandidate,
        token,
      },
    };
  }

  let input = request.input;
  if (thread) {
    const history = await getThreadHistory({
      telegram_username: thread.telegram_username,
      thread_id: thread.thread_id,
      type: thread.type,
      limit: HISTORY_LIMIT,
    });
    input = formatHistoryForInput(history) + "Current message:\nuser: " + request.input;
  }

  const { input: enrichedInput, tinymodel } = await applyTinyModelContext(
    request,
    input,
  );

  const result = await callOpenAiChatStream(
    mode,
    {
      input: enrichedInput,
      userId: request.userId,
      context: request.context,
      instructions: request.instructions,
    },
    onDelta,
    opts,
  );

  if (result.ok && result.output_text && thread) {
    await persistAssistantMessage(thread, result.output_text);
  }
  const actions = actionsFromRouteHint(tinymodel?.route);
  return {
    ...result,
    ...(actions.length > 0 ? { actions } : {}),
    meta: {
      ...(result.meta ?? {}),
      ...(tinymodel ? { tinymodel } : {}),
    },
  };
}
