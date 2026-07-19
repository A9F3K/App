import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const outDir = join("debug-voice-screens");
mkdirSync(outDir, { recursive: true });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1536, height: 900 },
    permissions: [],
  });
  // Never prompt for mic/camera during automated join (muted).
  await context.grantPermissions([], { origin: "https://program.hyperlinks.space" });
  await context.addCookies([
    {
      name: "hs_auth_session",
      value: token,
      domain: "program.hyperlinks.space",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      text.includes("messages_voice") ||
      text.includes("voice_") ||
      text.includes("page-display") ||
      text.includes("avatar")
    ) {
      logs.push(`[${msg.type()}] ${text.slice(0, 400)}`);
    }
  });
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));

  console.log("navigating...");
  await page.goto("https://program.hyperlinks.space/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(outDir, "01-home.png"), fullPage: false });

  const bundle = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll("script[src]")].map(
      (s) => s.src,
    );
    return scripts.find((s) => /index-[a-f0-9]+\.js/.test(s)) ?? "";
  });
  console.log("bundle", bundle);

  // Try to click Messages nav if present
  const messagesTab = page.getByText("Messages", { exact: false }).first();
  if (await messagesTab.count()) {
    await messagesTab.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  // Open the brainrot chat by title fragment
  const chat = page.getByText("Укради Брейнрота", { exact: false }).first();
  if (await chat.count()) {
    await chat.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
  } else {
    console.log("chat_title_not_found");
  }
  await page.screenshot({ path: join(outDir, "02-chat.png"), fullPage: false });

  // Click Join or voice strip
  const joinBtn = page.getByRole("button", { name: /join/i }).first();
  if (await joinBtn.count()) {
    console.log("clicking join");
    await joinBtn.click({ timeout: 5000 });
  } else {
    const openBtn = page.getByRole("button", { name: /open|voice/i }).first();
    if (await openBtn.count()) {
      console.log("clicking open/voice");
      await openBtn.click({ timeout: 5000 });
    } else {
      console.log("no_join_or_open_button");
    }
  }

  await page.waitForTimeout(1500);
  try {
    await page.screenshot({
      path: join(outDir, "03-dialog.png"),
      fullPage: false,
      timeout: 5000,
    });
  } catch (err) {
    console.log("screenshot_03_failed", err instanceof Error ? err.message : String(err));
    // Try Escape even if the renderer is wedged.
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  // Measure main-thread responsiveness via rAF delay (short timeout)
  let beforeCloseLag = null;
  try {
    beforeCloseLag = await Promise.race([
      page.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 5; i += 1) {
          const t0 = performance.now();
          await new Promise((r) => requestAnimationFrame(() => r()));
          samples.push(performance.now() - t0);
        }
        return samples;
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("raf_timeout")), 5000),
      ),
    ]);
  } catch (err) {
    console.log("raf_measure_failed", err instanceof Error ? err.message : String(err));
  }
  console.log("raf_samples_before_close", beforeCloseLag);

  // Try close via data attribute
  const closeEl = page.locator('[data-voice-chrome="close"]').first();
  let closeClicked = false;
  let escapePressed = false;
  try {
    if (await closeEl.count({ timeout: 2000 })) {
      console.log("clicking close X");
      await closeEl.click({ timeout: 3000, force: true });
      closeClicked = true;
    } else {
      console.log("close_button_missing — trying Escape");
      await page.keyboard.press("Escape");
      escapePressed = true;
    }
  } catch (err) {
    console.log("close_click_failed", err instanceof Error ? err.message : String(err));
    await page.keyboard.press("Escape").catch(() => undefined);
    escapePressed = true;
  }
  await page.waitForTimeout(1500);
  try {
    await page.screenshot({
      path: join(outDir, "04-after-close.png"),
      fullPage: false,
      timeout: 5000,
    });
  } catch (err) {
    console.log("screenshot_04_failed", err instanceof Error ? err.message : String(err));
  }

  let closeStillVisible = false;
  try {
    closeStillVisible = (await closeEl.count()) > 0;
  } catch {
    closeStillVisible = true;
  }
  console.log(
    JSON.stringify({
      bundle,
      closeClicked,
      escapePressed,
      closeStillVisible,
      raf_samples_before_close: beforeCloseLag,
      voiceLogs: logs.filter((l) => l.includes("voice")).slice(-40),
    }),
  );

  await browser.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
