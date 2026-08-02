import { buildApiUrl } from "../../api/_base";

export type GatewayStreamKind =
  | "chats"
  | "history"
  | "voice_participants"
  | "voice_messages";

export type MintTelegramGatewayStreamTicketResult =
  | {
      ok: true;
      url: string;
      expiresAt: number;
      gatewayBaseUrl: string;
    }
  | { ok: false; error: string };

/** Short-lived SSE ticket from Vercel — browser opens EventSource on the gateway. */
export async function mintTelegramGatewayStreamTicket(input: {
  stream: GatewayStreamKind;
  chatId?: number | null;
  groupCallId?: number | null;
  sinceRevision?: number | null;
  signal?: AbortSignal;
}): Promise<MintTelegramGatewayStreamTicketResult> {
  const params = new URLSearchParams({ stream: input.stream });
  if (input.chatId != null && Number.isFinite(input.chatId) && input.chatId !== 0) {
    params.set("chat_id", String(Math.trunc(input.chatId)));
  }
  if (
    input.groupCallId != null &&
    Number.isFinite(input.groupCallId) &&
    input.groupCallId > 0
  ) {
    params.set("group_call_id", String(Math.trunc(input.groupCallId)));
  }
  if (
    input.sinceRevision != null &&
    Number.isFinite(input.sinceRevision) &&
    input.sinceRevision > 0
  ) {
    params.set("since_revision", String(Math.trunc(input.sinceRevision)));
  }
  try {
    const response = await fetch(
      buildApiUrl(`/api/telegram-messages-stream-ticket?${params.toString()}`),
      { method: "GET", credentials: "include", signal: input.signal },
    );
    const json = (await response.json().catch(() => null)) as
      | {
          ok?: boolean;
          url?: string;
          expiresAt?: number;
          gatewayBaseUrl?: string;
          error?: string;
        }
      | null;
    if (!response.ok || !json?.ok || typeof json.url !== "string" || !json.url) {
      return { ok: false, error: json?.error ?? "stream_ticket_unavailable" };
    }
    return {
      ok: true,
      url: json.url,
      expiresAt: typeof json.expiresAt === "number" ? json.expiresAt : 0,
      gatewayBaseUrl:
        typeof json.gatewayBaseUrl === "string" ? json.gatewayBaseUrl : "",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "aborted" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "stream_ticket_failed",
    };
  }
}

/**
 * Prefer direct gateway SSE (ticket). Fall back to same-origin Vercel proxy so
 * local/dev keeps working when no public gateway URL is configured.
 */
export async function resolveTelegramLiveStreamUrl(input: {
  stream: GatewayStreamKind;
  proxyPath: string;
  chatId?: number | null;
  groupCallId?: number | null;
  sinceRevision?: number | null;
  signal?: AbortSignal;
}): Promise<{ url: string; mode: "gateway" | "proxy" }> {
  const ticket = await mintTelegramGatewayStreamTicket({
    stream: input.stream,
    chatId: input.chatId,
    groupCallId: input.groupCallId,
    sinceRevision: input.sinceRevision,
    signal: input.signal,
  });
  if (ticket.ok) {
    return { url: ticket.url, mode: "gateway" };
  }
  return { url: buildApiUrl(input.proxyPath), mode: "proxy" };
}
