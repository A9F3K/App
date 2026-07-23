import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const BASE = "https://program.hyperlinks.space";
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
let heartbeats = 0;
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("VOICE_HB ")) {
    heartbeats += 1;
    return;
  }
  if (
    /webrtc_join_ok|postjoin|session_joined_commit|voice-sdp-answer|apply_/.test(t)
  ) {
    console.log("LOG", t.slice(0, 220));
    logs.push(t);
  }
});
await page.goto(`${BASE}/?p=${Date.now()}`, {
  waitUntil: "domcontentloaded",
  timeout: 90_000,
});
await page.waitForTimeout(5_000);
// Heartbeat via console — survives evaluate queue wedging.
await page.evaluate(() => {
  window.setInterval(() => {
    console.log("VOICE_HB", Date.now());
  }, 500);
});
await page.getByText("Messages", { exact: true }).first().click({ timeout: 15_000 });
await page.waitForTimeout(2_000);
await page.locator("text=Укради Брейнрота").first().click({ timeout: 20_000 });
await page.waitForTimeout(8_000);
const join = await page
  .locator('[data-testid="voice-strip-join-button"]')
  .first()
  .boundingBox();
if (!join) throw new Error("no join");
await page.mouse.click(join.x + join.width / 2, join.y + join.height / 2);
await page.locator("[data-voice-dialog]").first().waitFor({
  state: "attached",
  timeout: 15_000,
});
console.log("OPEN");
const tJoin = Date.now();
while (Date.now() - tJoin < 30_000 && !logs.some((l) => /webrtc_join_ok/.test(l))) {
  await page.waitForTimeout(200);
}
console.log("join_ok", logs.some((l) => /webrtc_join_ok/.test(l)), "ms", Date.now() - tJoin);
const hbAtJoin = heartbeats;
for (let i = 0; i < 20; i++) {
  const before = heartbeats;
  await page.waitForTimeout(1_000);
  const after = heartbeats;
  console.log(
    `T+${i}s hb=${after} delta=${after - before} sinceJoin=${after - hbAtJoin}`,
  );
}
console.log(
  "key logs",
  logs.filter((l) => /join_ok|joined_commit|postjoin|sdp-answer|apply_/.test(l)).map((l) => l.slice(0, 180)),
);
await browser.close();
