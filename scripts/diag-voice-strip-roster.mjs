import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const BASE = process.env.VOICE_TEST_URL ?? "https://program.hyperlinks.space";
const CHAT = process.env.VOICE_TEST_CHAT ?? "Укради Брейнрота";

async function dumpStrip(page) {
  return page.evaluate(() => {
    const preview = document.querySelector('[data-testid="voice-strip-preview"]');
    if (!preview) return { hasStrip: false };
    const avatars = preview.querySelectorAll("img, [data-hsp-avatar], canvas").length;
    const circles = [...preview.querySelectorAll("div")].filter((el) => {
      const s = getComputedStyle(el);
      const w = parseFloat(s.width);
      const h = parseFloat(s.height);
      return w >= 20 && w <= 40 && Math.abs(w - h) < 2 && s.borderRadius.includes("%") || parseFloat(s.borderRadius) >= w / 2 - 1;
    }).length;
    return {
      hasStrip: true,
      text: (preview.textContent || "").replace(/\s+/g, " ").trim(),
      avatarImgs: preview.querySelectorAll("img").length,
      roughCircles: circles,
      join: Boolean(document.querySelector('[data-testid="voice-strip-join-button"]')),
    };
  });
}

async function dumpDialog(page) {
  return page.evaluate(() => {
    const root = [...document.querySelectorAll("[data-voice-dialog]")].find(
      (el) => el.getAttribute("data-voice-dialog") === "open",
    );
    if (!root) return { open: false };
    const rows = [...root.querySelectorAll('[data-testid="voice-participant-row"], [data-voice-participant-row]')];
    const green = "#34c759";
    const micFills = rows.map((row) => {
      const path = row.querySelector("svg path");
      return (path?.getAttribute("fill") || "").toLowerCase();
    });
    const header = root.querySelector('[data-voice-sheet="1"]')?.innerText?.slice(0, 200) || "";
    return {
      open: true,
      rowCount: rows.length,
      rowTitles: rows.map((r) => (r.getAttribute("data-voice-participant-row") || r.textContent || "").slice(0, 40)),
      greenMicCount: micFills.filter((f) => f === green).length,
      micFills: micFills.slice(0, 8),
      headerSnippet: header.replace(/\s+/g, " ").trim().slice(0, 160),
    };
  });
}

async function main() {
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
  const logs = [];
  page.on("console", (m) => {
    const t = m.text();
    if (
      /roster_painted|participants_speaking|roster_speaking|voice_participants_stream_ready|webrtc_join_ok|force_reload|dialog_open/i.test(
        t,
      )
    ) {
      logs.push(t.slice(0, 280));
    }
  });

  try {
    await page.goto(`${BASE}/?t=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    const bundle = await page.evaluate(() => {
      const s = [...document.querySelectorAll("script[src]")].map((el) => el.getAttribute("src") || "");
      return s.find((x) => /index-[a-f0-9]+\.js/.test(x)) || null;
    });
    console.log("bundle", bundle);

    await page.waitForTimeout(5_000);
    await page.getByText("Messages", { exact: true }).first().click({ timeout: 20_000 });
    await page.waitForTimeout(2_000);
    await page.locator(`text=${CHAT}`).first().click({ timeout: 20_000 });
    await page.waitForTimeout(10_000);

    const strip1 = await dumpStrip(page);
    console.log("STRIP_BEFORE_JOIN", JSON.stringify(strip1));

    const join = page.getByTestId("voice-strip-join-button");
    if (await join.count()) await join.click({ force: true });
    else await page.getByTestId("voice-strip-preview").click({ force: true });

    await page.waitForTimeout(4_000);
    let dialog = await dumpDialog(page);
    console.log("DIALOG_T4", JSON.stringify(dialog));

    const watchUntil = Date.now() + 35_000;
    let best = dialog;
    while (Date.now() < watchUntil) {
      dialog = await dumpDialog(page);
      if (dialog.rowCount > (best.rowCount || 0)) best = dialog;
      if (dialog.greenMicCount > 0) {
        best = dialog;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    console.log("DIALOG_BEST", JSON.stringify(best));

    // Close dialog to free capacity, then sample strip again.
    await page.evaluate(() => {
      const el = document.querySelector('[data-voice-chrome="close"]');
      el?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await page.waitForTimeout(2_000);
    const strip2 = await dumpStrip(page);
    console.log("STRIP_AFTER_CLOSE", JSON.stringify(strip2));

    console.log(
      "KEY_LOGS",
      JSON.stringify(
        logs.filter((l) => /roster_painted|speaking|stream_ready|join_ok|force_reload/i.test(l)).slice(-20),
      ),
    );
  } finally {
    await browser.close();
    console.log("BROWSER_CLOSED");
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
