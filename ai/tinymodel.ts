/**
 * TinyModel Phase 3 reference API client (classify + retrieve).
 * Set TINYMODEL_API_URL to e.g. http://127.0.0.1:8765 when running:
 *   python scripts/phase3_reference_server.py --model HyperlinksSpace/TinyModel1
 * (from the TinyModel repo).
 */

import { HSP_PROGRAM_CORPUS_CHUNKS } from "./hspProgramCorpus.js";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TOP_K = 3;

export type TinyModelClassifyItem = {
  label_scores: Record<string, number>;
};

export type TinyModelRetrieveHit = {
  index: number;
  text: string;
  score: number;
};

export type TinyModelEnrichmentMeta = {
  configured: boolean;
  /** True when answer/context came from local keyword corpus (no TinyModel sidecar). */
  local_corpus?: boolean;
  health_ok?: boolean;
  error?: string;
  top_label?: string;
  top_label_prob?: number;
  retrieve_hits?: Array<{ index: number; score: number; title: string }>;
  route?: string;
};

export type TinyModelEnrichment = {
  meta: TinyModelEnrichmentMeta;
  contextBlock?: string;
};

function baseUrl(): string {
  return (process.env.TINYMODEL_API_URL ?? "").trim().replace(/\/$/, "");
}

export function isTinyModelConfigured(): boolean {
  return baseUrl().length > 0;
}

function timeoutMs(): number {
  const raw = process.env.TINYMODEL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const base = baseUrl();
  if (!base) {
    return { ok: false, status: 0, error: "TINYMODEL_API_URL not set" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let data: T | undefined;
    try {
      data = text ? (JSON.parse(text) as T) : undefined;
    } catch {
      return { ok: false, status: res.status, error: `Invalid JSON from TinyModel (${res.status})` };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `TinyModel HTTP ${res.status}`,
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "TinyModel request failed";
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function tinyModelHealth(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!isTinyModelConfigured()) {
    return { ok: false, error: "not configured" };
  }
  const res = await fetchJson<{ status?: string }>("/healthz");
  if (!res.ok) {
    return { ok: false, error: res.error ?? "health check failed" };
  }
  return { ok: res.data?.status === "ok" };
}

export async function classifyTexts(
  texts: string[],
): Promise<{ ok: boolean; items?: TinyModelClassifyItem[]; error?: string }> {
  const res = await fetchJson<{ items: TinyModelClassifyItem[] }>("/v1/classify", {
    method: "POST",
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  return { ok: true, items: res.data?.items ?? [] };
}

export async function retrieveFromCorpus(
  query: string,
  topK: number = DEFAULT_TOP_K,
  candidates: readonly string[] = HSP_PROGRAM_CORPUS_CHUNKS,
): Promise<{ ok: boolean; hits?: TinyModelRetrieveHit[]; error?: string }> {
  const res = await fetchJson<{ hits: TinyModelRetrieveHit[] }>("/v1/retrieve", {
    method: "POST",
    body: JSON.stringify({
      query,
      candidates: [...candidates],
      top_k: topK,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: res.error };
  }
  return { ok: true, hits: res.data?.hits ?? [] };
}

/** Lightweight route hint from user text (deterministic; complements encoder classify). */
export function inferHspRouteHint(input: string): string | undefined {
  const m = input.trim().toLowerCase();
  if (!m) return undefined;
  if (/\b(open|go to|show|navigate)\b.*\bswap\b/.test(m) || /\bswap page\b/.test(m)) {
    return "navigate:/swap";
  }
  if (/\b(send|transfer)\b/.test(m) && /\bton|jetton|token|wallet\b/.test(m)) {
    return "navigate:/send";
  }
  if (/\b(receive|wallet address|get wallet)\b/.test(m)) {
    return "navigate:/get";
  }
  if (/\b(connect telegram|telegram messages)\b/.test(m)) {
    return "feature:connect_telegram";
  }
  if (/\b(shield|security settings)\b/.test(m)) {
    return "feature:shield";
  }
  return undefined;
}

function formatContextBlock(
  hits: TinyModelRetrieveHit[],
  classify?: TinyModelClassifyItem,
  routeHint?: string,
  screenRoute?: string,
): string {
  const lines: string[] = [
    "Hyperlinks Space Program context (use for factual answers; do not invent features not listed here):",
  ];
  if (screenRoute) {
    lines.push(`User current screen route: ${screenRoute}`);
  }
  if (routeHint) {
    lines.push(`Route hint: ${routeHint}`);
  }
  if (classify?.label_scores) {
    const top = Object.entries(classify.label_scores).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      lines.push(`Encoder topic hint (soft): ${top[0]} (${top[1].toFixed(2)})`);
    }
  }
  hits.forEach((h, i) => {
    lines.push(`[Program excerpt ${i + 1}]\n${h.text}`);
  });
  lines.push(
    "If excerpts answer the question, prefer them. Never ask for seed phrases or private keys.",
  );
  return lines.join("\n\n");
}

function localCorpusRetrieve(
  query: string,
  topK: number = DEFAULT_TOP_K,
): TinyModelRetrieveHit[] {
  const stop = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "to",
    "of",
    "in",
    "on",
    "for",
    "and",
    "or",
    "what",
    "how",
    "why",
    "when",
    "where",
    "who",
    "which",
    "can",
    "do",
    "does",
    "did",
    "me",
    "my",
    "you",
    "your",
    "with",
    "from",
    "about",
    "please",
    "tell",
    "explain",
  ]);
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stop.has(t));
  if (tokens.length === 0) return [];

  const scored = HSP_PROGRAM_CORPUS_CHUNKS.map((text, index) => {
    const lower = text.toLowerCase();
    const title = (text.split("\n", 1)[0] ?? "").toLowerCase();
    let score = 0;
    let titleHits = 0;
    for (const tok of tokens) {
      if (lower.includes(tok)) score += 1;
      if (title.includes(tok)) {
        score += 0.75;
        titleHits += 1;
      }
    }
    // Require at least one content hit; normalize by query length.
    if (score <= 0) return { index, text, score: 0 };
    score = score / Math.max(1.5, tokens.length);
    if (titleHits > 0) score += 0.15 * titleHits;
    return { index, text, score };
  })
    .filter((h) => h.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/**
 * Classify + retrieve program help snippets when TINYMODEL_API_URL is set.
 * When unset, falls back to local keyword retrieve over the bundled program corpus
 * so short product questions can still be answered without an LLM key.
 */
export async function enrichWithTinyModel(
  input: string,
  context?: Record<string, unknown>,
): Promise<TinyModelEnrichment> {
  const trimmed = input.trim();
  if (!trimmed) {
    return { meta: { configured: isTinyModelConfigured() } };
  }

  const routeHint = inferHspRouteHint(trimmed);
  const screenRoute =
    typeof context?.route === "string" ? (context.route as string) : undefined;

  if (!isTinyModelConfigured()) {
    const hits = localCorpusRetrieve(trimmed);
    const meta: TinyModelEnrichmentMeta = {
      configured: false,
      local_corpus: hits.length > 0 || Boolean(routeHint),
      route: routeHint,
      retrieve_hits: hits.map((h) => ({
        index: h.index,
        score: h.score,
        title: h.text.split("\n", 1)[0] ?? "",
      })),
    };
    if (hits.length === 0) {
      return { meta };
    }
    return {
      meta,
      contextBlock: formatContextBlock(hits, undefined, routeHint, screenRoute),
    };
  }

  const health = await tinyModelHealth();
  if (!health.ok) {
    // Sidecar down — still try local corpus so chat is not dead.
    const hits = localCorpusRetrieve(trimmed);
    return {
      meta: {
        configured: true,
        health_ok: false,
        error: health.error,
        route: routeHint,
        local_corpus: hits.length > 0,
        retrieve_hits: hits.map((h) => ({
          index: h.index,
          score: h.score,
          title: h.text.split("\n", 1)[0] ?? "",
        })),
      },
      ...(hits.length > 0
        ? {
            contextBlock: formatContextBlock(hits, undefined, routeHint, screenRoute),
          }
        : {}),
    };
  }

  const [cls, ret] = await Promise.all([
    classifyTexts([trimmed]),
    retrieveFromCorpus(trimmed),
  ]);

  const meta: TinyModelEnrichmentMeta = {
    configured: true,
    health_ok: true,
    route: routeHint,
  };

  if (!cls.ok) {
    meta.error = cls.error;
  } else if (cls.items?.[0]?.label_scores) {
    const scores = cls.items[0].label_scores;
    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      meta.top_label = top[0];
      meta.top_label_prob = top[1];
    }
  }

  if (!ret.ok) {
    meta.error = meta.error ?? ret.error;
    const hits = localCorpusRetrieve(trimmed);
    if (hits.length > 0) {
      meta.local_corpus = true;
      meta.retrieve_hits = hits.map((h) => ({
        index: h.index,
        score: h.score,
        title: h.text.split("\n", 1)[0] ?? "",
      }));
      return {
        meta,
        contextBlock: formatContextBlock(hits, undefined, routeHint, screenRoute),
      };
    }
    return { meta };
  }

  const hits = ret.hits ?? [];
  meta.retrieve_hits = hits.map((h) => ({
    index: h.index,
    score: h.score,
    title: h.text.split("\n", 1)[0] ?? "",
  }));

  if (hits.length === 0) {
    return { meta };
  }

  return {
    meta,
    contextBlock: formatContextBlock(
      hits,
      cls.items?.[0],
      routeHint,
      screenRoute,
    ),
  };
}

export async function getTinyModelStatus(): Promise<Record<string, unknown>> {
  if (!isTinyModelConfigured()) {
    return { configured: false };
  }
  const health = await tinyModelHealth();
  return {
    configured: true,
    url: baseUrl(),
    health_ok: health.ok,
    error: health.error,
    corpus_chunks: HSP_PROGRAM_CORPUS_CHUNKS.length,
  };
}
