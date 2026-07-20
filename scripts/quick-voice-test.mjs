import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 900 } });
  await context.addCookies([
    {
      name: "hs_auth_session",
      value: token,
      domain: "program.hyperlinks.space",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (
      /voice_dialog|messages_voice|messages_chats_stream_revision|roster_apply_cost/i.test(
        text,
      )
    ) {
      const line = `[${msg.type()}] ${text.slice(0, 500)}`;
      logs.push(line);
      console.log(line);
    }
  });

  await page.goto("https://program.hyperlinks.space/?t=quick-voice", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  await page.getByText("Messages", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  const chat = page.locator("text=Укради Брейнрота").first();
  if (await chat.count()) await chat.click();
  await page.waitForTimeout(3000);

  const join = page.getByText("Join", { exact: true }).first();
  if (await join.count()) await join.click();
  await page.waitForTimeout(2500);

  const rafOpen = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await new Promise((r) => requestAnimationFrame(() => r()));
      samples.push(performance.now() - t0);
    }
    return samples;
  });
  console.log("raf_while_open", rafOpen);

  await page.evaluate(() => {
    document
      .querySelector('[data-voice-chrome="close"]')
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  await page.waitForTimeout(2000);

  const closed = !(await page.evaluate(() =>
    Boolean(document.querySelector('[data-voice-chrome="close"]')),
  ));
  console.log("close_ok", closed);

  const rafAfter = await page.evaluate(async () => {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await new Promise((r) => requestAnimationFrame(() => r()));
      samples.push(performance.now() - t0);
    }
    return samples;
  });
  console.log("raf_after_close", rafAfter);

  console.log(
    JSON.stringify({
      voiceLogCount: logs.length,
      longtasks: logs.filter((l) => /longtask/i.test(l)),
      deferred: logs.filter((l) => /revision_deferred/i.test(l)),
      rosterCost: logs.filter((l) => /roster_apply_cost/i.test(l)),
      dialogOpen: logs.filter((l) => /dialog_open/i.test(l)),
    }),
  );

  await browser.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
