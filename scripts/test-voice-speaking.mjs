import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const GREEN = "#34c759";

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
    if (/messages_voice|voice_participants_speaking|roster_speaking/i.test(text)) {
      logs.push(text.slice(0, 500));
      console.log(text.slice(0, 500));
    }
  });

  await page.goto(`https://program.hyperlinks.space/?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);
  await page.getByText("Messages", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.locator("text=Укради Брейнрота").first().click();
  await page.waitForTimeout(8000);

  const joinBtn = page.getByTestId("voice-strip-join-button");
  if (await joinBtn.count()) await joinBtn.click({ force: true });
  else await page.getByTestId("voice-strip-preview").click({ force: true });

  await page.waitForSelector('[data-voice-chrome="close"]', { timeout: 25000 });

  // Watch SSE speaking + mic paint for up to 45s (active call required).
  const started = Date.now();
  let sawSpeakingEvent = false;
  let sawGreenMic = false;
  while (Date.now() - started < 45_000) {
    if (
      logs.some(
        (l) =>
          /participants_speaking|roster_speaking_applied/i.test(l) &&
          /speakingCount=[1-9]/i.test(l),
      )
    ) {
      sawSpeakingEvent = true;
    }
    const micState = await page.evaluate((green) => {
      const rows = [...document.querySelectorAll('[data-testid="voice-participant-row"]')];
      return rows.map((row) => {
        const path = row.querySelector("svg path");
        const fill = path?.getAttribute("fill")?.toLowerCase() ?? "";
        const border = getComputedStyle(row.querySelector("div") ?? row).borderColor;
        return { fill, border, text: row.textContent?.slice(0, 40) };
      });
    }, GREEN);
    if (micState.some((r) => r.fill === green)) {
      sawGreenMic = true;
      console.log("green_mic_detected", micState.filter((r) => r.fill === green));
      break;
    }
    await page.waitForTimeout(500);
  }

  console.log(
    JSON.stringify(
      {
        sawSpeakingEvent,
        sawGreenMic,
        speakingLogs: logs.filter((l) => /speaking/i.test(l)).slice(-15),
      },
      null,
      2,
    ),
  );

  await browser.close();
  if (!sawSpeakingEvent && !sawGreenMic) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
