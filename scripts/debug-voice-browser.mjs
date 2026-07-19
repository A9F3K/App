import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

const TOKEN = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const OUT = "debug-voice-screens";
mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  try {
    await page.screenshot({
      path: pathJoin(OUT, name),
      timeout: 8_000,
      animations: "disabled",
    });
  } catch (err) {
    writeFileSync(
      pathJoin(OUT, name + ".fail.txt"),
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function evalOrTimeout(page, fn, ms = 2500) {
  return Promise.race([
    page.evaluate(fn),
    new Promise((r) => setTimeout(() => r("__timeout__"), ms)),
  ]);
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
  await context.addCookies([
    {
      name: "hs_auth_session",
      value: TOKEN,
      domain: "program.hyperlinks.space",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.grantPermissions(["microphone", "camera"], {
    origin: "https://program.hyperlinks.space",
  });

  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/messages_voice|speaking|sse_apply|dialog_|Error/i.test(text)) {
      logs.push(`[${msg.type()}] ${text.slice(0, 700)}`);
    }
  });

  await page.goto("https://program.hyperlinks.space/?t=pw-voice-final", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(5000);
  await page.getByText("Messages", { exact: true }).first().click();
  for (let i = 0; i < 40; i++) {
    if (await page.locator("text=Hyperlinks Space Program").first().isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }

  const chat = page.locator("text=Укради Брейнрота").first();
  const box = await chat.boundingBox();
  if (box) await page.mouse.click(box.x + 30, box.y + box.height / 2);
  await page.waitForTimeout(4000);

  const joinBox = await page.getByText("Join", { exact: true }).first().boundingBox();
  const tJoin = Date.now();
  if (joinBox) await page.mouse.click(joinBox.x + joinBox.width / 2, joinBox.y + joinBox.height / 2);

  let dialogOpenAt = 0;
  for (let i = 0; i < 40; i++) {
    const open = await evalOrTimeout(
      page,
      () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
    );
    if (open === true) {
      dialogOpenAt = Date.now() - tJoin;
      break;
    }
    if (open === "__timeout__") break;
    await page.waitForTimeout(250);
  }
  await shot(page, "40-dialog-open.png");

  // Keep dialog open and watch speaking for 20s
  await page.waitForTimeout(20_000);
  await shot(page, "41-dialog-speaking.png");

  const whileOpen = {
    speakingAppliedOpen: logs.filter((l) =>
      /speaking_applied/.test(l) && /popoverOpen=true/.test(l),
    ).length,
    speakingEvents: logs.filter((l) => /participants_speaking/.test(l)).length,
    sseApply: logs.filter((l) => /sse_apply/.test(l)).length,
    postjoin: logs.filter((l) => /postjoin_reload/.test(l)).length,
    forceReload: logs.filter((l) => /force_reload_ok/.test(l)),
  };

  // Escape close
  let escOk = false;
  let escMs = 0;
  const tEsc = Date.now();
  await page.keyboard.press("Escape");
  for (let i = 0; i < 40; i++) {
    const open = await evalOrTimeout(
      page,
      () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
    );
    if (open === false) {
      escOk = true;
      escMs = Date.now() - tEsc;
      break;
    }
    if (open === "__timeout__") break;
    await page.waitForTimeout(100);
  }
  await shot(page, "42-after-esc.png");

  // Reopen via avatar strip / participants label
  await page.waitForTimeout(800);
  const strip =
    (await page.locator("text=/\\d+\\s+participants/i").first().boundingBox().catch(() => null)) ||
    (await page.locator('[aria-label*="participant" i]').first().boundingBox().catch(() => null));
  if (strip) await page.mouse.click(strip.x + Math.min(60, strip.width / 2), strip.y + strip.height / 2);
  await page.waitForTimeout(2000);
  const reopened = await evalOrTimeout(
    page,
    () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
  );
  await shot(page, "43-reopened.png");

  // X close
  let xOk = false;
  let xMs = 0;
  if (reopened === true) {
    const t0 = Date.now();
    await page.evaluate(() => {
      document
        .querySelector('[data-voice-chrome="close"]')
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    for (let i = 0; i < 40; i++) {
      const open = await evalOrTimeout(
        page,
        () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
      );
      if (open === false) {
        xOk = true;
        xMs = Date.now() - t0;
        break;
      }
      if (open === "__timeout__") break;
      await page.waitForTimeout(100);
    }
  }
  await shot(page, "44-after-x.png");

  const report = {
    bundle: await page.evaluate(
      () =>
        [...document.scripts].map((s) => s.src).find((s) => /index-[a-f0-9]+\.js/.test(s)) || "",
    ),
    dialogOpenAt,
    whileOpen,
    escOk,
    escMs,
    reopened,
    xOk,
    xMs,
    speakingLogs: logs.filter((l) =>
      /speaking|sse_apply|speaking_applied|postjoin|force_reload|dialog_open/i.test(l),
    ),
    voiceLogs: logs.filter((l) => /messages_voice/i.test(l)),
  };
  writeFileSync(pathJoin(OUT, "report-final.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
