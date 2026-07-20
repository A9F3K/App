/**
 * Live Vercel test: voice preview opens dialog; X / Escape / backdrop close freely.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const token = JSON.parse(readFileSync("mint-session-out.json", "utf8")).token;
const BASE = process.env.VOICE_TEST_URL ?? "https://program.hyperlinks.space";

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(page, fn, { timeoutMs = 15000, label = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await withTimeout(page.evaluate(fn), 3000, `eval ${label}`);
      if (value) return value;
    } catch {
      // page may be briefly wedged — keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout: ${label}`);
}

/** Prefer data-voice-dialog so delayed-unmount still reports closed. */
function isDialogOpenInPage() {
  const root = document.querySelector("[data-voice-dialog]");
  if (root) return root.getAttribute("data-voice-dialog") === "open";
  return Boolean(document.querySelector('[data-voice-chrome="close"]'));
}

async function waitForDialog(page, open, label) {
  await waitFor(
    page,
    () => {
      const root = document.querySelector("[data-voice-dialog]");
      if (root) return (root.getAttribute("data-voice-dialog") === "open") === open;
      const hasClose = Boolean(document.querySelector('[data-voice-chrome="close"]'));
      return open ? hasClose : !hasClose;
    },
    { timeoutMs: open ? 25000 : 12000, label },
  );
}

async function dialogOpen(page) {
  try {
    return await withTimeout(page.evaluate(isDialogOpenInPage), 3000, "dialogOpen");
  } catch {
    return null;
  }
}

async function stripState(page) {
  return withTimeout(
    page.evaluate(() => {
      const preview = document.querySelector('[data-testid="voice-strip-preview"]');
      const join = document.querySelector('[data-testid="voice-strip-join-button"]');
      const root = document.querySelector("[data-voice-dialog]");
      const open =
        root != null
          ? root.getAttribute("data-voice-dialog") === "open"
          : Boolean(document.querySelector('[data-voice-chrome="close"]'));
      const close = open
        ? document.querySelector('[data-voice-chrome="close"]')
        : null;
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return {
        hasPreview: Boolean(preview),
        hasJoin: Boolean(join),
        dialogOpen: open,
        previewBox: box(preview),
        joinBox: box(join),
        closeBox: box(close),
      };
    }),
    5000,
    "stripState",
  );
}

async function mouseClickCenter(page, box) {
  if (!box || box.w <= 0 || box.h <= 0) return false;
  await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
  return true;
}

async function openViaStrip(page, cachedPreviewBox) {
  let state;
  try {
    state = await stripState(page);
  } catch (err) {
    if (cachedPreviewBox) {
      await mouseClickCenter(page, cachedPreviewBox);
      return { via: "cached_preview", error: String(err.message || err) };
    }
    throw err;
  }
  if (state.hasJoin && state.joinBox) {
    await mouseClickCenter(page, state.joinBox);
    return { via: "join", ...state };
  }
  if (state.hasPreview && state.previewBox) {
    await mouseClickCenter(page, state.previewBox);
    return { via: "preview", ...state };
  }
  if (cachedPreviewBox) {
    await mouseClickCenter(page, cachedPreviewBox);
    return { via: "cached_preview", ...state };
  }
  throw new Error(`no strip to click: ${JSON.stringify(state)}`);
}

async function closeViaX(page) {
  const state = await stripState(page);
  if (!state.closeBox) {
    return withTimeout(
      page.evaluate(() => {
        const root = document.querySelector('[data-voice-dialog="open"]');
        if (!root) return false;
        const el = root.querySelector('[data-voice-chrome="close"]');
        if (!el) return false;
        el.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
        );
        return true;
      }),
      3000,
      "closeX eval",
    );
  }
  await mouseClickCenter(page, state.closeBox);
  return true;
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
  const origin = new URL(BASE).origin;
  const context = await browser.newContext({
    viewport: { width: 1536, height: 900 },
    permissions: ["microphone", "camera"],
  });
  await context.grantPermissions(["microphone", "camera"], { origin });
  await context.addCookies([
    {
      name: "hs_auth_session",
      value: token,
      domain: new URL(BASE).hostname,
      path: "/",
      secure: BASE.startsWith("https"),
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (/messages_voice|voice_dialog/i.test(text)) {
      logs.push(text.slice(0, 400));
      console.log(text.slice(0, 400));
    }
  });
  page.setDefaultTimeout(15_000);
  let cachedPreviewBox = null;

  await page.goto(`${BASE}/?t=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 8000));
  const bundle = await withTimeout(
    page.evaluate(
      () =>
        [...document.scripts].map((s) => s.src).find((s) => /index-[a-f0-9]+\.js/.test(s)) ||
        "",
    ),
    5000,
    "bundle",
  ).catch(() => "");
  console.log("bundle", bundle);

  const messagesBox = await withTimeout(
    page.getByText("Messages", { exact: true }).first().boundingBox(),
    10000,
    "messages box",
  ).catch(() => null);
  if (!messagesBox) throw new Error("Messages nav not found");
  await page.mouse.click(
    messagesBox.x + messagesBox.width / 2,
    messagesBox.y + messagesBox.height / 2,
  );
  await new Promise((r) => setTimeout(r, 2500));

  const chatBox = await withTimeout(
    page.locator("text=Укради Брейнрота").first().boundingBox(),
    15000,
    "chat box",
  ).catch(() => null);
  if (!chatBox) throw new Error("chat not found");
  await page.mouse.click(chatBox.x + 40, chatBox.y + chatBox.height / 2);
  await new Promise((r) => setTimeout(r, 10000));

  const before = await stripState(page);
  cachedPreviewBox = before.previewBox;
  console.log("strip_before", JSON.stringify(before));

  // 1) Open
  const o1 = await openViaStrip(page, cachedPreviewBox);
  if (o1.previewBox) cachedPreviewBox = o1.previewBox;
  console.log("open1_click", o1.via);
  await waitForDialog(page, true, "dialog opens on preview/join click");
  const open1 = true;
  console.log("open1", open1);
  await new Promise((r) => setTimeout(r, 2000));

  // 2) Close via X
  console.log("closeX", await closeViaX(page));
  await waitForDialog(page, false, "closed via X");
  const closedX = true;
  try {
    const afterX = await stripState(page);
    if (afterX.previewBox) cachedPreviewBox = afterX.previewBox;
    console.log("closedX", closedX, JSON.stringify(afterX));
  } catch {
    console.log("closedX", closedX, "stripState_timeout");
  }

  // 3) Reopen via preview
  await new Promise((r) => setTimeout(r, 1000));
  const o2 = await openViaStrip(page, cachedPreviewBox);
  if (o2.previewBox) cachedPreviewBox = o2.previewBox;
  console.log("open2_click", o2.via);
  await waitForDialog(page, true, "reopen via preview");
  const open2 = true;
  console.log("open2", open2);

  // 4) Escape
  await page.keyboard.press("Escape");
  await waitForDialog(page, false, "closed via Escape");
  const closedEsc = true;
  console.log("closedEsc", closedEsc);

  // 5) Reopen + backdrop — wait past deferred chat-list flush so CDP is responsive
  await new Promise((r) => setTimeout(r, 3200));
  console.log("open3_preclick", JSON.stringify(cachedPreviewBox));
  if (!cachedPreviewBox) throw new Error("no cached preview box");
  await withTimeout(
    page.mouse.click(
      cachedPreviewBox.x + cachedPreviewBox.w / 2,
      cachedPreviewBox.y + cachedPreviewBox.h / 2,
    ),
    8000,
    "open3 mouse",
  );
  console.log("open3_clicked");
  await waitForDialog(page, true, "reopen for backdrop");
  console.log("open3_open");
  await page.mouse.click(40, 40);
  await waitForDialog(page, false, "closed via backdrop");
  const closedBackdrop = true;
  console.log("closedBackdrop", closedBackdrop);

  // 6) Final preview open + X — wait past deferred chat-list flush (2.5s)
  await new Promise((r) => setTimeout(r, 2800));
  await withTimeout(
    page.mouse.click(
      cachedPreviewBox.x + cachedPreviewBox.w / 2,
      cachedPreviewBox.y + cachedPreviewBox.h / 2,
    ),
    8000,
    "open4 mouse",
  );
  console.log("open4_clicked");
  await waitForDialog(page, true, "final reopen");
  const open4 = true;
  console.log("open4", open4);
  let closedFinal = false;
  try {
    console.log("closeX2", await withTimeout(closeViaX(page), 8000, "closeX2"));
    await waitForDialog(page, false, "final close");
    closedFinal = true;
  } catch (err) {
    console.log("closeX2_fallback_escape", String(err.message || err));
    await page.keyboard.press("Escape");
    await waitForDialog(page, false, "final close escape");
    closedFinal = true;
  }

  const result = {
    base: BASE,
    open1,
    closedX,
    open2,
    closedEsc,
    closedBackdrop,
    open4,
    closedFinal,
    pass: open1 && closedX && open2 && closedEsc && closedBackdrop && open4 && closedFinal,
    closeLogs: logs
      .filter((l) => /close|strip_press|open_request|swallowed|open_blocked/i.test(l))
      .slice(-30),
  };
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.pass) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
