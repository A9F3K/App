import { buildApiUrl } from "../../api/_base";

export type PrivateCallPhase =
  | "idle"
  | "dialing"
  | "ringing"
  | "exchanging"
  | "ready"
  | "hanging_up"
  | "discarded"
  | "error";

export type PrivateCallSnapshot = {
  call_id: number;
  user_id: number;
  is_outgoing: boolean;
  is_video: boolean;
  phase: PrivateCallPhase;
  error: string | null;
  emojis: string[];
  has_encryption_key?: boolean;
  server_count?: number;
};

export async function createTelegramPrivateCall(
  userId: number,
  options?: { isVideo?: boolean },
): Promise<
  | { ok: true; call: PrivateCallSnapshot }
  | { ok: false; error: string }
> {
  if (!Number.isFinite(userId) || userId === 0) {
    return { ok: false, error: "user_id_required" };
  }
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-call-create"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: Math.trunc(userId),
        is_video: Boolean(options?.isVideo),
      }),
    });
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; call?: PrivateCallSnapshot; error?: string }
      | null;
    if (!response.ok || !json?.ok || !json.call) {
      return { ok: false, error: json?.error ?? "create_call_failed" };
    }
    return { ok: true, call: json.call };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function fetchTelegramPrivateCallStatus(
  callId?: number | null,
): Promise<
  | { ok: true; call: PrivateCallSnapshot | null }
  | { ok: false; error: string }
> {
  const params = new URLSearchParams();
  if (callId != null && Number.isFinite(callId) && callId > 0) {
    params.set("call_id", String(Math.trunc(callId)));
  }
  const qs = params.toString();
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-call-status${qs ? `?${qs}` : ""}`),
      { method: "GET", credentials: "include" },
    );
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; call?: PrivateCallSnapshot | null; error?: string }
      | null;
    if (!response.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? "call_status_unavailable" };
    }
    return { ok: true, call: json.call ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function discardTelegramPrivateCall(
  callId?: number | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(buildApiUrl("/api/telegram-messages-call-discard"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_id:
          callId != null && Number.isFinite(callId) && callId > 0
            ? Math.trunc(callId)
            : undefined,
      }),
    });
    const json = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    return {
      ok: response.ok && json?.ok !== false,
      error: typeof json?.error === "string" ? json.error : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch_failed" };
  }
}
