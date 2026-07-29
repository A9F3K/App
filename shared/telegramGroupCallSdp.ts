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
 * Rejects booleans (`Number(true) === 1`) — never coerce them to a call id.
 * Real TDLib ids can be `1`; do not treat that as bogus.
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

/** One `a=ssrc-group` for a remote participant's video (SIM / FID semantics). */
export type TelegramGroupCallVideoSsrcGroup = {
  semantics: string;
  /** Signed int32 ids from TDLib — reinterpreted as uint32 for SDP. */
  sourceIds: number[];
};

/**
 * A remote video source (camera or screencast) to receive. `null` slots render
 * an inactive m-line so the answer keeps matching the offer's transceivers.
 */
export type TelegramGroupCallRemoteVideoSection = {
  endpointId: string;
  ssrcGroups: TelegramGroupCallVideoSsrcGroup[];
} | null;

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
    parsed.source == null
  ) {
    return null;
  }
  const payload: Record<string, unknown> = {
    ufrag: parsed.ufrag,
    pwd: parsed.pwd,
    fingerprints: [
      {
        hash: parsed.hash,
        // Browser is DTLS server (passive); Telegram SFU is DTLS client (active).
        // Matches tweb/tdesktop — client-active breaks DTLS on modern Chrome.
        setup: "passive",
        fingerprint: parsed.fingerprint,
      },
    ],
    ssrc: parsed.source,
  };
  // FID is present when the offer includes a video m-line. Listen-only audio
  // offers may omit it — TDLib still accepts the join for receive audio.
  if (parsed.sourceGroup && parsed.sourceGroup.length > 0) {
    payload["ssrc-groups"] = [
      {
        semantics: "FID",
        sources: parsed.sourceGroup,
      },
    ];
  }
  return JSON.stringify(payload);
}

/** DTLS setup for the remote answer SDP (we create the offer in-browser). */
export function groupCallAnswerDtlsSetup(offerSdp?: string): "active" | "passive" {
  if (!offerSdp) return "active";
  const offerSetup =
    offerSdp.match(/^a=setup:(\S+)/m)?.[1]?.trim().toLowerCase() ?? "";
  if (offerSetup === "active") return "passive";
  // actpass | passive | missing — SFU drives DTLS (answer is active).
  return "active";
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
    return this.lines.join("\r\n");
  }

  finalize(): string {
    return `${this.join()}\r\n`;
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

  addHeader(sessionId: number, mids: string[]): void {
    this.add("v=0");
    this.add(`o=- ${sessionId} 2 IN IP4 0.0.0.0`);
    this.add("s=-");
    this.add("t=0 0");
    this.add("a=extmap-allow-mixed");
    this.add(`a=group:BUNDLE ${mids.join(" ")}`);
    // Telegram's SFU is an ICE-lite peer: it only answers connectivity checks and
    // never initiates them. Declaring ice-lite in the remote (answer) description
    // makes Chrome the sole controlling agent, nominate the single pair immediately,
    // and skip the RFC 7675 consent-freshness handshake the SFU cannot satisfy.
    // Without it Chrome connects, receives a little audio, then tears the pair down
    // (pairsSucceeded=0 pairsInProgress=1 → disconnected → failed).
    this.add("a=ice-lite");
    this.add("a=ice-options:trickle");
    this.add("a=msid-semantic:WMS *");
  }

  addTransport(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive",
    opts?: { includeCandidates?: boolean },
  ): void {
    this.add(`a=ice-ufrag:${transport.ufrag}`);
    this.add(`a=ice-pwd:${transport.pwd}`);
    for (const fingerprint of transport.fingerprints) {
      this.add(`a=fingerprint:${fingerprint.hash} ${fingerprint.fingerprint}`);
      // Answer DTLS role: SFU is active (ClientHello). Ignore Telegram's
      // fingerprint.setup if present — some payloads echo our join "passive"
      // and that would leave both peers as DTLS servers (no media).
      this.add(`a=setup:${dtlsSetup}`);
    }
    if (opts?.includeCandidates !== false) {
      for (const candidate of transport.candidates) {
        // Prefer IPv4 — broken IPv6 routes often stall ICE to Telegram SFU.
        if (candidate.ip.includes(":")) continue;
        this.addCandidate(candidate);
      }
    }
  }

  private addVideoRtpMaps(): void {
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
  }

  /** Browser-compatible answer (UDP/TLS/RTP/SAVPF, port 9, sendrecv). */
  addSsrcEntry(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" = "active",
    mids: [string, string] = ["0", "1"],
    opts?: {
      minimalVideo?: boolean;
      /**
       * Presentation (screen-share) offers are sendonly — the answer must be
       * recvonly or Chrome rejects with "Incompatible receive direction".
       */
      presentation?: boolean;
    },
  ): void {
    const audioDir = opts?.presentation ? "recvonly" : "sendrecv";
    const videoDir = opts?.presentation ? "recvonly" : "sendrecv";
    this.add("m=audio 9 UDP/TLS/RTP/SAVPF 111 126");
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-mux");
    this.add(`a=mid:${mids[0]}`);
    this.add(`a=${audioDir}`);
    this.addTransport(transport, dtlsSetup, { includeCandidates: true });
    this.add("a=rtpmap:111 opus/48000/2");
    this.add("a=rtpmap:126 telephone-event/8000");
    // Omit usedtx=1 — DTX suppresses our near-silent listen-only sender and the
    // SFU often withholds mixed inbound audio (inboundPackets=0, remoteMuted).
    this.add("a=fmtp:111 minptime=10;useinbandfec=1");
    this.add("a=rtcp-fb:111 transport-cc");
    this.add("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level");

    // Slim VP8-only video keeps setRemoteDescription cheap. telegram-tt's SFU
    // answer uses recvonly for the main video mid (not inactive) — inactive
    // mismatched a black placeholder track and starved remote audio demux.
    if (opts?.minimalVideo) {
      this.add("m=video 9 UDP/TLS/RTP/SAVPF 100");
      this.add("c=IN IP4 0.0.0.0");
      this.add("a=rtcp:9 IN IP4 0.0.0.0");
      this.add("a=rtcp-mux");
      this.add(`a=mid:${mids[1]}`);
      this.add("a=recvonly");
      this.addTransport(transport, dtlsSetup, { includeCandidates: false });
      this.add("a=rtpmap:100 VP8/90000");
      return;
    }

    this.add("m=video 9 UDP/TLS/RTP/SAVPF 100 101 102 103");
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-mux");
    this.add(`a=mid:${mids[1]}`);
    this.add(`a=${videoDir}`);
    this.addTransport(transport, dtlsSetup, { includeCandidates: false });
    this.addVideoRtpMaps();
  }

  /**
   * Per-participant receive-only video section (camera or screencast). Declaring
   * the publisher's SSRC groups here is what makes the SFU-forwarded RTP demux
   * into an `ontrack` video — without them the browser drops the packets.
   */
  addRemoteVideoSection(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive",
    mid: string,
    section: TelegramGroupCallRemoteVideoSection,
  ): void {
    this.add("m=video 9 UDP/TLS/RTP/SAVPF 100 101 102 103");
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-mux");
    this.add(`a=mid:${mid}`);
    if (!section || section.ssrcGroups.length === 0) {
      // Keep the m-line count in sync with the offer, but park the slot.
      this.add("a=inactive");
      this.addTransport(transport, dtlsSetup, { includeCandidates: false });
      this.addVideoRtpMaps();
      return;
    }
    // Answer perspective: the SFU sends this video to us.
    this.add("a=sendonly");
    this.add("a=bundle-only");
    this.addTransport(transport, dtlsSetup, { includeCandidates: false });
    this.addVideoRtpMaps();
    const endpoint = section.endpointId || `video-${mid}`;
    const seen = new Set<number>();
    for (const group of section.ssrcGroups) {
      const ssrcs = group.sourceIds.map((id) => id >>> 0);
      if (ssrcs.length === 0) continue;
      this.add(`a=ssrc-group:${group.semantics} ${ssrcs.join(" ")}`);
      for (const ssrc of ssrcs) {
        if (seen.has(ssrc)) continue;
        seen.add(ssrc);
        this.add(`a=ssrc:${ssrc} cname:${endpoint}`);
        // msid = endpointId so the client can map ontrack streams to a
        // participant's camera vs screencast by MediaStream id.
        this.add(`a=ssrc:${ssrc} msid:${endpoint} ${endpoint}`);
        this.add(`a=ssrc:${ssrc} mslabel:${endpoint}`);
        this.add(`a=ssrc:${ssrc} label:${endpoint}`);
      }
    }
  }

  addConference(
    sessionId: number,
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive",
    mids: string[],
    remoteVideoSections: TelegramGroupCallRemoteVideoSection[],
    opts?: { minimalVideo?: boolean; presentation?: boolean },
  ): void {
    this.addHeader(sessionId, mids);
    this.addSsrcEntry(transport, dtlsSetup, [mids[0] ?? "0", mids[1] ?? "1"], {
      minimalVideo: Boolean(opts?.minimalVideo) && remoteVideoSections.length === 0,
      presentation: Boolean(opts?.presentation),
    });
    for (let i = 0; i < remoteVideoSections.length; i += 1) {
      const mid = mids[2 + i] ?? String(2 + i);
      this.addRemoteVideoSection(transport, dtlsSetup, mid, remoteVideoSections[i] ?? null);
    }
  }
}

/** Mids in m-line order from an SDP (offer) — used to mirror them in the answer. */
export function parseSdpMids(sdp: string): string[] {
  const mids: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=mid:")) mids.push(line.slice("a=mid:".length).trim());
  }
  return mids;
}

export function groupCallAnswerSdpFromTransport(
  transport: TelegramGroupCallTransport,
  offerSdp?: string,
  remoteVideoSections: TelegramGroupCallRemoteVideoSection[] = [],
  opts?: { minimalVideo?: boolean; presentation?: boolean },
): string {
  const sdp = new SdpBuilder();
  // Browser offered actpass/passive → answer must be active so SFU drives DTLS.
  const dtlsSetup = groupCallAnswerDtlsSetup(offerSdp);
  const offerMids = offerSdp ? parseSdpMids(offerSdp) : [];
  // The answer must have exactly as many m-lines as the offer. Slots beyond the
  // provided sections render inactive; sections beyond the offer are dropped.
  const extraCount =
    offerMids.length >= 2 ? Math.max(0, offerMids.length - 2) : remoteVideoSections.length;
  const sections: TelegramGroupCallRemoteVideoSection[] = [];
  for (let i = 0; i < extraCount; i += 1) {
    sections.push(remoteVideoSections[i] ?? null);
  }
  const mids =
    offerMids.length >= 2
      ? offerMids
      : ["0", "1", ...sections.map((_, i) => String(2 + i))];
  sdp.addConference(Date.now(), transport, dtlsSetup, mids, sections, {
    minimalVideo: Boolean(opts?.minimalVideo),
    presentation: Boolean(opts?.presentation),
  });
  return sdp.finalize();
}
