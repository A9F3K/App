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

/** Codec line from Telegram SFU join payload (`video.payload-types`). */
export type TelegramGroupCallPayloadType = {
  id: number;
  name: string;
  clockrate: number;
  channels?: number;
  parameters?: Record<string, string | number>;
  "rtcp-fbs"?: Array<{ type: string; subtype?: string }>;
};

export type TelegramGroupCallRtpExtension = {
  id: number;
  uri: string;
};

/** SFU RTP carries the sender's MID; negotiating MID on video demuxes packets away. */
const RTP_MID_EXTENSION_URI = "urn:ietf:params:rtp-hdrext:sdes:mid";

function isRtpMidExtensionUri(uri: string): boolean {
  return uri.trim().toLowerCase() === RTP_MID_EXTENSION_URI;
}

function filterVideoRtpExtensions(
  extensions?: TelegramGroupCallRtpExtension[],
): TelegramGroupCallRtpExtension[] {
  return (extensions ?? []).filter((ext) => !isRtpMidExtensionUri(ext.uri));
}

/** Drop MID extmap lines copied from a browser offer (see GroupInstanceReferenceImpl). */
function filterOfferVideoCodecLines(lines: string[]): string[] {
  return lines.filter((line) => {
    if (!line.startsWith("a=extmap:")) return true;
    const uri = line.replace(/^a=extmap:\S+\s+/, "").trim();
    return !isRtpMidExtensionUri(uri);
  });
}

/**
 * Join response media params. Screencast RTP uses these payload-type ids — if the
 * answer only advertises VP8/VP9, inbound packets arrive but framesDecoded stays 0
 * (black <video>).
 */
export type ParsedGroupCallJoin = {
  transport: TelegramGroupCallTransport;
  videoPayloadTypes: TelegramGroupCallPayloadType[];
  videoExtensions: TelegramGroupCallRtpExtension[];
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

function parseJoinPayloadTypes(raw: unknown): TelegramGroupCallPayloadType[] {
  if (!Array.isArray(raw)) return [];
  const out: TelegramGroupCallPayloadType[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.id);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const clockrate = Number(row.clockrate);
    if (!Number.isFinite(id) || !name || !Number.isFinite(clockrate)) continue;
    const channelsRaw = Number(row.channels);
    const parameters =
      row.parameters && typeof row.parameters === "object" && !Array.isArray(row.parameters)
        ? (row.parameters as Record<string, string | number>)
        : undefined;
    const feedbackRaw = row["rtcp-fbs"];
    const feedback = Array.isArray(feedbackRaw)
      ? feedbackRaw
          .map((fb) => {
            if (!fb || typeof fb !== "object" || Array.isArray(fb)) return null;
            const f = fb as Record<string, unknown>;
            const type = typeof f.type === "string" ? f.type.trim() : "";
            if (!type) return null;
            const subtype =
              typeof f.subtype === "string" && f.subtype.trim()
                ? f.subtype.trim()
                : undefined;
            return subtype ? { type, subtype } : { type };
          })
          .filter((fb): fb is { type: string; subtype?: string } => fb != null)
      : undefined;
    const parsed: TelegramGroupCallPayloadType = {
      id: Math.trunc(id),
      name,
      clockrate: Math.trunc(clockrate),
    };
    if (Number.isFinite(channelsRaw) && channelsRaw > 0) {
      parsed.channels = Math.trunc(channelsRaw);
    }
    if (parameters) parsed.parameters = parameters;
    if (feedback && feedback.length > 0) parsed["rtcp-fbs"] = feedback;
    out.push(parsed);
  }
  return out;
}

function parseJoinRtpExtensions(raw: unknown): TelegramGroupCallRtpExtension[] {
  if (!Array.isArray(raw)) return [];
  const out: TelegramGroupCallRtpExtension[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.id);
    const uri = typeof row.uri === "string" ? row.uri.trim() : "";
    if (!Number.isFinite(id) || !uri) continue;
    out.push({ id: Math.trunc(id), uri });
  }
  return out;
}

export function parseGroupCallJoinTransport(
  joinPayload: string,
): ParsedGroupCallJoin | null {
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
      video?: {
        "payload-types"?: unknown;
        "rtp-hdrexts"?: unknown;
      };
      audio?: {
        "payload-types"?: unknown;
        "rtp-hdrexts"?: unknown;
      };
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
      transport: {
        ufrag: transport.ufrag,
        pwd: transport.pwd,
        fingerprints: transport.fingerprints,
        candidates: transport.candidates,
      },
      videoPayloadTypes: parseJoinPayloadTypes(root.video?.["payload-types"]),
      videoExtensions: parseJoinRtpExtensions(root.video?.["rtp-hdrexts"]),
    };
  } catch {
    return null;
  }
}

export type ParsedOfferMediaSection = {
  kind: "audio" | "video" | "application" | "unknown";
  mid: string;
  protocol?: string;
  formats?: string;
  sctpPort?: number;
  maxMessageSize?: number;
  /**
   * Codec / extension attribute lines from the offer m-section (rtpmap, fmtp,
   * rtcp-fb, extmap, rtcp-rsize, …). Renegotiate answers must reuse these so
   * payload-type ids match Chrome's offer — Telegram join PTs (100–105) often
   * differ on new recvonly mids and leave inboundVideoPackets=0.
   */
  codecLines?: string[];
  /**
   * Full m-section lines (`m=` … next `m=`), used to preserve the negotiated
   * audio mid across video-subscribe offers so inbound mix RTP does not reset.
   */
  rawLines?: string[];
};

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
    dtlsSetup: "active" | "passive" | "actpass",
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

  private addVideoPayloadType(payloadType: TelegramGroupCallPayloadType): void {
    const channels =
      payloadType.channels && payloadType.channels > 0
        ? `/${payloadType.channels}`
        : "";
    this.add(
      `a=rtpmap:${payloadType.id} ${payloadType.name}/${payloadType.clockrate}${channels}`,
    );
    if (payloadType.parameters && Object.keys(payloadType.parameters).length > 0) {
      const parametersString = Object.entries(payloadType.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(";");
      this.add(`a=fmtp:${payloadType.id} ${parametersString}`);
    }
    for (const fb of payloadType["rtcp-fbs"] ?? []) {
      this.add(
        `a=rtcp-fb:${payloadType.id} ${fb.type}${fb.subtype ? ` ${fb.subtype}` : ""}`,
      );
    }
  }

  private addVideoRtpMaps(
    payloadTypes?: TelegramGroupCallPayloadType[],
    extensions?: TelegramGroupCallRtpExtension[],
  ): void {
    if (payloadTypes && payloadTypes.length > 0) {
      for (const payloadType of payloadTypes) {
        this.addVideoPayloadType(payloadType);
      }
      for (const extension of filterVideoRtpExtensions(extensions)) {
        this.add(`a=extmap:${extension.id} ${extension.uri}`);
      }
      return;
    }
    // Fallback when join payload omitted video codecs (should be rare).
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
    // H264 — Telegram mobile/desktop screencasts often publish this; VP8-only
    // answers demux RTP (unmute + packets) but never decode (black stage).
    this.add("a=rtpmap:104 H264/90000");
    this.add(
      "a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    );
    this.add("a=rtcp-fb:104 goog-remb");
    this.add("a=rtcp-fb:104 transport-cc");
    this.add("a=rtcp-fb:104 ccm fir");
    this.add("a=rtcp-fb:104 nack");
    this.add("a=rtcp-fb:104 nack pli");
    this.add("a=rtpmap:105 rtx/90000");
    this.add("a=fmtp:105 apt=104");
  }

  private videoPayloadTypeIds(
    payloadTypes?: TelegramGroupCallPayloadType[],
  ): string {
    if (payloadTypes && payloadTypes.length > 0) {
      return payloadTypes.map((p) => String(p.id)).join(" ");
    }
    return "100 101 102 103 104 105";
  }

  addMainAudioSection(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mid: string,
    opts?: { presentation?: boolean; includeCandidates?: boolean },
  ): void {
    const audioDir = opts?.presentation ? "recvonly" : "sendrecv";
    this.add("m=audio 9 UDP/TLS/RTP/SAVPF 111 126");
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-mux");
    this.add(`a=mid:${mid}`);
    this.add(`a=${audioDir}`);
    this.addTransport(transport, dtlsSetup, {
      includeCandidates: opts?.includeCandidates !== false,
    });
    this.add("a=rtpmap:111 opus/48000/2");
    this.add("a=rtpmap:126 telephone-event/8000");
    // Omit usedtx=1 — DTX suppresses our near-silent listen-only sender and the
    // SFU often withholds mixed inbound audio (inboundPackets=0, remoteMuted).
    this.add("a=fmtp:111 minptime=10;useinbandfec=1");
    this.add("a=rtcp-fb:111 transport-cc");
    this.add("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level");
  }

  /**
   * Reuse a previously negotiated audio m-section when crafting a video-subscribe
   * remote offer. Regenerating opus/ssrc/msid via addMainAudioSection used to
   * reset Chrome's audio receiver (inboundPackets froze after renegotiate).
   *
   * `stripSenderSsrcs` is only for a *local offer* template (our outbound SSRCs).
   * Join/SFU answer templates already carry mix SSRCs — stripping those freezes
   * inboundPackets and can starve screen/camera RTP on the same BUNDLE.
   */
  addPreservedAudioSection(
    rawLines: string[],
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mid: string,
    opts?: { includeCandidates?: boolean; stripSenderSsrcs?: boolean },
  ): boolean {
    const lines = rawLines.map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 || !lines[0]!.startsWith("m=audio")) return false;
    let sawMid = false;
    let transportPlaced = false;
    for (const line of lines) {
      if (
        line.startsWith("a=ice-ufrag:") ||
        line.startsWith("a=ice-pwd:") ||
        line.startsWith("a=fingerprint:") ||
        line.startsWith("a=setup:") ||
        line.startsWith("a=candidate:")
      ) {
        if (!transportPlaced) {
          this.addTransport(transport, dtlsSetup, {
            includeCandidates: opts?.includeCandidates !== false,
          });
          transportPlaced = true;
        }
        continue;
      }
      if (opts?.stripSenderSsrcs) {
        if (line.startsWith("a=ssrc:") || line.startsWith("a=ssrc-group:")) {
          continue;
        }
      }
      if (line.startsWith("a=mid:")) {
        this.add(`a=mid:${mid}`);
        sawMid = true;
        continue;
      }
      this.add(line);
    }
    if (!sawMid) this.add(`a=mid:${mid}`);
    if (!transportPlaced) {
      this.addTransport(transport, dtlsSetup, {
        includeCandidates: opts?.includeCandidates !== false,
      });
    }
    return true;
  }

  addMainVideoSection(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mid: string,
    opts?: {
      minimalVideo?: boolean;
      presentation?: boolean;
      videoPayloadTypes?: TelegramGroupCallPayloadType[];
      videoExtensions?: TelegramGroupCallRtpExtension[];
    },
  ): void {
    const videoDir = opts?.presentation ? "recvonly" : "sendrecv";
    // Slim VP8-only video keeps setRemoteDescription cheap. telegram-tt's SFU
    // answer uses recvonly for the main video mid (not inactive) — inactive
    // mismatched a black placeholder track and starved remote audio demux.
    if (opts?.minimalVideo) {
      this.add("m=video 9 UDP/TLS/RTP/SAVPF 100");
      this.add("c=IN IP4 0.0.0.0");
      this.add("a=rtcp:9 IN IP4 0.0.0.0");
      this.add("a=rtcp-mux");
      this.add(`a=mid:${mid}`);
      this.add("a=recvonly");
      this.addTransport(transport, dtlsSetup, { includeCandidates: false });
      this.add("a=rtpmap:100 VP8/90000");
      return;
    }

    const payloadIds = this.videoPayloadTypeIds(opts?.videoPayloadTypes);
    this.add(`m=video 9 UDP/TLS/RTP/SAVPF ${payloadIds}`);
    this.add("c=IN IP4 0.0.0.0");
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-mux");
    this.add(`a=mid:${mid}`);
    this.add(`a=${videoDir}`);
    this.addTransport(transport, dtlsSetup, { includeCandidates: false });
    this.addVideoRtpMaps(opts?.videoPayloadTypes, opts?.videoExtensions);
  }

  /**
   * Colibri / Telegram group-call data channel. Required so we can send
   * ReceiverVideoConstraints — without it the SFU never forwards screencast RTP.
   */
  addApplicationSection(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mid: string,
    offer?: ParsedOfferMediaSection | null,
  ): void {
    // Match telegram-tt buildSdp application m-line (port 1, mid after transport).
    // Crafted answers that diverge here leave RTCDataChannel stuck in "connecting"
    // and ReceiverVideoConstraints never reach the SFU.
    const sctpPort =
      offer?.sctpPort && Number.isFinite(offer.sctpPort) ? offer.sctpPort : 5000;
    const maxMessageSize =
      offer?.maxMessageSize && Number.isFinite(offer.maxMessageSize)
        ? offer.maxMessageSize
        : 262144;
    this.add("m=application 1 UDP/DTLS/SCTP webrtc-datachannel");
    this.add("c=IN IP4 0.0.0.0");
    this.addTransport(transport, dtlsSetup, { includeCandidates: false });
    this.add("a=ice-options:trickle");
    this.add(`a=mid:${mid}`);
    this.add(`a=sctp-port:${sctpPort}`);
    this.add(`a=max-message-size:${maxMessageSize}`);
  }

  /**
   * Per-participant receive-only video section (camera or screencast). Declaring
   * the publisher's SSRC groups here is what makes the SFU-forwarded RTP demux
   * into an `ontrack` video — without them the browser drops the packets.
   */
  addRemoteVideoSection(
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mid: string,
    section: TelegramGroupCallRemoteVideoSection,
    opts?: {
      videoPayloadTypes?: TelegramGroupCallPayloadType[];
      videoExtensions?: TelegramGroupCallRtpExtension[];
      /** Prefer offer codecs when answering a browser createOffer renegotiate. */
      offerSection?: ParsedOfferMediaSection | null;
      /**
       * telegram-tt remote *offers* use a=bundle-only on non-main video.
       * Join/renegotiate *answers* should leave this false.
       */
      bundleOnly?: boolean;
    },
  ): void {
    const offerFormats = opts?.offerSection?.formats?.trim();
    const offerCodecLines = opts?.offerSection?.codecLines ?? [];
    const useJoinCodecs = Boolean(opts?.videoPayloadTypes?.length);
    const useOfferCodecs =
      !useJoinCodecs && Boolean(offerFormats) && offerCodecLines.length > 0;
    const payloadIds = useJoinCodecs
      ? this.videoPayloadTypeIds(opts?.videoPayloadTypes)
      : useOfferCodecs
        ? offerFormats!
        : this.videoPayloadTypeIds(undefined);
    // telegram-tt remote *offers* use port 1 + RTP/SAVPF layout. Keep UDP/TLS
    // so m-line protocol stays compatible with Chrome's join offer/answer.
    this.add(`m=video 9 UDP/TLS/RTP/SAVPF ${payloadIds}`);
    this.add("c=IN IP4 0.0.0.0");
    this.add("b=AS:1300");
    this.add(`a=mid:${mid}`);
    this.add("a=rtcp-mux");
    // Codecs/extmaps before transport — matches telegram-tt addSsrcEntry order.
    if (useJoinCodecs) {
      this.addVideoRtpMaps(opts?.videoPayloadTypes, opts?.videoExtensions);
    } else if (useOfferCodecs) {
      for (const line of filterOfferVideoCodecLines(offerCodecLines)) {
        this.add(line);
      }
    } else {
      this.addVideoRtpMaps(opts?.videoPayloadTypes, opts?.videoExtensions);
    }
    this.add("a=rtcp:9 IN IP4 0.0.0.0");
    this.add("a=rtcp-rsize");
    if (!section || section.ssrcGroups.length === 0) {
      this.addTransport(transport, dtlsSetup, {
        includeCandidates: Boolean(opts?.bundleOnly),
      });
      this.add("a=inactive");
      return;
    }
    // telegram-tt: transport, then sendonly (+ bundle-only for remote offers).
    this.addTransport(transport, dtlsSetup, {
      includeCandidates: Boolean(opts?.bundleOnly),
    });
    this.add("a=sendonly");
    if (opts?.bundleOnly) {
      this.add("a=bundle-only");
    }
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

  /**
   * Mirror the browser offer m-line kinds. telegram-tt puts the SCTP datachannel
   * at mid 2 and remote video after it — if we treat every mid≥2 as video, the
   * screencast SSRCs land on the application m-line and inboundVideoPackets=0.
   */
  addConferenceFromOffer(
    sessionId: number,
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    offerSections: ParsedOfferMediaSection[],
    remoteVideoSections: TelegramGroupCallRemoteVideoSection[],
    opts?: {
      minimalVideo?: boolean;
      presentation?: boolean;
      videoPayloadTypes?: TelegramGroupCallPayloadType[];
      videoExtensions?: TelegramGroupCallRtpExtension[];
      /** When set, main video mid uses these instead of videoPayloadTypes. */
      mainVideoPayloadTypes?: TelegramGroupCallPayloadType[];
      mainVideoExtensions?: TelegramGroupCallRtpExtension[];
    },
  ): void {
    const mids = offerSections.map((section, index) => section.mid || String(index));
    this.addHeader(sessionId, mids);
    let mainAudioDone = false;
    let mainVideoDone = false;
    let remoteVideoIndex = 0;
    let candidatesPlaced = false;
    const useMinimalVideo =
      Boolean(opts?.minimalVideo) && remoteVideoSections.every((s) => !s);
    // Main mid keeps join codecs; extra recv slots prefer telegram join PTs so
    // H264 screencasts demux. Passing the same object to both rewrote main on
    // every renegotiate and could starve inbound audio/video.
    const mainVideoMedia =
      opts && "mainVideoPayloadTypes" in opts
        ? {
            videoPayloadTypes: opts.mainVideoPayloadTypes,
            videoExtensions: opts.mainVideoExtensions,
          }
        : {
            videoPayloadTypes: opts?.videoPayloadTypes,
            videoExtensions: opts?.videoExtensions,
          };
    const remoteVideoMedia = {
      videoPayloadTypes: opts?.videoPayloadTypes,
      videoExtensions: opts?.videoExtensions,
    };

    for (const offerSection of offerSections) {
      const mid = offerSection.mid || "0";
      if (offerSection.kind === "audio" && !mainAudioDone) {
        mainAudioDone = true;
        this.addMainAudioSection(transport, dtlsSetup, mid, {
          presentation: Boolean(opts?.presentation),
          includeCandidates: !candidatesPlaced,
        });
        candidatesPlaced = true;
        continue;
      }
      if (offerSection.kind === "video" && !mainVideoDone) {
        mainVideoDone = true;
        this.addMainVideoSection(transport, dtlsSetup, mid, {
          minimalVideo: useMinimalVideo,
          presentation: Boolean(opts?.presentation),
          ...mainVideoMedia,
        });
        continue;
      }
      if (offerSection.kind === "application") {
        this.addApplicationSection(transport, dtlsSetup, mid, offerSection);
        continue;
      }
      if (offerSection.kind === "video") {
        this.addRemoteVideoSection(
          transport,
          dtlsSetup,
          mid,
          remoteVideoSections[remoteVideoIndex] ?? null,
          { ...remoteVideoMedia, offerSection },
        );
        remoteVideoIndex += 1;
        continue;
      }
      // Unknown media — reject so m-line counts still match.
      this.add(`m=${offerSection.kind === "unknown" ? "application" : offerSection.kind} 0 ${offerSection.protocol || "UDP/DTLS/SCTP"} ${offerSection.formats || "webrtc-datachannel"}`);
      this.add("c=IN IP4 0.0.0.0");
      this.add(`a=mid:${mid}`);
      this.add("a=inactive");
    }
  }

  /** Fallback when the offer SDP is missing — audio + video only. */
  addConferenceLegacy(
    sessionId: number,
    transport: TelegramGroupCallTransport,
    dtlsSetup: "active" | "passive" | "actpass",
    mids: string[],
    remoteVideoSections: TelegramGroupCallRemoteVideoSection[],
    opts?: {
      minimalVideo?: boolean;
      presentation?: boolean;
      videoPayloadTypes?: TelegramGroupCallPayloadType[];
      videoExtensions?: TelegramGroupCallRtpExtension[];
    },
  ): void {
    const videoMedia = {
      videoPayloadTypes: opts?.videoPayloadTypes,
      videoExtensions: opts?.videoExtensions,
    };
    this.addHeader(sessionId, mids);
    this.addMainAudioSection(transport, dtlsSetup, mids[0] ?? "0", {
      presentation: Boolean(opts?.presentation),
      includeCandidates: true,
    });
    this.addMainVideoSection(transport, dtlsSetup, mids[1] ?? "1", {
      minimalVideo: Boolean(opts?.minimalVideo) && remoteVideoSections.length === 0,
      presentation: Boolean(opts?.presentation),
      ...videoMedia,
    });
    for (let i = 0; i < remoteVideoSections.length; i += 1) {
      const mid = mids[2 + i] ?? String(2 + i);
      this.addRemoteVideoSection(
        transport,
        dtlsSetup,
        mid,
        remoteVideoSections[i] ?? null,
        videoMedia,
      );
    }
  }
}

/** Mids in m-line order from an SDP (offer) — used to mirror them in the answer. */
export function parseSdpMids(sdp: string): string[] {
  return parseOfferMediaSections(sdp).map((section, index) => section.mid || String(index));
}

/** Offer m-lines with kind so answers can keep SCTP vs remote video distinct. */
export function parseOfferMediaSections(sdp: string): ParsedOfferMediaSection[] {
  const sections: ParsedOfferMediaSection[] = [];
  let current: ParsedOfferMediaSection | null = null;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      const parts = line.slice(2).split(/\s+/);
      const media = parts[0] ?? "unknown";
      const kind =
        media === "audio" || media === "video" || media === "application"
          ? media
          : "unknown";
      current = {
        kind,
        mid: "",
        protocol: parts[2],
        formats: parts.slice(3).join(" "),
        codecLines: [],
        rawLines: [line],
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.rawLines = current.rawLines ?? [];
    if (line) current.rawLines.push(line);
    if (line.startsWith("a=mid:")) {
      current.mid = line.slice("a=mid:".length).trim();
    } else if (line.startsWith("a=sctp-port:")) {
      const port = Number(line.slice("a=sctp-port:".length).trim());
      if (Number.isFinite(port)) current.sctpPort = port;
    } else if (line.startsWith("a=max-message-size:")) {
      const size = Number(line.slice("a=max-message-size:".length).trim());
      if (Number.isFinite(size)) current.maxMessageSize = size;
    } else if (
      line.startsWith("a=rtpmap:") ||
      line.startsWith("a=fmtp:") ||
      line.startsWith("a=rtcp-fb:") ||
      line.startsWith("a=extmap:") ||
      line === "a=rtcp-rsize"
    ) {
      current.codecLines = current.codecLines ?? [];
      current.codecLines.push(line);
    }
  }
  return sections;
}

export function groupCallAnswerSdpFromTransport(
  transport: TelegramGroupCallTransport,
  offerSdp?: string,
  remoteVideoSections: TelegramGroupCallRemoteVideoSection[] = [],
  opts?: {
    minimalVideo?: boolean;
    presentation?: boolean;
    videoPayloadTypes?: TelegramGroupCallPayloadType[];
    videoExtensions?: TelegramGroupCallRtpExtension[];
    mainVideoPayloadTypes?: TelegramGroupCallPayloadType[];
    mainVideoExtensions?: TelegramGroupCallRtpExtension[];
  },
): string {
  const sdp = new SdpBuilder();
  // Browser offered actpass/passive → answer must be active so SFU drives DTLS.
  const dtlsSetup = groupCallAnswerDtlsSetup(offerSdp);
  const offerSections = offerSdp ? parseOfferMediaSections(offerSdp) : [];
  const mediaOpts = {
    minimalVideo: Boolean(opts?.minimalVideo),
    presentation: Boolean(opts?.presentation),
    videoPayloadTypes: opts?.videoPayloadTypes,
    videoExtensions: opts?.videoExtensions,
    ...(opts && "mainVideoPayloadTypes" in opts
      ? {
          mainVideoPayloadTypes: opts.mainVideoPayloadTypes,
          mainVideoExtensions: opts.mainVideoExtensions,
        }
      : {}),
  };
  if (offerSections.length >= 2) {
    // Remote video sections map onto *extra* video m-lines only (after main
    // video). Application/SCTP m-lines are answered separately — never as video.
    const extraVideoCount = offerSections.filter((section, index, all) => {
      if (section.kind !== "video") return false;
      const firstVideo = all.findIndex((s) => s.kind === "video");
      return index !== firstVideo;
    }).length;
    const sections: TelegramGroupCallRemoteVideoSection[] = [];
    for (let i = 0; i < extraVideoCount; i += 1) {
      sections.push(remoteVideoSections[i] ?? null);
    }
    sdp.addConferenceFromOffer(
      Date.now(),
      transport,
      dtlsSetup,
      offerSections,
      sections,
      mediaOpts,
    );
    return sdp.finalize();
  }

  const offerMids = offerSdp ? parseSdpMids(offerSdp) : [];
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
  sdp.addConferenceLegacy(Date.now(), transport, dtlsSetup, mids, sections, mediaOpts);
  return sdp.finalize();
}

/** First `a=ssrc:` value in an m= section of the given kind (uint32). */
export function parsePrimarySsrcFromSdp(
  sdp: string,
  kind: "audio" | "video",
): number | null {
  let inSection = false;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      inSection = line.startsWith(`m=${kind} `);
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("a=ssrc:")) {
      const id = Number(line.slice("a=ssrc:".length).split(/\s+/)[0]);
      if (Number.isFinite(id)) return id >>> 0;
    }
  }
  return null;
}

/**
 * Rewrite *extra* video m-lines in a browser createOffer so their payload-type
 * ids match the Telegram join conference (typically 100–105). Without this,
 * Chrome assigns fresh PTs on recvonly slots while the SFU still sends with
 * join PTs — answer negotiation can succeed but inboundVideoPackets stays 0.
 */
export function mungeLocalOfferExtraVideoToJoinCodecs(
  offerSdp: string,
  videoPayloadTypes: TelegramGroupCallPayloadType[],
  videoExtensions: TelegramGroupCallRtpExtension[] = [],
): string {
  if (!videoPayloadTypes.length) return offerSdp;
  const payloadIds = videoPayloadTypes.map((p) => String(p.id)).join(" ");
  const codecBlock: string[] = [];
  for (const payloadType of videoPayloadTypes) {
    const channels =
      payloadType.channels != null && payloadType.channels > 1
        ? `/${payloadType.channels}`
        : "";
    codecBlock.push(
      `a=rtpmap:${payloadType.id} ${payloadType.name}/${payloadType.clockrate}${channels}`,
    );
    if (payloadType.parameters && Object.keys(payloadType.parameters).length > 0) {
      const parametersString = Object.entries(payloadType.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(";");
      codecBlock.push(`a=fmtp:${payloadType.id} ${parametersString}`);
    }
    for (const fb of payloadType["rtcp-fbs"] ?? []) {
      codecBlock.push(
        `a=rtcp-fb:${payloadType.id} ${fb.type}${fb.subtype ? ` ${fb.subtype}` : ""}`,
      );
    }
  }
    for (const extension of videoExtensions) {
      if (isRtpMidExtensionUri(extension.uri)) continue;
      codecBlock.push(`a=extmap:${extension.id} ${extension.uri}`);
    }

  const lines = offerSdp.split(/\r?\n/);
  const out: string[] = [];
  let videoIndex = 0;
  let inExtraVideo = false;
  let pendingCodecInject = false;

  const flushCodecs = () => {
    if (pendingCodecInject) {
      out.push(...codecBlock);
      pendingCodecInject = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("m=")) {
      flushCodecs();
      if (trimmed.startsWith("m=video ")) {
        videoIndex += 1;
        inExtraVideo = videoIndex >= 2;
        if (inExtraVideo) {
          const parts = trimmed.split(/\s+/);
          out.push(
            `m=video ${parts[1] ?? "9"} ${parts[2] ?? "UDP/TLS/RTP/SAVPF"} ${payloadIds}`,
          );
          pendingCodecInject = true;
          continue;
        }
      } else {
        inExtraVideo = false;
      }
      out.push(line);
      continue;
    }
    if (inExtraVideo) {
      if (
        trimmed.startsWith("a=rtpmap:") ||
        trimmed.startsWith("a=fmtp:") ||
        trimmed.startsWith("a=rtcp-fb:") ||
        trimmed.startsWith("a=extmap:") ||
        trimmed === "a=rtcp-rsize"
      ) {
        continue;
      }
      out.push(line);
      // Inject after DTLS setup (last transport attribute typically).
      if (pendingCodecInject && trimmed.startsWith("a=setup:")) {
        flushCodecs();
      }
      continue;
    }
    out.push(line);
  }
  flushCodecs();

  const endsWithBlank = offerSdp.endsWith("\r\n") || offerSdp.endsWith("\n");
  const body = out.join("\r\n");
  return endsWithBlank && !body.endsWith("\r\n") ? `${body}\r\n` : body;
}

/**
 * telegram-tt subscribe path: craft an SFU *offer* that declares remote camera/
 * screencast SSRCs, then the browser createAnswer()s. createOffer + fake answer
 * often left Colibri SCTP stuck in "connecting" (no ReceiverVideoConstraints).
 *
 * m-line order must match the current local description or setRemoteDescription fails.
 */
export function groupCallRemoteSubscribeOfferSdp(
  transport: TelegramGroupCallTransport,
  localSdp: string,
  remoteVideoSections: TelegramGroupCallRemoteVideoSection[],
  opts?: {
    videoPayloadTypes?: TelegramGroupCallPayloadType[];
    videoExtensions?: TelegramGroupCallRtpExtension[];
    audioSourceId?: number | null;
    /** True only when `localSdp` is our local join offer (client send SSRCs). */
    stripSenderSsrcs?: boolean;
  },
): string {
  const localSections = parseOfferMediaSections(localSdp);
  const videoMedia = {
    videoPayloadTypes: opts?.videoPayloadTypes,
    videoExtensions: opts?.videoExtensions,
    bundleOnly: true as const,
  };
  const stripSenderSsrcs = Boolean(opts?.stripSenderSsrcs);

  // Ensure we have enough video slots beyond main: reuse existing extras, then
  // append new mids (never colliding with an existing mid).
  const existingMids = new Set(
    localSections.map((s) => s.mid).filter(Boolean),
  );
  let nextMid =
    Math.max(
      0,
      ...[...existingMids].map((m) => {
        const n = Number(m);
        return Number.isFinite(n) ? n : 0;
      }),
    ) + 1;
  const firstVideoIdx = localSections.findIndex((s) => s.kind === "video");
  const existingExtraCount = localSections.filter(
    (s, index) => s.kind === "video" && index !== firstVideoIdx,
  ).length;
  const appendExtraCount = Math.max(0, remoteVideoSections.length - existingExtraCount);
  const appendMids: string[] = [];
  while (appendMids.length < appendExtraCount) {
    const mid = String(nextMid++);
    if (existingMids.has(mid)) continue;
    appendMids.push(mid);
    existingMids.add(mid);
  }

  const mids = [
    ...localSections.map((s, index) => s.mid || String(index)),
    ...appendMids,
  ];
  // If local SDP somehow lacks SCTP, append it (telegram-tt always has mid 2).
  const hasApplication = localSections.some((s) => s.kind === "application");
  let synthesizedApplicationMid: string | null = null;
  if (!hasApplication) {
    synthesizedApplicationMid = existingMids.has("2") ? String(nextMid++) : "2";
    mids.push(synthesizedApplicationMid);
  }

  const sdp = new SdpBuilder();
  const dtlsSetup = "actpass" as const;
  sdp.addHeader(Date.now(), mids);

  let mainAudioDone = false;
  let mainVideoDone = false;
  let remoteVideoIndex = 0;
  let candidatesPlaced = false;

  for (const offerSection of localSections) {
    const mid = offerSection.mid || "0";
    if (offerSection.kind === "audio" && !mainAudioDone) {
      mainAudioDone = true;
      // Preserve SFU mix SSRCs from join/remote answer. Only strip when the
      // template is our local offer (see stripSenderSsrcs opt).
      const preserved = Boolean(offerSection.rawLines?.length) &&
        sdp.addPreservedAudioSection(
          offerSection.rawLines ?? [],
          transport,
          dtlsSetup,
          mid,
          { includeCandidates: !candidatesPlaced, stripSenderSsrcs },
        );
      if (!preserved) {
        sdp.addMainAudioSection(transport, dtlsSetup, mid, {
          includeCandidates: !candidatesPlaced,
        });
      }
      candidatesPlaced = true;
      continue;
    }
    if (offerSection.kind === "video" && !mainVideoDone) {
      mainVideoDone = true;
      sdp.addMainVideoSection(transport, dtlsSetup, mid, {
        minimalVideo: false,
        videoPayloadTypes: opts?.videoPayloadTypes,
        videoExtensions: opts?.videoExtensions,
      });
      continue;
    }
    if (offerSection.kind === "application") {
      sdp.addApplicationSection(transport, dtlsSetup, mid, offerSection);
      continue;
    }
    if (offerSection.kind === "video") {
      sdp.addRemoteVideoSection(
        transport,
        dtlsSetup,
        mid,
        remoteVideoSections[remoteVideoIndex] ?? null,
        videoMedia,
      );
      remoteVideoIndex += 1;
      continue;
    }
    sdp.add(
      `m=${offerSection.kind === "unknown" ? "application" : offerSection.kind} 0 ${offerSection.protocol || "UDP/DTLS/SCTP"} ${offerSection.formats || "webrtc-datachannel"}`,
    );
    sdp.add("c=IN IP4 0.0.0.0");
    sdp.add(`a=mid:${mid}`);
    sdp.add("a=inactive");
  }

  for (const mid of appendMids) {
    sdp.addRemoteVideoSection(
      transport,
      dtlsSetup,
      mid,
      remoteVideoSections[remoteVideoIndex] ?? null,
      videoMedia,
    );
    remoteVideoIndex += 1;
  }

  if (synthesizedApplicationMid) {
    sdp.addApplicationSection(transport, dtlsSetup, synthesizedApplicationMid, null);
  }

  return sdp.finalize();
}
