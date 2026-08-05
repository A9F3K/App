import { createHmac, timingSafeEqual } from "crypto";
import { getGatewaySecret } from "./env.js";

export type GatewayStreamKind =
  | "chats"
  | "history"
  | "voice_participants"
  | "voice_messages"
  | "private_call_audio"
  | "private_call_video";

export type StreamTicketPayload = {
  v: 1;
  sub: string;
  stream: GatewayStreamKind;
  chatId?: number;
  groupCallId?: number;
  callId?: number;
  iat: number;
  exp: number;
};

/** Ticket only needs to survive EventSource open + rare mint lag. */
export const STREAM_TICKET_TTL_SEC = 120;

const STREAM_KINDS = new Set<GatewayStreamKind>([
  "chats",
  "history",
  "voice_participants",
  "voice_messages",
  "private_call_audio",
  "private_call_video",
]);

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(raw: string): Buffer {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function signingKey(): Buffer {
  return Buffer.from(getGatewaySecret(), "utf8");
}

function signPayloadJson(payloadJson: string): string {
  return b64urlEncode(createHmac("sha256", signingKey()).update(payloadJson).digest());
}

export function isGatewayStreamKind(value: unknown): value is GatewayStreamKind {
  return typeof value === "string" && STREAM_KINDS.has(value as GatewayStreamKind);
}

export function mintStreamTicket(input: {
  telegramUsername: string;
  stream: GatewayStreamKind;
  chatId?: number | null;
  groupCallId?: number | null;
  callId?: number | null;
  ttlSec?: number;
  nowSec?: number;
}): { token: string; expiresAt: number; payload: StreamTicketPayload } {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = Math.max(30, Math.min(input.ttlSec ?? STREAM_TICKET_TTL_SEC, 600));
  const payload: StreamTicketPayload = {
    v: 1,
    sub: input.telegramUsername.trim(),
    stream: input.stream,
    iat: now,
    exp: now + ttl,
  };
  if (
    input.chatId != null &&
    Number.isFinite(input.chatId) &&
    input.chatId !== 0
  ) {
    payload.chatId = Math.trunc(input.chatId);
  }
  if (
    input.groupCallId != null &&
    Number.isFinite(input.groupCallId) &&
    input.groupCallId > 0
  ) {
    payload.groupCallId = Math.trunc(input.groupCallId);
  }
  if (
    input.callId != null &&
    Number.isFinite(input.callId) &&
    input.callId > 0
  ) {
    payload.callId = Math.trunc(input.callId);
  }
  const payloadJson = JSON.stringify(payload);
  const token = `${b64urlEncode(payloadJson)}.${signPayloadJson(payloadJson)}`;
  return { token, expiresAt: payload.exp, payload };
}

export function verifyStreamTicket(
  token: string,
  expected: {
    stream: GatewayStreamKind;
    chatId?: number | null;
    groupCallId?: number | null;
    callId?: number | null;
    nowSec?: number;
  },
): StreamTicketPayload | null {
  const trimmed = token.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return null;
  let payloadJson: string;
  let givenSig: Buffer;
  try {
    payloadJson = b64urlDecode(trimmed.slice(0, dot)).toString("utf8");
    givenSig = b64urlDecode(trimmed.slice(dot + 1));
  } catch {
    return null;
  }
  const expectedSig = createHmac("sha256", signingKey()).update(payloadJson).digest();
  if (
    givenSig.length !== expectedSig.length ||
    !timingSafeEqual(givenSig, expectedSig)
  ) {
    return null;
  }
  let payload: StreamTicketPayload;
  try {
    payload = JSON.parse(payloadJson) as StreamTicketPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (typeof payload.sub !== "string" || !payload.sub.trim()) return null;
  if (!isGatewayStreamKind(payload.stream) || payload.stream !== expected.stream) {
    return null;
  }
  const now = expected.nowSec ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.iat !== "number" || payload.iat > now + 30) return null;

  if (expected.stream === "history" || expected.stream === "voice_participants" || expected.stream === "voice_messages") {
    const expectedChat =
      expected.chatId != null && Number.isFinite(expected.chatId)
        ? Math.trunc(expected.chatId)
        : null;
    if (expectedChat == null || expectedChat === 0) return null;
    if (payload.chatId !== expectedChat) return null;
  }

  if (expected.stream === "private_call_audio" || expected.stream === "private_call_video") {
    const expectedCall =
      expected.callId != null && Number.isFinite(expected.callId)
        ? Math.trunc(expected.callId)
        : null;
    if (expectedCall == null || expectedCall <= 0) return null;
    if (payload.callId !== expectedCall) return null;
  }

  return {
    ...payload,
    sub: payload.sub.trim(),
  };
}

export function gatewayStreamPathForKind(stream: GatewayStreamKind): string {
  switch (stream) {
    case "chats":
      return "/v1/chats/stream";
    case "history":
      return "/v1/chat/messages/stream";
    case "voice_participants":
      return "/v1/chat/voice/participants/stream";
    case "voice_messages":
      return "/v1/chat/voice/messages/stream";
    case "private_call_audio":
      return "/v1/call/audio/stream";
    case "private_call_video":
      return "/v1/call/video/stream";
  }
}

export function gatewayStreamKindForPath(pathname: string): GatewayStreamKind | null {
  switch (pathname) {
    case "/v1/chats/stream":
      return "chats";
    case "/v1/chat/messages/stream":
      return "history";
    case "/v1/chat/voice/participants/stream":
      return "voice_participants";
    case "/v1/chat/voice/messages/stream":
      return "voice_messages";
    case "/v1/call/audio/stream":
      return "private_call_audio";
    case "/v1/call/video/stream":
      return "private_call_video";
    default:
      return null;
  }
}

/** Convert gateway HTTP(S) base URL to WebSocket URL. */
export function gatewayHttpToWebSocketUrl(httpUrl: string): string {
  const trimmed = httpUrl.trim();
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed;
}
