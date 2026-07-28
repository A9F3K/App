/**
 * Reproduce voice-dialog freeze after Join and report the exact cause.
 *
 * Measures:
 * - PerformanceObserver longtasks after webrtc_join_ok
 * - rAF heartbeat gaps (main-thread stalls)
 * - Whether ice_post_apply / playback_queue_storm fire
 * - JS heap if available
 *
 * Usage:
 *   VOICE_TEST_URL=https://program.hyperlinks.space node scripts/voice-join-freeze-probe.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.VOICE_TEST_URL || "https://program.hyperlinks.space";
const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1536, height: 900 },
  permissions: ["microphone", "camera"],
});
await context.grantPermissions(["microphone", "camera"], {
  origin: new URL(BASE).origin,
});
await context.addCookies([
  {
    name: "hs_auth_session",
    value: token,
    domain: new URL(BASE).hostname,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  },
]);

const page = await context.newPage();
const voiceLogs = [];
const longTasks = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (
    text.includes("[page-display]") &&
    (text.includes("messages_voice_") ||
      text.includes("voice_dialog_") ||
      text.includes("playback_queue"))
  ) {
    voiceLogs.push({ t: Date.now(), text });
  }
});

await page.addInitScript(() => {
  window.__VOICE_PROBE__ = {
    longTasks: [],
    rafGaps: [],
    joinOkAt: 0,
    lastRafAt: 0,
    heap: [],
  };
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue;
        window.__VOICE_PROBE__.longTasks.push({
          durationMs: Math.round(e.duration),
          startTimeMs: Math.round(e.startTime),
          afterJoinOk:
            window.__VOICE_PROBE__.joinOkAt > 0 &&
            e.startTime >= window.__VOICE_PROBE__.joinOkAt,
        });
      }
    });
    po.observe({ type: "longtask", buffered: true });
  } catch {
    /* ignore */
  }
  const tick = (now) => {
    const p = window.__VOICE_PROBE__;
    if (p.lastRafAt > 0) {
      const gap = now - p.lastRafAt;
      if (gap >= 200) {
        p.rafGaps.push({
          gapMs: Math.round(gap),
          atMs: Math.round(now),
          afterJoinOk: p.joinOkAt > 0 && now >= p.joinOkAt,
        });
      }
    }
    p.lastRafAt = now;
    if (p.joinOkAt > 0 && performance.memory) {
      p.heap.push({
        atMs: Math.round(now),
        usedMb: Math.round(performance.memory.usedJSHeapSize / 1e6),
        totalMb: Math.round(performance.memory.totalJSHeapSize / 1e6),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const origLog = console.log.bind(console);
  console.log = (...args) => {
    const s = args.map(String).join(" ");
    if (s.includes("messages_voice_webrtc_join_ok") && !window.__VOICE_PROBE__.joinOkAt) {
      window.__VOICE_PROBE__.joinOkAt = performance.now();
    }
    origLog(...args);
  };
});

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(8_000);

const strip = page.getByTestId("voice-strip-preview");
const stripVisible = await strip.isVisible().catch(() => false);
if (!stripVisible) {
  // Open messages / first chat with voice if needed — click Messages then Blox.
  await page.getByText("Messages", { exact: false }).first().click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  await page.getByText("Blox Fruits", { exact: false }).first().click({ timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(5_000);
}

const strip2 = page.getByTestId("voice-strip-preview");
if (!(await strip2.isVisible().catch(() => false))) {
  console.log(
    JSON.stringify({
      ok: false,
      error: "voice_strip_not_visible",
      sampleLogs: voiceLogs.slice(-15).map((l) => l.text),
    }, null, 2),
  );
  await browser.close();
  process.exit(2);
}

await strip2.click();
// Wait for post-join diagnostics (ice_post_apply at 800ms/2s, watchdog, etc.)
await page.waitForTimeout(6_000);

const probe = await page.evaluate(() => window.__VOICE_PROBE__);
const interesting = voiceLogs
  .map((l) => l.text)
  .filter((t) =>
    /webrtc_join_ok|ice_post_apply|playback_queue_storm|playback_watchdog|pc_ice|remote_track|postjoin_reload|longtask|sdp_answer/.test(
      t,
    ),
  );

const afterJoinLong = (probe.longTasks || []).filter((t) => t.afterJoinOk);
const afterJoinRaf = (probe.rafGaps || []).filter((g) => g.afterJoinOk);
const maxRafGap = afterJoinRaf.reduce((m, g) => Math.max(m, g.gapMs), 0);
const maxLong = afterJoinLong.reduce((m, t) => Math.max(m, t.durationMs), 0);
const hasIcePostApply = interesting.some((t) => t.includes("ice_post_apply"));
const hasStorm = interesting.some((t) => t.includes("playback_queue_storm"));
const hasJoinOk = interesting.some((t) => t.includes("webrtc_join_ok"));
const iceConnected = interesting.some(
  (t) => t.includes("messages_voice_pc_ice") && t.includes("ice=connected"),
);

let verdict = "unknown";
const webdriverSkip = interesting.some((t) =>
  t.includes("skip_webdriver") || t.includes("voice-sdp-answer"),
);
// Headless Chromium sets navigator.webdriver — production code closes the PC
 // before setRemoteDescription, so ice_post_apply never runs in Playwright.
const likelyWebdriver =
  !interesting.some((t) => t.includes("sdp_answer_apply_ok")) &&
  hasJoinOk &&
  interesting.some((t) => t.includes("sdp_answer_scheduled"));

if (!hasJoinOk) verdict = "join_never_completed";
else if (hasStorm) verdict = "playback_queue_storm_froze_tab";
else if (likelyWebdriver)
  verdict = "webdriver_skips_sdp_apply_use_real_browser_for_audio";
else if (!hasIcePostApply && maxRafGap >= 800)
  verdict = "main_thread_blocked_after_join_ok";
else if (!hasIcePostApply) verdict = "timers_starved_after_join_ok";
else if (!iceConnected) verdict = "join_ok_but_ice_not_connected_silence";
else verdict = "join_path_healthy_check_audio_path";

console.log(
  JSON.stringify(
    {
      ok: true,
      verdict,
      note: likelyWebdriver
        ? "Playwright cannot validate ICE/audio: session tears down PC when navigator.webdriver is set. User logs with apply_ok+muted track then silence = playback attach loop (fixed)."
        : undefined,
      hasJoinOk,
      hasIcePostApply,
      hasStorm,
      iceConnected,
      joinOkAtMs: probe.joinOkAt,
      afterJoinLongTaskCount: afterJoinLong.length,
      maxLongTaskMs: maxLong,
      afterJoinRafStallCount: afterJoinRaf.length,
      maxRafGapMs: maxRafGap,
      heapSamples: (probe.heap || []).slice(-5),
      interestingLogs: interesting.slice(-40),
    },
    null,
    2,
  ),
);

await browser.close();
process.exit(
  verdict === "join_path_healthy_check_audio_path" ||
    verdict === "join_ok_but_ice_not_connected_silence" ||
    verdict === "webdriver_skips_sdp_apply_use_real_browser_for_audio"
    ? 0
    : 1,
);
