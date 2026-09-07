/**
 * Client mirror of server AI token quota + tools prefs (per signed-in account).
 */
import { Platform } from "react-native";

import { postAiAgentChatAction } from "../../api/aiAgentChatsClient";

import { tokensToDllr } from "./aiConsumptionDllr";

export type AiModelMode = "auto" | "tinymodel" | "model";

export type AiFreeQuota = {
  tokensUsed: number;
  tokenLimit: number;
  tokensRemaining: number;
  proUnlimited: boolean;
  proActive: boolean;
  limitReached: boolean;
  proTokensUsedMonth: number;
  proMonthlyLimit: number;
  proTokensRemaining: number;
  monthKey: string;
  onDemandEnabled: boolean;
  onDemandRequired: boolean;
  onDemandUsdPer1kTokens: number;
  modelMode: AiModelMode;
  modelId: string | null;
  billingLane: "free" | "pro" | "on_demand";
  dllrUsed: number;
  dllrLimit: number;
};

export type AiToolsModelOption = {
  id: string;
  label: string;
  backend: "vercel_gateway" | "openai";
};

const STORAGE_KEY = "hsp.ai_free_quota.v2";
const listeners = new Set<() => void>();
let snapshot: AiFreeQuota = {
  tokensUsed: 0,
  tokenLimit: 4500,
  tokensRemaining: 4500,
  proUnlimited: false,
  proActive: false,
  limitReached: false,
  proTokensUsedMonth: 0,
  proMonthlyLimit: 200_000,
  proTokensRemaining: 200_000,
  monthKey: "",
  onDemandEnabled: false,
  onDemandRequired: false,
  onDemandUsdPer1kTokens: 0.002,
  modelMode: "auto",
  modelId: null,
  billingLane: "free",
  dllrUsed: 0,
  dllrLimit: tokensToDllr(250_000, 0.002),
};
let modelOptions: AiToolsModelOption[] = [];
let hydrated = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore */
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("hsp.ai_free_quota.v1");
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<AiFreeQuota>;
    snapshot = normalizeQuota(parsed);
  } catch {
    /* ignore */
  }
}

function normalizeQuota(raw: Partial<AiFreeQuota> | null | undefined): AiFreeQuota {
  const tokenLimit =
    typeof raw?.tokenLimit === "number" && raw.tokenLimit > 0 ? Math.round(raw.tokenLimit) : 4500;
  const tokensUsed =
    typeof raw?.tokensUsed === "number" && raw.tokensUsed >= 0 ? Math.round(raw.tokensUsed) : 0;
  const proActive = Boolean(raw?.proActive ?? raw?.proUnlimited);
  const proUnlimited = proActive;
  const proMonthlyLimit =
    typeof raw?.proMonthlyLimit === "number" && raw.proMonthlyLimit > 0
      ? Math.round(raw.proMonthlyLimit)
      : 200_000;
  const proTokensUsedMonth =
    typeof raw?.proTokensUsedMonth === "number" && raw.proTokensUsedMonth >= 0
      ? Math.round(raw.proTokensUsedMonth)
      : 0;
  const proTokensRemaining =
    typeof raw?.proTokensRemaining === "number"
      ? Math.max(0, Math.round(raw.proTokensRemaining))
      : Math.max(0, proMonthlyLimit - proTokensUsedMonth);
  const onDemandEnabled = Boolean(raw?.onDemandEnabled);
  const onDemandRequired = Boolean(raw?.onDemandRequired);
  const onDemandUsdPer1kTokens =
    typeof raw?.onDemandUsdPer1kTokens === "number" && raw.onDemandUsdPer1kTokens > 0
      ? raw.onDemandUsdPer1kTokens
      : 0.002;
  const modelModeRaw = typeof raw?.modelMode === "string" ? raw.modelMode : "auto";
  const modelMode: AiModelMode =
    modelModeRaw === "tinymodel" || modelModeRaw === "model" ? modelModeRaw : "auto";
  const modelId =
    typeof raw?.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim() : null;
  const billingLane =
    raw?.billingLane === "pro" || raw?.billingLane === "on_demand" ? raw.billingLane : "free";
  const tokensRemaining =
    typeof raw?.tokensRemaining === "number"
      ? Math.max(0, Math.round(raw.tokensRemaining))
      : proActive
        ? proTokensRemaining
        : Math.max(0, tokenLimit - tokensUsed);
  const limitReached =
    typeof raw?.limitReached === "boolean"
      ? raw.limitReached
      : (!proActive && tokensUsed >= tokenLimit) ||
        (proActive && proTokensRemaining <= 0 && !onDemandEnabled);
  const dllrUsed =
    typeof raw?.dllrUsed === "number" && Number.isFinite(raw.dllrUsed)
      ? Math.max(0, raw.dllrUsed)
      : tokensToDllr(proActive ? proTokensUsedMonth : tokensUsed, onDemandUsdPer1kTokens);
  const dllrLimit =
    typeof raw?.dllrLimit === "number" && Number.isFinite(raw.dllrLimit) && raw.dllrLimit > 0
      ? raw.dllrLimit
      : tokensToDllr(proActive ? proMonthlyLimit : tokenLimit, onDemandUsdPer1kTokens);
  return {
    tokensUsed,
    tokenLimit,
    tokensRemaining,
    proUnlimited,
    proActive,
    limitReached,
    proTokensUsedMonth,
    proMonthlyLimit,
    proTokensRemaining,
    monthKey: typeof raw?.monthKey === "string" ? raw.monthKey : "",
    onDemandEnabled,
    onDemandRequired,
    onDemandUsdPer1kTokens,
    modelMode,
    modelId,
    billingLane,
    dllrUsed,
    dllrLimit,
  };
}

export function getAiFreeQuotaSnapshot(): AiFreeQuota {
  hydrate();
  return snapshot;
}

export function getAiToolsModelOptions(): AiToolsModelOption[] {
  return modelOptions;
}

export function isAiFreeLimitReached(): boolean {
  return getAiFreeQuotaSnapshot().limitReached;
}

export function subscribeAiFreeQuota(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function applyAiFreeQuotaFromServer(raw: unknown): AiFreeQuota {
  hydrate();
  if (!raw || typeof raw !== "object") return snapshot;
  snapshot = normalizeQuota(raw as Partial<AiFreeQuota>);
  persist();
  notify();
  try {
    void import("../pro/proAccessStore").then((m) => {
      m.reconcileProAccessFromServer(snapshot.proActive);
    });
  } catch {
    /* ignore */
  }
  return snapshot;
}

function applyModels(raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const next: AiToolsModelOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<AiToolsModelOption>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    if (typeof row.label !== "string" || !row.label.trim()) continue;
    const backend = row.backend === "openai" ? "openai" : "vercel_gateway";
    next.push({ id: row.id.trim(), label: row.label.trim(), backend });
  }
  if (next.length > 0) modelOptions = next;
}

export async function refreshAiFreeQuotaFromServer(): Promise<AiFreeQuota> {
  const res = await postAiAgentChatAction({ action: "quota" });
  if (res.ok && res.quota) {
    applyModels(res.models);
    return applyAiFreeQuotaFromServer(res.quota);
  }
  return getAiFreeQuotaSnapshot();
}

export async function syncProAccessQuotaToServer(expiresAt: string | null): Promise<void> {
  try {
    const res = await postAiAgentChatAction({
      action: "sync_pro",
      expiresAt,
    });
    if (res.ok && res.quota) {
      applyAiFreeQuotaFromServer(res.quota);
    }
  } catch {
    /* offline / unauthorized — local Pro still gates UI */
  }
}

export async function saveAiToolsPrefs(opts: {
  modelMode?: AiModelMode;
  modelId?: string | null;
  onDemandEnabled?: boolean;
}): Promise<AiFreeQuota> {
  const res = await postAiAgentChatAction({
    action: "prefs",
    ...(opts.modelMode !== undefined ? { modelMode: opts.modelMode } : {}),
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    ...(opts.onDemandEnabled !== undefined ? { onDemandEnabled: opts.onDemandEnabled } : {}),
  });
  if (res.ok && res.quota) {
    applyModels(res.models);
    return applyAiFreeQuotaFromServer(res.quota);
  }
  return getAiFreeQuotaSnapshot();
}
