import { appWarn } from "../../shared/appLog";
import {
  buildGroupCallJoinPayloadJson,
  groupCallAnswerSdpFromTransport,
  parseGroupCallJoinTransport,
  parseGroupCallOfferSdp,
} from "../../shared/telegramGroupCallSdp";
import { joinTelegramChatVoice } from "./joinTelegramChatVoice";
import { setTelegramChatVoiceMicMuted } from "./setTelegramChatVoiceMicMuted";
import { setTelegramChatVoiceSpeaking } from "./setTelegramChatVoiceSpeaking";
import { getVoiceAutoplayAudioContext } from "./unlockVoiceAutoplay";

type SessionInput = {
  chatId: number;
  groupCallId: number | null;
};

function createSilentVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const stream = canvas.captureStream(1);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    throw new Error("silent_video_track_failed");
  }
  return track;
}

/**
 * Local audio for listen-only joins — no mic permission / user gesture.
 * Real mic is swapped in later via setMicEnabled().
 */
function createSilentAudioTrack(): MediaStreamTrack {
  if (typeof AudioContext === "undefined") {
    throw new Error("silent_audio_unavailable");
  }
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  const dest = ctx.createMediaStreamDestination();
  gain.connect(dest);
  oscillator.start();
  const track = dest.stream.getAudioTracks()[0];
  if (!track) {
    oscillator.stop();
    void ctx.close().catch(() => undefined);
    throw new Error("silent_audio_track_failed");
  }
  // Keep ctx alive for the track lifetime; stop() closes it.
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    try {
      oscillator.stop();
    } catch {
      // already stopped
    }
    void ctx.close().catch(() => undefined);
    stopTrack();
  };
  // Keep enabled so the transceiver stays live and the SFU can deliver remote audio.
  // Telegram mute is signaled separately via is_muted / muteGroupCallParticipant.
  track.enabled = true;
  return track;
}

/** Browser WebRTC session for a Telegram group voice call. */
export class TelegramGroupCallWebSession {
  private connection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  /** True when `audioTrack` is a placeholder (no real mic yet). */
  private usingSilentAudio = false;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;
  private playbackCtx: AudioContext | null = null;
  private playbackSource: MediaStreamAudioSourceNode | null = null;
  /** Serialize play() / graph rebuild — concurrent calls interrupt each other. */
  private remotePlayChain: Promise<void> = Promise.resolve();
  private audioSourceId: number | null = null;
  /** One-shot document gesture listener to unmute after auto-join. */
  private gestureUnmuteCleanup: (() => void) | null = null;
  private joined = false;
  private joining: Promise<void> | null = null;
  private micEnabled = false;
  private localSpeaking = false;
  private speakingListeners = new Set<(speaking: boolean) => void>();
  private analyserCtx: AudioContext | null = null;
  private analyserRaf: number | null = null;
  private lastSpeakingSyncAt = 0;
  private lastSpeakingSynced: boolean | null = null;
  /** After GROUPCALL_JOIN_MISSING, stop hammering speaking until we rejoin. */
  private speakingSyncBlockedUntil = 0;
  private joinLostListeners = new Set<() => void>();
  private iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackWatchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private input: SessionInput) {
    // Pre-create the element so unlockRemoteAudio during Join hits the real sink.
    if (typeof document !== "undefined") {
      this.ensureRemoteAudioElement();
    }
  }

  /** Update call id without tearing down WebRTC (chat list refreshes often). */
  updateGroupCallId(groupCallId: number | null): void {
    this.input = { ...this.input, groupCallId };
  }

  get isJoined(): boolean {
    return this.joined;
  }

  /** True when ICE/DTLS path is up and RTP can flow. */
  isMediaConnected(): boolean {
    const pc = this.connection;
    if (!this.joined || !pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "connected" ||
      ice === "completed" ||
      conn === "connected"
    );
  }

  /** Offer/answer done but ICE still checking — do not tear down yet. */
  isNegotiating(): boolean {
    const pc = this.connection;
    if (!this.joined || !pc) return false;
    const ice = pc.iceConnectionState;
    const conn = pc.connectionState;
    return (
      ice === "new" ||
      ice === "checking" ||
      conn === "new" ||
      conn === "connecting"
    );
  }

  /** Drop stale joined flag when WebRTC died but UI still thinks we're in. */
  rejoinIfStale(): boolean {
    if (!this.joined || this.joining) return false;
    const pc = this.connection;
    if (!pc) {
      if (this.joined) {
        this.markJoinLost("stale_no_pc");
        return true;
      }
      return false;
    }
    if (this.isNegotiating() || this.isMediaConnected()) return false;
    // disconnected / failed — scheduleJoinLostIfStillBroken owns teardown timing.
    if (
      pc.iceConnectionState === "disconnected" ||
      pc.connectionState === "disconnected"
    ) {
      return false;
    }
    if (
      pc.iceConnectionState === "failed" ||
      pc.iceConnectionState === "closed" ||
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    ) {
      this.markJoinLost("stale_connection");
      return true;
    }
    return false;
  }

  /** Fired when TDLib reports we are no longer joined (roster/speaking broken). */
  onJoinLost(listener: () => void): () => void {
    this.joinLostListeners.add(listener);
    return () => {
      this.joinLostListeners.delete(listener);
    };
  }

  private async logIceDiagnostics(
    connection: RTCPeerConnection,
    label: string,
  ): Promise<void> {
    try {
      const stats = await connection.getStats();
      let inboundAudio = 0;
      let pairsSucceeded = 0;
      let pairsInProgress = 0;
      let pairsFailed = 0;
      const locals: string[] = [];
      const remotes: string[] = [];
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          inboundAudio += Number(report.bytesReceived) || 0;
        }
        if (report.type === "candidate-pair") {
          if (report.state === "succeeded") pairsSucceeded++;
          else if (report.state === "in-progress") pairsInProgress++;
          else if (report.state === "failed") pairsFailed++;
        }
        if (report.type === "local-candidate") {
          const addr = report.address || report.ip || "?";
          locals.push(`${addr}:${report.port}/${report.candidateType}`);
        }
        if (report.type === "remote-candidate") {
          const addr = report.address || report.ip || "?";
          remotes.push(`${addr}:${report.port}/${report.candidateType}`);
        }
      });
      appWarn("[voice-ice-stats]", label, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice: connection.iceConnectionState,
        conn: connection.connectionState,
        inboundAudio,
        pairsSucceeded,
        pairsInProgress,
        pairsFailed,
        localCandidates: locals.join(","),
        remoteCandidates: remotes.join(","),
      });
    } catch {
      // ignore stats errors
    }
  }

  private scheduleJoinLostIfStillBroken(
    connection: RTCPeerConnection,
    reason: string,
    delayMs = 12_000,
  ): void {
    if (this.iceDisconnectTimer) return;
    this.iceDisconnectTimer = window.setTimeout(() => {
      this.iceDisconnectTimer = null;
      if (this.connection !== connection) return;
      if (this.isMediaConnected()) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      if (
        ice === "failed" ||
        ice === "closed" ||
        ice === "disconnected" ||
        conn === "failed" ||
        conn === "disconnected"
      ) {
        this.markJoinLost(reason);
      }
    }, delayMs);
  }

  private clearJoinLostTimer(): void {
    if (this.iceDisconnectTimer) {
      window.clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
  }

  private markJoinLost(reason: string, opts?: { silent?: boolean }): void {
    if (!this.joined && !this.connection) return;
    this.speakingSyncBlockedUntil = Date.now() + 4_000;
    this.lastSpeakingSynced = null;
    // Tear down media so ensureJoinedListenOnly can open a fresh PeerConnection.
    // Do not remove the remote <audio> shell — unlock gestures still need it.
    this.stopSpeakingMonitor();
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    this.audioSourceId = null;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.iceDisconnectTimer) {
      window.clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
    this.clearPlaybackWatchdog();
    this.teardownWebAudioPlayback();
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => track.stop());
      this.remoteStream = null;
    }
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }
    const wasJoined = this.joined;
    this.joined = false;
    this.micEnabled = false;
    appWarn("[voice-join-lost]", reason, {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      wasJoined,
      silent: Boolean(opts?.silent),
    });
    if (opts?.silent) return;
    for (const listener of this.joinLostListeners) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }

  get isMicEnabled(): boolean {
    return this.micEnabled;
  }

  get isLocalSpeaking(): boolean {
    return this.localSpeaking;
  }

  onLocalSpeakingChange(listener: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(listener);
    return () => {
      this.speakingListeners.delete(listener);
    };
  }

  async ensureJoinedListenOnly(): Promise<void> {
    if (this.joined) {
      if (this.isNegotiating() || this.isMediaConnected()) return;
      this.rejoinIfStale();
      if (this.joined) return;
    }
    if (this.joining) {
      await this.joining;
      return;
    }
    this.joining = this.joinInternal(true);
    try {
      await this.joining;
    } finally {
      this.joining = null;
    }
  }

  /** Acquire a real mic (user gesture). Replaces silent placeholder if already joined. */
  async ensureLocalMic(): Promise<void> {
    if (this.audioTrack && !this.usingSilentAudio) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("microphone_unavailable");
    }
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const audioTrack = micStream.getAudioTracks()[0];
    if (!audioTrack) {
      micStream.getTracks().forEach((track) => track.stop());
      throw new Error("microphone_unavailable");
    }
    audioTrack.enabled = false;

    const previous = this.audioTrack;
    if (this.connection && previous) {
      const sender = this.connection
        .getSenders()
        .find((s) => s.track?.kind === "audio" || s.track === previous);
      if (sender) {
        await sender.replaceTrack(audioTrack);
      }
    }
    if (previous) {
      previous.stop();
    }

    this.audioTrack = audioTrack;
    this.usingSilentAudio = false;
    if (this.localStream) {
      for (const t of this.localStream.getAudioTracks()) {
        this.localStream.removeTrack(t);
      }
      this.localStream.addTrack(audioTrack);
    } else {
      this.localStream = new MediaStream([audioTrack]);
    }
    this.startSpeakingMonitor();
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    if (enabled || this.usingSilentAudio || !this.audioTrack) {
      await this.ensureLocalMic();
    }
    if (this.audioTrack) {
      this.audioTrack.enabled = enabled;
    }
    this.micEnabled = enabled;
    if (!enabled) {
      this.setLocalSpeaking(false);
    }

    // Best-effort: join + unmute on Telegram. Local UI/mic stay as set.
    try {
      if (!this.joined) {
        await this.ensureJoinedListenOnly();
        if (enabled) {
          await this.ensureLocalMic();
        }
        if (this.audioTrack) this.audioTrack.enabled = enabled;
        this.micEnabled = enabled;
      }
      this.resumeRemoteAudio();
      const muteResult = await setTelegramChatVoiceMicMuted({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        isMuted: !enabled,
      });
      if (!muteResult.ok) {
        appWarn("[voice-mic-sync]", muteResult.error, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
          enabled,
        });
        const err = muteResult.error;
        const needsRejoin =
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID") ||
            err.includes("GROUPCALL_SSRC_DUPLICATE_SIMULTANEOUS"));
        if (needsRejoin) {
          // TDLib lost the join — rebuild WebRTC with the desired mute baked into join.
          // Silent: keep React mic intent until joinInternal finishes.
          this.markJoinLost(err, { silent: true });
          await this.joinInternal(!enabled);
          if (enabled) {
            await this.ensureLocalMic();
            if (this.audioTrack) this.audioTrack.enabled = true;
            this.micEnabled = true;
          }
          this.resumeRemoteAudio();
        } else if (
          typeof err === "string" &&
          /Can't unmute user/i.test(err)
        ) {
          // Admin-muted / no permission — revert local mic to muted.
          if (this.audioTrack) this.audioTrack.enabled = false;
          this.micEnabled = false;
          this.setLocalSpeaking(false);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-mic-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId, enabled },
      );
    }
  }

  private setLocalSpeaking(speaking: boolean): void {
    if (this.localSpeaking === speaking) return;
    this.localSpeaking = speaking;
    for (const listener of this.speakingListeners) {
      try {
        listener(speaking);
      } catch {
        // ignore listener errors
      }
    }
    void this.syncSpeakingToTelegram(speaking);
  }

  private async syncSpeakingToTelegram(speaking: boolean): Promise<void> {
    if (!this.joined || this.audioSourceId == null) return;
    const now = Date.now();
    if (now < this.speakingSyncBlockedUntil) return;
    // Debounce Telegram updates; always flush "not speaking" promptly.
    if (
      speaking &&
      this.lastSpeakingSynced === true &&
      now - this.lastSpeakingSyncAt < 350
    ) {
      return;
    }
    this.lastSpeakingSyncAt = now;
    this.lastSpeakingSynced = speaking;
    try {
      const result = await setTelegramChatVoiceSpeaking({
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        audioSourceId: this.audioSourceId,
        isSpeaking: speaking,
      });
      if (!result.ok) {
        const err = result.error;
        appWarn("[voice-speaking-sync]", err, {
          chatId: this.input.chatId,
          groupCallId: this.input.groupCallId,
        });
        if (
          typeof err === "string" &&
          (err.includes("GROUPCALL_JOIN_MISSING") ||
            err.includes("GROUPCALL_FORBIDDEN") ||
            err.includes("GROUPCALL_INVALID"))
        ) {
          this.markJoinLost(err);
        }
      }
    } catch (err) {
      appWarn(
        "[voice-speaking-sync]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
    }
  }

  private startSpeakingMonitor(): void {
    if (this.analyserRaf != null || !this.audioTrack) return;
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;

    try {
      const ctx = new AudioContext();
      this.analyserCtx = ctx;
      const source = ctx.createMediaStreamSource(new MediaStream([this.audioTrack]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        this.analyserRaf = window.requestAnimationFrame(tick);
        if (!this.micEnabled || !this.audioTrack?.enabled) {
          this.setLocalSpeaking(false);
          return;
        }
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i]! - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        this.setLocalSpeaking(rms > 0.04);
      };
      this.analyserRaf = window.requestAnimationFrame(tick);
      void ctx.resume().catch(() => undefined);
    } catch (err) {
      appWarn(
        "[voice-speaking-analyser]",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private stopSpeakingMonitor(): void {
    if (this.analyserRaf != null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.analyserRaf);
      this.analyserRaf = null;
    }
    if (this.analyserCtx) {
      void this.analyserCtx.close().catch(() => undefined);
      this.analyserCtx = null;
    }
    this.setLocalSpeaking(false);
  }

  private ensureRemoteAudioElement(): HTMLAudioElement {
    if (this.remoteAudio) return this.remoteAudio;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.muted = false;
    audio.volume = 1;
    // Keep off-screen but in the document — some browsers won't play detached elements.
    audio.style.position = "fixed";
    audio.style.width = "0";
    audio.style.height = "0";
    audio.style.opacity = "0";
    audio.style.pointerEvents = "none";
    audio.setAttribute("aria-hidden", "true");
    document.body.appendChild(audio);
    this.remoteAudio = audio;
    return audio;
  }

  private armGestureUnmute(): void {
    if (typeof document === "undefined" || this.gestureUnmuteCleanup) return;
    const onGesture = () => {
      this.resumeRemoteAudio();
      this.gestureUnmuteCleanup?.();
      this.gestureUnmuteCleanup = null;
    };
    document.addEventListener("pointerdown", onGesture, { capture: true, once: true });
    document.addEventListener("keydown", onGesture, { capture: true, once: true });
    this.gestureUnmuteCleanup = () => {
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }

  private ensureRemoteStream(): MediaStream {
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
    }
    return this.remoteStream;
  }

  private ensurePlaybackContext(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    const shared = getVoiceAutoplayAudioContext();
    if (shared) {
      this.playbackCtx = shared;
    } else if (!this.playbackCtx || this.playbackCtx.state === "closed") {
      this.playbackCtx = new AudioContext();
    }
    return this.playbackCtx;
  }

  private teardownWebAudioPlayback(): void {
    try {
      this.playbackSource?.disconnect();
    } catch {
      // ignore
    }
    this.playbackSource = null;
  }

  private rebuildWebAudioPlayback(): boolean {
    const ctx = this.playbackCtx;
    const stream = this.remoteStream;
    if (!ctx || !stream || stream.getAudioTracks().length === 0) return false;
    try {
      this.teardownWebAudioPlayback();
      // Fresh MediaStream snapshot so createMediaStreamSource sees current tracks.
      const snapshot = new MediaStream(stream.getAudioTracks());
      this.playbackSource = ctx.createMediaStreamSource(snapshot);
      this.playbackSource.connect(ctx.destination);
      return true;
    } catch (err) {
      appWarn(
        "[voice-webaudio]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
      return false;
    }
  }

  private queueRemotePlayback(reason: string): void {
    this.remotePlayChain = this.remotePlayChain
      .then(() => this.ensureRemotePlaybackInternal(reason))
      .catch(() => undefined);
  }

  private async ensureRemotePlaybackInternal(reason: string): Promise<void> {
    if (typeof document === "undefined") return;

    // Re-pull live receivers — ontrack can fire before our stream is ready, and
    // SFU SSRC switches can replace tracks without a fresh attach.
    const pc = this.connection;
    if (pc) {
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind === "audio") {
          this.attachRemoteAudioTrack(receiver.track);
        }
      }
    }

    const stream = this.remoteStream;
    if (!stream || stream.getAudioTracks().length === 0) return;

    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
    }

    const ctx = this.ensurePlaybackContext();
    if (ctx) {
      await ctx.resume().catch(() => undefined);
    }

    // HTML <audio> is the reliable sink after a user gesture. The previous
    // Web-Audio-only path often stayed silent (tracks added after the source
    // node was created, or the shared unlock context was stale after rejoin).
    this.teardownWebAudioPlayback();
    const audio = this.ensureRemoteAudioElement();
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.muted = false;
    audio.volume = 1;
    try {
      if (audio.paused) {
        await audio.play();
      }
      appWarn("[voice-remote-playback]", "html", {
        reason,
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx?.state ?? "none",
        paused: audio.paused,
        readyState: audio.readyState,
      });
      return;
    } catch (err) {
      this.armGestureUnmute();
      appWarn("[voice-remote-audio]", err instanceof Error ? err.message : String(err), {
        reason,
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx?.state ?? "none",
      });
    }

    // Fallback when HTML autoplay is blocked but AudioContext was resumed.
    if (ctx?.state === "running" && this.rebuildWebAudioPlayback()) {
      appWarn("[voice-remote-playback]", "webaudio-fallback", {
        reason,
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        tracks: stream.getAudioTracks().length,
        ctxState: ctx.state,
      });
    }
  }

  private attachRemoteAudioTrack(track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    track.enabled = true;
    const stream = this.ensureRemoteStream();
    const already = stream.getAudioTracks().some((t) => t.id === track.id);
    if (!already) {
      stream.addTrack(track);
      appWarn("[voice-remote-track]", "attached", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
        muted: track.muted,
        readyState: track.readyState,
        trackCount: stream.getAudioTracks().length,
      });
    }
    track.onunmute = () => {
      appWarn("[voice-remote-track]", "unmuted", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        trackId: track.id,
      });
      this.queueRemotePlayback("track-unmute");
    };
    this.queueRemotePlayback("track");
  }

  /**
   * Unlock autoplay during a user gesture (Join / open strip / mic).
   * Must run synchronously in the gesture stack so later remote tracks can play.
   */
  unlockRemoteAudio(): void {
    if (typeof document === "undefined") return;
    this.ensureRemoteStream();
    const ctx = this.ensurePlaybackContext();
    void ctx?.resume().catch(() => undefined);
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.queueRemotePlayback("unlock");
  }

  /** Retry autoplay after a user gesture (mic toggle / UI click). */
  resumeRemoteAudio(): void {
    if (typeof document === "undefined") return;
    this.ensureRemoteStream();
    const ctx = this.ensurePlaybackContext();
    void ctx?.resume().catch(() => undefined);
    this.queueRemotePlayback("resume");
  }

  private async joinInternal(startMuted: boolean): Promise<void> {
    if (this.joined || typeof RTCPeerConnection === "undefined") {
      return;
    }

    // Listen-only: silent local audio (no mic prompt). Real mic on unmute.
    if (startMuted) {
      if (!this.audioTrack) {
        this.audioTrack = createSilentAudioTrack();
        this.usingSilentAudio = true;
      }
    } else {
      await this.ensureLocalMic();
    }
    const audioTrack = this.audioTrack;
    if (!audioTrack) {
      throw new Error("microphone_unavailable");
    }
    // Listen-only still keeps the local track enabled (silent / zero-gain) so RTP
    // receive stays negotiated. Mic privacy is Telegram is_muted + real mic swap.
    if (this.usingSilentAudio) {
      audioTrack.enabled = true;
    } else {
      audioTrack.enabled = !startMuted;
    }

    const videoTrack = createSilentVideoTrack();
    const localStream = new MediaStream([audioTrack, videoTrack]);

    // Match tweb/tgcalls: no STUN. Telegram SFU is a public host candidate;
    // extra srflx pairs confuse ICE (pairsInProgress without nomination) and
    // then Chrome consent-freshness tears the link down after a brief audio blip.
    const connection = new RTCPeerConnection({
      iceServers: [],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    connection.addTrack(audioTrack, localStream);
    connection.addTrack(videoTrack, localStream);

    connection.ontrack = (event) => {
      const track = event.track;
      if (!track) return;
      track.enabled = true;
      appWarn("[voice-ontrack]", track.kind, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        streams: event.streams.length,
        muted: track.muted,
        readyState: track.readyState,
      });
      if (event.streams[0]) {
        for (const streamTrack of event.streams[0].getAudioTracks()) {
          streamTrack.enabled = true;
          this.attachRemoteAudioTrack(streamTrack);
        }
      } else if (track.kind === "audio") {
        this.attachRemoteAudioTrack(track);
      }
    };

    connection.oniceconnectionstatechange = () => {
      const ice = connection.iceConnectionState;
      appWarn("[voice-pc-ice]", ice, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        conn: connection.connectionState,
      });
      if (ice === "failed" || ice === "closed") {
        void this.logIceDiagnostics(connection, `ice_${ice}`);
        this.scheduleJoinLostIfStillBroken(connection, `ice_${ice}`);
        return;
      }
      if (ice === "disconnected") {
        void this.logIceDiagnostics(connection, "ice_disconnected");
        this.scheduleJoinLostIfStillBroken(connection, "ice_disconnected");
        return;
      }
      this.clearJoinLostTimer();
      if (ice === "connected" || ice === "completed") {
        for (const receiver of connection.getReceivers()) {
          if (receiver.track?.kind === "audio") {
            this.attachRemoteAudioTrack(receiver.track);
          }
        }
        this.queueRemotePlayback("ice-connected");
      }
    };

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      appWarn("[voice-pc-state]", state, {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        ice: connection.iceConnectionState,
        receivers: connection.getReceivers().map((r) => ({
          kind: r.track?.kind,
          muted: r.track?.muted,
          enabled: r.track?.enabled,
          readyState: r.track?.readyState,
        })),
      });
      if (state === "connected") {
        for (const receiver of connection.getReceivers()) {
          if (receiver.track?.kind === "audio") {
            this.attachRemoteAudioTrack(receiver.track);
          }
        }
        this.queueRemotePlayback("pc-connected");
      } else if (state === "failed" || state === "disconnected") {
        this.scheduleJoinLostIfStillBroken(connection, `pc_${state}`);
      }
    };

    const offer = await connection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await connection.setLocalDescription(offer);
    if (!offer.sdp) {
      connection.close();
      videoTrack.stop();
      throw new Error("offer_sdp_missing");
    }

    await new Promise<void>((resolve) => {
      if (connection.iceGatheringState === "complete") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(() => {
        connection.removeEventListener("icegatheringstatechange", onGather);
        resolve();
      }, 8_000);
      const onGather = () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          connection.removeEventListener("icegatheringstatechange", onGather);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", onGather);
    });

    const localSdp = connection.localDescription?.sdp ?? offer.sdp;
    const localCandidateCount = (localSdp.match(/a=candidate:/g) ?? []).length;
    appWarn("[voice-ice-local]", "gathered", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      candidateCount: localCandidateCount,
      iceGather: connection.iceGatheringState,
      hostCount: (localSdp.match(/ typ host /g) ?? []).length,
      srflxCount: (localSdp.match(/ typ srflx /g) ?? []).length,
    });
    const parsed = parseGroupCallOfferSdp(localSdp);
    const joinPayloadJson = buildGroupCallJoinPayloadJson(parsed);
    if (!joinPayloadJson || parsed.source == null) {
      connection.close();
      videoTrack.stop();
      throw new Error("join_payload_build_failed");
    }

    const joinResult = await joinTelegramChatVoice({
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      audioSourceId: parsed.source,
      payload: joinPayloadJson,
      isMuted: startMuted,
    });
    if (!joinResult.ok) {
      connection.close();
      videoTrack.stop();
      throw new Error(joinResult.error);
    }

    let transportRoot: { stream?: boolean } | null = null;
    try {
      transportRoot = JSON.parse(joinResult.join_payload) as { stream?: boolean };
    } catch {
      transportRoot = null;
    }
    if (transportRoot?.stream) {
      connection.close();
      videoTrack.stop();
      throw new Error("voice_stream_mode_unsupported");
    }

    const transport = parseGroupCallJoinTransport(joinResult.join_payload);
    if (!transport) {
      appWarn("[voice-join-transport]", "join_transport_invalid", {
        chatId: this.input.chatId,
        groupCallId: this.input.groupCallId,
        payloadBytes: joinResult.join_payload.length,
        payloadPrefix: joinResult.join_payload.slice(0, 80),
      });
      connection.close();
      videoTrack.stop();
      throw new Error("join_transport_invalid");
    }
    const answerDtlsSetup =
      transport.fingerprints[0]?.setup?.trim().toLowerCase() === "passive"
        ? "passive"
        : "active";
    appWarn("[voice-dtls]", "roles", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      offerSetup: parsed.setup,
      joinSetup: "passive",
      answerSetup: answerDtlsSetup,
    });
    appWarn("[voice-join-transport]", "ok", {
      chatId: this.input.chatId,
      groupCallId: this.input.groupCallId,
      candidateCount: transport.candidates.length,
      fingerprintCount: transport.fingerprints.length,
      answerDtlsSetup,
      candidateIps: transport.candidates.map((c) => `${c.ip}:${c.port}/${c.type}`).join(","),
    });

    try {
      await connection.setRemoteDescription({
        type: "answer",
        sdp: groupCallAnswerSdpFromTransport(transport, localSdp),
      });
    } catch (err) {
      appWarn(
        "[voice-sdp-answer]",
        err instanceof Error ? err.message : String(err),
        { chatId: this.input.chatId, groupCallId: this.input.groupCallId },
      );
      throw err;
    }

    this.connection = connection;
    this.localStream = localStream;
    this.audioTrack = audioTrack;
    this.audioSourceId = parsed.source;
    this.joined = true;
    this.micEnabled = !startMuted;
    if (!this.usingSilentAudio) {
      this.startSpeakingMonitor();
    }
    // Tracks may already be present; unlock was done on the open-dialog click.
    this.resumeRemoteAudio();
    this.armGestureUnmute();
    this.startPlaybackWatchdog(connection);

    const joinChatId = this.input.chatId;
    const joinCallId = this.input.groupCallId;
    window.setTimeout(() => {
      if (!this.joined || this.connection !== connection) return;
      if (this.isMediaConnected()) return;
      const ice = connection.iceConnectionState;
      const conn = connection.connectionState;
      if (ice === "checking" || ice === "new" || conn === "connecting") {
        appWarn("[voice-join-timeout]", "ice_still_pending", {
          chatId: joinChatId,
          groupCallId: joinCallId,
          ice,
          conn,
        });
        this.markJoinLost("ice_timeout");
      }
    }, 20_000);
  }

  /** Keep HTML audio playing while ICE stays up (autoplay / track swaps). */
  private startPlaybackWatchdog(connection: RTCPeerConnection): void {
    this.clearPlaybackWatchdog();
    this.playbackWatchdog = window.setInterval(() => {
      if (this.connection !== connection || !this.joined) {
        this.clearPlaybackWatchdog();
        return;
      }
      if (!this.isMediaConnected()) return;
      this.queueRemotePlayback("watchdog");
    }, 2_500);
  }

  private clearPlaybackWatchdog(): void {
    if (this.playbackWatchdog != null) {
      window.clearInterval(this.playbackWatchdog);
      this.playbackWatchdog = null;
    }
  }

  dispose(): void {
    this.stopSpeakingMonitor();
    this.clearPlaybackWatchdog();
    this.clearJoinLostTimer();
    this.gestureUnmuteCleanup?.();
    this.gestureUnmuteCleanup = null;
    this.teardownWebAudioPlayback();
    if (this.playbackCtx && this.playbackCtx !== getVoiceAutoplayAudioContext()) {
      void this.playbackCtx.close().catch(() => undefined);
    }
    this.playbackCtx = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteStream = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
    this.usingSilentAudio = false;
    this.audioSourceId = null;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.joined = false;
    this.micEnabled = false;
    this.speakingListeners.clear();
  }
}
