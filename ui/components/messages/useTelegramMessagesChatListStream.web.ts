import { useEffect, useRef } from "react";
import { logPageDisplay } from "../../pageDisplayLog";
import { resolveTelegramLiveStreamUrl } from "../../telegram/resolveTelegramLiveStreamUrl";

type Options = {
  enabled: boolean;
  getSinceRevision: () => number | null;
  onRevision: (revision: number) => void;
  /** True while SSE is open and recently heartbeating (ready / ping / revision). */
  onStreamHealthyChange?: (healthy: boolean) => void;
};

const STREAM_RECONNECT_MS = 3_000;
/** Gateway pings every 25s — miss ~2 pings ⇒ treat stream as dead for poll fallback. */
const STREAM_HEALTH_STALE_MS = 55_000;

/** SSE push — prefers direct gateway; falls back to Vercel proxy. */
export function useTelegramMessagesChatListStream(options: Options): void {
  const { enabled, getSinceRevision, onRevision, onStreamHealthyChange } = options;
  const onRevisionRef = useRef(onRevision);
  const getSinceRevisionRef = useRef(getSinceRevision);
  const onStreamHealthyChangeRef = useRef(onStreamHealthyChange);

  useEffect(() => {
    onRevisionRef.current = onRevision;
  }, [onRevision]);

  useEffect(() => {
    getSinceRevisionRef.current = getSinceRevision;
  }, [getSinceRevision]);

  useEffect(() => {
    onStreamHealthyChangeRef.current = onStreamHealthyChange;
  }, [onStreamHealthyChange]);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") {
      onStreamHealthyChangeRef.current?.(false);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let healthWatchTimer: ReturnType<typeof setInterval> | null = null;
    let mintAbort: AbortController | null = null;
    let healthy = false;
    let lastEventAt = 0;

    const setHealthy = (next: boolean) => {
      if (healthy === next) return;
      healthy = next;
      onStreamHealthyChangeRef.current?.(next);
    };

    const markEvent = () => {
      lastEventAt = Date.now();
      setHealthy(true);
    };

    const connect = () => {
      if (cancelled) return;
      eventSource?.close();
      mintAbort?.abort();
      mintAbort = new AbortController();
      setHealthy(false);

      const sinceRevision = getSinceRevisionRef.current();
      const proxyParams = new URLSearchParams();
      if (sinceRevision != null && sinceRevision > 0) {
        proxyParams.set("since_revision", String(sinceRevision));
      }
      const proxyQuery = proxyParams.toString();
      const proxyPath = proxyQuery
        ? `/api/telegram-messages-chats-stream?${proxyQuery}`
        : "/api/telegram-messages-chats-stream";

      void resolveTelegramLiveStreamUrl({
        stream: "chats",
        proxyPath,
        sinceRevision,
        signal: mintAbort.signal,
      }).then(({ url, mode }) => {
        if (cancelled) return;
        eventSource = new EventSource(url);
        logPageDisplay("messages_chats_stream_connect", {
          sinceRevision: sinceRevision ?? null,
          mode,
        });

        eventSource.addEventListener("revision", (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data) as { revision?: number };
            if (typeof data.revision === "number" && data.revision > 0) {
              markEvent();
              onRevisionRef.current(data.revision);
            }
          } catch {
            /* ignore malformed event */
          }
        });

        eventSource.addEventListener("ready", () => {
          markEvent();
          logPageDisplay("messages_chats_stream_ready", {
            sinceRevision: getSinceRevisionRef.current(),
            mode,
          });
        });

        eventSource.addEventListener("ping", () => {
          markEvent();
        });

        eventSource.onerror = () => {
          eventSource?.close();
          eventSource = null;
          setHealthy(false);
          if (cancelled) return;
          if (reconnectTimer != null) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, STREAM_RECONNECT_MS);
        };
      });
    };

    connect();
    healthWatchTimer = setInterval(() => {
      if (cancelled) return;
      if (!healthy) return;
      if (lastEventAt > 0 && Date.now() - lastEventAt > STREAM_HEALTH_STALE_MS) {
        setHealthy(false);
        logPageDisplay("messages_chats_stream_stale", {
          silentMs: Date.now() - lastEventAt,
        });
      }
    }, 5_000);

    return () => {
      cancelled = true;
      mintAbort?.abort();
      if (reconnectTimer != null) clearTimeout(reconnectTimer);
      if (healthWatchTimer != null) clearInterval(healthWatchTimer);
      eventSource?.close();
      setHealthy(false);
    };
  }, [enabled]);
}
