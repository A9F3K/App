import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const BASE = process.env.VOICE_TEST_URL ?? "https://program.hyperlinks.space";

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
  if (/messages_voice_dialog_(open|close)/.test(t)) console.log("LOG", t.slice(0, 220));
});

await page.goto(`${BASE}/?t=${Date.now()}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
await page.waitForTimeout(8000);
const messagesBox = await page.getByText("Messages", { exact: true }).first().boundingBox();
await page.mouse.click(messagesBox.x + messagesBox.width / 2, messagesBox.y + messagesBox.height / 2);
await page.waitForTimeout(2500);
const chatBox = await page.locator("text=Укради Брейнрота").first().boundingBox();
await page.mouse.click(chatBox.x + 40, chatBox.y + chatBox.height / 2);
await page.waitForTimeout(10000);
const join = await page.locator('[data-testid="voice-strip-join-button"]').boundingBox();
if (!join) throw new Error("no join");
await page.mouse.click(join.x + join.width / 2, join.y + join.height / 2);
await page.waitForTimeout(2500);

const dump = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-voice-dialog]")].map((el) => ({
      attr: el.getAttribute("data-voice-dialog"),
      opacity: getComputedStyle(el).opacity,
      pe: getComputedStyle(el).pointerEvents,
      tag: el.tagName,
    })),
  );

console.log("BEFORE", JSON.stringify(await dump()));
await page.evaluate(() => {
  const el = document.querySelector('[data-voice-chrome="close"]');
  if (!el) throw new Error("no close");
  el.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
  );
});
const t0 = Date.now();
while (Date.now() - t0 < 5000) {
  console.log(`T+${Date.now() - t0}`, JSON.stringify(await dump()));
  await page.waitForTimeout(250);
}
await browser.close();
