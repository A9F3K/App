/**
 * Headless voice dialog smoke test against production.
 * Avoids Cursor browser MCP (it hangs); uses Playwright + mint-session cookie.
 *
 * Usage: node scripts/diag-voice-e2e.mjs
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const BASE = process.env.VOICE_TEST_URL ?? "https://program.hyperlinks.space";
const CHAT = process.env.VOICE_TEST_CHAT ?? "Укради Брейнрота";
const TIMEOUT = 90_000;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".diag-voice");

const logs = [];
const interesting = (t) =>
  /messages_voice_|voice_dialog_|webrtc_join|postjoin|roster_painted|longtask|chats_poll_deferred|skip_fetch|history_prefetch_dropped/.test(
    t,
  );

function summarize(label, pageLogs) {
  const picks = pageLogs.filter(interesting);
  console.log(`\n=== ${label} (${picks.length} voice-related logs) ===`);
  for (const line of picks.slice(-60)) console.log(line.slice(0, 240));
}

async function dumpDialogState(page, label) {
  // Keep this cheap — scanning body * under voice longtasks hangs Playwright.
  let state = null;
  try {
    state = await Promise.race([
      page.evaluate(() => {
        const nodes = [...document.querySelectorAll("[data-voice-dialog]")].map((el) => ({
          attr: el.getAttribute("data-voice-dialog"),
          display: getComputedStyle(el).display,
          opacity: getComputedStyle(el).opacity,
          pe: getComputedStyle(el).pointerEvents,
          z: getComputedStyle(el).zIndex,
          text: (el.innerText || "").slice(0, 160),
        }));
        return {
          nodes,
          mic: !!document.querySelector('[aria-label="Microphone"]'),
          screen: !!document.querySelector('[aria-label="Screen share"]'),
          close: !!document.querySelector('[data-voice-chrome="close"]'),
          back: !!document.querySelector('[aria-label="Back"]'),
          joinBtn: !!document.querySelector('[data-testid="voice-strip-join-button"]'),
        };
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("dump_evaluate_timeout")), 8_000),
      ),
    ]);
  } catch (err) {
    state = { error: err instanceof Error ? err.message : String(err) };
  }
  console.log(`DUMP[${label}]`, JSON.stringify(state, null, 2));
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const shot = join(OUT_DIR, `voice-${label}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false, timeout: 5_000 });
    console.log("SHOT", shot);
  } catch (err) {
    console.log("SHOT_FAIL", err instanceof Error ? err.message : String(err));
  }
  return state;
}

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
page.on("console", (m) => {
  const t = m.text();
  logs.push(t);
  if (interesting(t)) console.log("LOG", t.slice(0, 220));
});
page.on("pageerror", (err) => {
  const t = `PAGEERROR ${err.message}`;
  logs.push(t);
  console.log(t);
});

const result = {
  openOk: false,
  closeOk: false,
  micToggleOk: false,
  screenShareClicked: false,
  listedBeforeClose: 0,
  hintBeforeClose: 0,
  stuck: false,
  errors: [],
};

try {
  console.log("goto", BASE);
  await page.goto(`${BASE}/?e2e=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await page.waitForTimeout(6_000);

  const messages = page.getByText("Messages", { exact: true }).first();
  await messages.click({ timeout: 15_000 });
  await page.waitForTimeout(2_000);

  const chat = page.locator(`text=${CHAT}`).first();
  await chat.click({ timeout: 20_000 });
  await page.waitForTimeout(8_000);

  const join =
    (await page.locator('[data-testid="voice-strip-join-button"]').first().boundingBox()) ||
    (await page.getByRole("button", { name: /^Join$/ }).first().boundingBox());
  if (!join) throw new Error("Join button not found — is the voice call live?");
  await page.mouse.click(join.x + join.width / 2, join.y + join.height / 2);

  // Poll for dialog; dump state along the way if slow.
  let open = false;
  const openDeadline = Date.now() + 20_000;
  while (Date.now() < openDeadline) {
    const count = await page.locator("[data-voice-dialog]").count();
    const openCount = await page.locator('[data-voice-dialog="open"]').count();
    if (openCount > 0 || count > 0) {
      open = openCount > 0 || count > 0;
      if (openCount > 0) break;
    }
    const joinedLog = logs.some((l) => /messages_voice_webrtc_join_ok/.test(l));
    if (joinedLog && Date.now() > openDeadline - 12_000) {
      await dumpDialogState(page, "after-join-ok-no-dialog");
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!open) {
    await dumpDialogState(page, "open-timeout");
    // Fallback: detect sheet by chrome controls even if attr missing
    const fallback = await page.evaluate(
      () =>
        !!document.querySelector('[data-voice-chrome="close"]') ||
        !!document.querySelector('[aria-label="Microphone"]'),
    );
    if (!fallback) throw new Error("voice dialog never appeared in DOM");
    console.log("OPEN via fallback controls (no data-voice-dialog)");
  }

  result.openOk = true;
  console.log("OPEN ok");

  // Wait briefly for postjoin — prefer console signals over DOM dumps.
  await page.waitForTimeout(3_000);
  const postJoinLogs = logs.filter((l) =>
    /postjoin_reload_(ok|fail|give_up)|roster_painted/.test(l),
  );
  console.log(
    "POSTJOIN signals",
    postJoinLogs.slice(-8).map((l) => l.slice(0, 180)),
  );

  // Keep roster probe cheap and time-bounded — innerText on a frozen sheet hangs forever.
  let roster = {
    hint: 0,
    lines: [],
    hasMic: false,
    hasScreen: false,
    hasClose: false,
    error: null,
  };
  try {
    roster = await Promise.race([
      page.evaluate(() => {
        const el =
          document.querySelector('[data-voice-dialog="open"]') ||
          document.querySelector("[data-voice-dialog]");
        const text = (el?.innerText || "").slice(0, 1200);
        const hintMatch = text.match(/(\d+)\s+participants?/i);
        const lines = text
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          hint: hintMatch ? Number(hintMatch[1]) : 0,
          lines: lines.slice(0, 30),
          hasMic: !!document.querySelector('[aria-label="Microphone"]'),
          hasScreen: !!document.querySelector('[aria-label="Screen share"]'),
          hasClose:
            !!document.querySelector('[data-voice-chrome="close"]') ||
            !!document.querySelector('[aria-label="Back"]'),
          error: null,
        };
      }),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              hint: 0,
              lines: [],
              hasMic: false,
              hasScreen: false,
              hasClose: false,
              error: "roster_evaluate_timeout",
            }),
          8_000,
        ),
      ),
    ]);
  } catch (err) {
    roster = {
      ...roster,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (roster.error) {
    result.errors.push(roster.error);
    result.stuck = true;
    console.log("ROSTER_TIMEOUT", roster.error);
  }
  result.hintBeforeClose = roster.hint;
  result.listedBeforeClose = Math.max(
    0,
    roster.lines.filter(
      (l) =>
        l.length > 1 &&
        l.length < 48 &&
        !/participant|Укради|Back|More|Join|Leave|Mute|Camera|Message|Screen/i.test(l),
    ).length,
  );
  console.log("ROSTER", JSON.stringify(roster));

  if (!roster.error) {
    // Mic / screen — force clicks so actionability waits cannot hang forever.
    const mic = page.locator('[aria-label="Microphone"]').first();
    if ((await mic.count()) > 0) {
      await mic.click({ force: true, timeout: 3_000 });
      await page.waitForTimeout(500);
      await mic.click({ force: true, timeout: 3_000 });
      await page.waitForTimeout(500);
      result.micToggleOk = true;
      console.log("MIC toggle ok");
    } else {
      result.errors.push("mic_button_missing");
    }

    const screen = page.locator('[aria-label="Screen share"]').first();
    if ((await screen.count()) > 0) {
      await screen.click({ force: true, timeout: 3_000 });
      await page.waitForTimeout(800);
      result.screenShareClicked = true;
      console.log("SCREEN share clicked");
      try {
        await screen.click({ force: true, timeout: 2_000 });
      } catch {
        /* ignore */
      }
      await page.waitForTimeout(400);
    } else {
      result.errors.push("screen_button_missing");
    }
  }

  // Close via chrome close or Back — if already closed (e.g. Drop mis-hit), treat as ok.
  const alreadyClosed = await page.evaluate(
    () =>
      ![...document.querySelectorAll("[data-voice-dialog]")].some(
        (el) => el.getAttribute("data-voice-dialog") === "open",
      ),
  );
  if (alreadyClosed) {
    result.closeOk = true;
    console.log("CLOSE already closed");
  } else {
  let closeBox = null;
  try {
    closeBox = await Promise.race([
      page.locator('[data-voice-chrome="close"]').first().boundingBox(),
      new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]);
  } catch {
    closeBox = null;
  }
  if (!closeBox) {
    try {
      closeBox = await page.getByRole("button", { name: "Back" }).first().boundingBox({
        timeout: 3_000,
      });
    } catch {
      closeBox = null;
    }
  }
  if (!closeBox) throw new Error("close control missing");
  await page.mouse.click(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);

  const t0 = Date.now();
  let closed = false;
  while (Date.now() - t0 < 5_000) {
    let stillOpen = true;
    try {
      stillOpen = await Promise.race([
        page.evaluate(
          () =>
            [...document.querySelectorAll("[data-voice-dialog]")].some(
              (el) => el.getAttribute("data-voice-dialog") === "open",
            ),
        ),
        new Promise((resolve) => setTimeout(() => resolve(true), 2_000)),
      ]);
    } catch {
      stillOpen = true;
    }
    if (!stillOpen) {
      closed = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  result.closeOk = closed;
  result.stuck = result.stuck || !closed;
  console.log(closed ? "CLOSE ok" : "CLOSE stuck");
  if (!closed) await dumpDialogState(page, "close-stuck");
  }
  // Skip reopen when already stuck — reopen would hang the runner.
  if (!result.stuck) {
    await page.waitForTimeout(1_000);
    const openAgain =
      (await page.locator('[data-testid="voice-strip-join-button"]').first().boundingBox()) ||
      (await page.getByRole("button", { name: /Open voice chat|Join/ }).first().boundingBox());
    if (openAgain) {
      await page.mouse.click(openAgain.x + openAgain.width / 2, openAgain.y + openAgain.height / 2);
      await page.waitForTimeout(2_500);
      await dumpDialogState(page, "reopen");
      const reopen = await page.locator("[data-voice-dialog]").count();
      console.log("REOPEN dialog count", reopen);
      const back = page.getByRole("button", { name: "Back" }).first();
      if (await back.count()) await back.click({ force: true, timeout: 3_000 });
      await page.waitForTimeout(1_000);
    }
  }
} catch (err) {
  result.errors.push(err instanceof Error ? err.message : String(err));
  console.error("FAIL", err);
  try {
    await dumpDialogState(page, "fail");
  } catch {
    /* ignore */
  }
} finally {
  summarize("voice logs", logs);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, "last-result.json"),
    JSON.stringify({ result, logs: logs.filter(interesting) }, null, 2),
  );
  console.log("\nRESULT", JSON.stringify(result, null, 2));
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("browser_close_timeout")), 8_000),
      ),
    ]);
  } catch (err) {
    console.log("BROWSER_CLOSE", err instanceof Error ? err.message : String(err));
    try {
      browser.close();
    } catch {
      /* ignore */
    }
  }
}

const failed =
  !result.openOk ||
  !result.closeOk ||
  result.stuck ||
  result.errors.some((e) => !/screen_button|mic_button/.test(e));
process.exit(failed ? 1 : 0);
