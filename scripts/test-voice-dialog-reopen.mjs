import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;

async function waitFor(page, fn, { timeoutMs = 25000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await page.evaluate(fn).catch(() => null);
    if (value) return value;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1536, height: 900 } });
  await context.grantPermissions([], { origin: "https://program.hyperlinks.space" });
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
    if (/messages_voice|voice_dialog|roster_painted/i.test(text)) {
      logs.push(text.slice(0, 500));
      console.log(text.slice(0, 500));
    }
  });

  await page.goto(`https://program.hyperlinks.space/?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);

  const bundle = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll("script[src]")].map((s) => s.src);
    return scripts.find((s) => /index-[a-f0-9]+\.js/.test(s)) ?? "";
  });
  console.log("bundle", bundle);

  await page.getByText("Messages", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator("text=Укради Брейнрота").first().click();
  await page.waitForTimeout(10000);

  const joinBtn = page.getByTestId("voice-strip-join-button");
  const previewStrip = page.getByTestId("voice-strip-preview");
  if (await joinBtn.count()) {
    await joinBtn.click({ force: true, timeout: 10000 });
  } else if (await previewStrip.count()) {
    await previewStrip.click({ force: true, timeout: 10000 });
  } else {
    throw new Error("voice strip not found");
  }

  await waitFor(
    page,
    () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
    { label: "voice dialog open" },
  );

  const header1 = await page.evaluate(() => {
    const countTexts = [...document.querySelectorAll("*")]
      .map((el) => (el.textContent || "").trim())
      .filter((t) => /participant/i.test(t));
    const rows = [...document.querySelectorAll('[data-testid="voice-participant-row"]')]
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    const countNum = countTexts[0]?.match(/(\d+)/)?.[1];
    return { countTexts: countTexts.slice(0, 3), rowCount: rows.length, countNum, rows: rows.slice(0, 6) };
  });

  await page.locator('[data-voice-chrome="close"]').click({ force: true });
  await page.waitForTimeout(800);

  const closed = await page.evaluate(
    () => !document.querySelector('[data-voice-chrome="close"]'),
  );

  await previewStrip.click({ force: true, timeout: 10000 });
  await page.waitForTimeout(400);

  let open2 = false;
  try {
    await waitFor(
      page,
      () => Boolean(document.querySelector('[data-voice-chrome="close"]')),
      { timeoutMs: 10000, label: "voice dialog reopen" },
    );
    open2 = true;
  } catch {
    open2 = false;
  }

  const countMismatchPainted = logs
    .filter((l) => /roster_painted/i.test(l))
    .some((l) => {
      const m = l.match(/listed=(\d+).*count=(\d+)/);
      return m && m[1] !== m[2];
    });
  const countMismatchHeader =
    header1.countNum != null && header1.rowCount > 0
      ? Number(header1.countNum) !== header1.rowCount
      : false;

  console.log(
    JSON.stringify(
      {
        bundle,
        closed,
        open2,
        countMismatchPainted,
        countMismatchHeader,
        header1,
        stripPress: logs.filter((l) => /strip_press|open_request|dialog_open|join_start/i.test(l)),
        painted: logs.filter((l) => /roster_painted/i.test(l)).slice(-5),
        close: logs.filter((l) => /close_click|dialog_close|swallowed/i.test(l)),
      },
      null,
      2,
    ),
  );

  await browser.close();
  if (!closed || !open2 || countMismatchPainted || countMismatchHeader) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
