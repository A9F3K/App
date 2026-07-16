/** WebRTC SDP helpers for Telegram group voice calls (tgcalls-compatible). */

/**
 * WebRTC SSRCs are uint32; TDLib `groupCallJoinParameters.audio_source_id` is int32.
 * Values above 2^31-1 must be reinterpreted as signed (e.g. 2183894950 → -2111072346).
 */
export function telegramInt32AudioSourceId(ssrc: number): number {
  return Number(ssrc) | 0;
}

/**
 * Normalize a Telegram group_call_id from API / cache / TDLib JSON.
 * Rejects booleans: `Number(true) === 1`, which previously leaked as a fake call id.
 */
export function normalizeTelegramGroupCallId(value: unknown): number | null {
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.trunc(n);
  }
  return null;
}

export type TelegramGroupCallFingerprint = {
  hash: string;
  fingerprint: string;
  setup?: string;
};

export type TelegramGroupCallCandidate = {
  generation: string;
  component: string;
  protocol: string;
  port: string;
  ip: string;
  foundation: string;
  id: string;
  priority: string;
  type: string;
  network: string;
};

export type TelegramGroupCallTransport = {
  ufrag: string;
  pwd: string;
  fingerprints: TelegramGroupCallFingerprint[];
  candidates: TelegramGroupCallCandidate[];
};

export type ParsedGroupCallOfferSdp = {
  fingerprint: string | null;
  hash: string | null;
  setup: string | null;
  pwd: string | null;
  ufrag: string | null;
  source: number | null;
  sourceGroup: number[] | null;
};

export function parseGroupCallOfferSdp(sdp: string): ParsedGroupCallOfferSdp {
  const lines = sdp.split("\r\n");
  const lookup = (prefix: string) => {
    for (const line of lines) {
      if (line.startsWith(prefix)) return line.slice(prefix.length);
    }
    return null;
  };
  const rawSource = lookup("a=ssrc:");
  const rawSourceGroup = lookup("a=ssrc-group:FID ");
  const fingerprintLine = lookup("a=fingerprint:");
  const sourceRaw = rawSource ? Number(rawSource.split(" ")[0]) : NaN;
  return {
    fingerprint: fingerprintLine?.split(" ")[1] ?? null,
    hash: fingerprintLine?.split(" ")[0] ?? null,
    setup: lookup("a=setup:"),
    pwd: lookup("a=ice-pwd:"),
    ufrag: lookup("a=ice-ufrag:"),
    source: Number.isFinite(sourceRaw) ? telegramInt32AudioSourceId(sourceRaw) : null,
    sourceGroup: rawSourceGroup
      ? rawSourceGroup.split(" ").map((part) => telegramInt32AudioSourceId(Number(part)))
      : null,
  };
}

export function buildGroupCallJoinPayloadJson(parsed: ParsedGroupCallOfferSdp): string | null {
  if (
    !parsed.ufrag ||
    !parsed.pwd ||
    !parsed.hash ||
    !parsed.fingerprint ||
    parsed.source == null ||
    !parsed.sourceGroup?.length
  ) {
    return null;
  }
  return JSON.stringify({
    ufrag: parsed.ufrag,
    pwd: parsed.pwd,
    fingerprints: [
      {
        hash: parsed.hash,
        setup: parsed.setup ?? "active",
        fingerprint: parsed.fingerprint,
      },
    ],
    ssrc: parsed.source,
    "ssrc-groups": [
      {
        semantics: "FID",
        sources: parsed.sourceGroup,
      },
    ],
  });
}

export function parseGroupCallJoinTransport(joinPayload: string): TelegramGroupCallTransport | null {
  const trimmed = joinPayload.trim();
  if (!trimmed) return null;
  try {
    const root = JSON.parse(trimmed) as {
      stream?: boolean;
      transport?: TelegramGroupCallTransport;
      ufrag?: string;
      pwd?: string;
      fingerprints?: TelegramGroupCallFingerprint[];
      candidates?: TelegramGroupCallCandidate[];
    };
    // Broadcast/stream-mode calls are not WebRTC playable in-browser yet.
    if (root.stream) return null;
    const transport =
      root.transport && typeof root.transport === "object" ? root.transport : root;
    if (
      typeof transport.ufrag !== "string" ||
      typeof transport.pwd !== "string" ||
      !Array.isArray(transport.fingerprints) ||
      !Array.isArray(transport.candidates)
    ) {
      return null;
    }
    return {
      ufrag: transport.ufrag,
      pwd: transport.pwd,
      fingerprints: transport.fingerprints,
      candidates: transport.candidates,
    };
  } catch {
    return null;
  }
}

class SdpBuilder {
  private lines: string[] = [];
  private newLine: string[] = [];

  join(): string {
    return this.lines.join("\n");
  }

  finalize(): string {
    return `${this.join()}\n`;
  }

  add(line: string): void {
    this.lines.push(line);
  }

  push(word: string): void {
    this.newLine.push(word);
  }

  addJoined(separator = ""): void {
    this.add(this.newLine.join(separator));
    this.newLine = [];
  }

  addCandidate(c: TelegramGroupCallCandidate): void {
    const protocol = String(c.protocol || "udp").toUpperCase();
    this.push("a=candidate:");
    this.push(
      `${c.foundation} ${c.component} ${protocol} ${c.priority} ${c.ip} ${c.port} typ ${c.type}`,
    );
    this.push(` generation ${c.generation}`);
    this.addJoined();
  }

  addHeader(sessionId: number): void {
    this.add("v=0");
    this.add(`o=- ${sessionId} 2 IN IP4 0.0.0.0`);
    this.add("s=-");
    this.add("t=0 0");
    this.add("a=group:BUNDLE 0 1");
    this.add("a=ice-lite");
  }

  addTransport(transport: TelegramGroupCallTransport): void {
    this.add(`a=ice-ufrag:${transport.ufrag}`);
    this.add(`a=ice-pwd:${transport.pwd}`);
    for (const fingerprint of transport.fingerprints) {
      const setup = fingerprint.setup?.trim() || "passive";
      this.add(`a=fingerprint:${fingerprint.hash} ${fingerprint.fingerprint}`);
      this.add(`a=setup:${setup}`);
    }
    for (const candidate of transport.candidates) {
      this.addCandidate(candidate);
    }
  }

  addSsrcEntry(
    transport: TelegramGroupCallTransport,
    mediaProfile: "UDP/TLS/RTP/SAVPF" | "RTP/SAVPF",
  ): void {
    // sendrecv is required so the SFU can deliver remote participant audio
    // (tgcalls recvonly is for send-only bots).
    this.add(`m=audio 9 ${mediaProfile} 111 126`);
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=mid:0");
    this.add("a=sendrecv");
    this.addTransport(transport);
    this.add("a=rtpmap:111 opus/48000/2");
    this.add("a=rtpmap:126 telephone-event/8000");
    this.add("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1");
    this.add("a=rtcp-mux");
    this.add("a=rtcp-fb:111 transport-cc");
    this.add("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level");

    this.add(`m=video 9 ${mediaProfile} 100 101 102 103`);
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=mid:1");
    this.add("a=sendrecv");
    this.addTransport(transport);
    this.add("a=rtpmap:100 VP8/90000");
    this.add("a=fmtp:100 x-google-start-bitrate=800");
    this.add("a=rtcp-fb:100 goog-remb");
    this.add("a=rtcp-fb:100 transport-cc");
    this.add("a=rtcp-fb:100 ccm fir");
    this.add("a=rtcp-fb:100 nack");
    this.add("a=rtcp-fb:100 nack pli");
    this.add("a=rtpmap:101 rtx/90000");
    this.add("a=fmtp:101 apt=100");
    this.add("a=rtpmap:102 VP9/90000");
    this.add("a=rtcp-fb:102 goog-remb");
    this.add("a=rtcp-fb:102 transport-cc");
    this.add("a=rtcp-fb:102 ccm fir");
    this.add("a=rtcp-fb:102 nack");
    this.add("a=rtcp-fb:102 nack pli");
    this.add("a=rtpmap:103 rtx/90000");
    this.add("a=fmtp:103 apt=102");
    this.add("a=rtcp-mux");
  }

  addConference(
    sessionId: number,
    transport: TelegramGroupCallTransport,
    mediaProfile: "UDP/TLS/RTP/SAVPF" | "RTP/SAVPF",
  ): void {
    this.addHeader(sessionId);
    this.addSsrcEntry(transport, mediaProfile);
  }
}

export function groupCallAnswerSdpFromTransport(
  transport: TelegramGroupCallTransport,
  offerSdp?: string,
): string {
  const mediaProfile: "UDP/TLS/RTP/SAVPF" | "RTP/SAVPF" =
    offerSdp && /m=audio \d+ RTP\/SAVPF/i.test(offerSdp) && !/UDP\/TLS\/RTP\/SAVPF/i.test(offerSdp)
      ? "RTP/SAVPF"
      : "UDP/TLS/RTP/SAVPF";
  const sdp = new SdpBuilder();
  sdp.addConference(Date.now(), transport, mediaProfile);
  return sdp.finalize();
}
