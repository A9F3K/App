/**
 * Hotpatch installed Windows app.asar with Swap.Coffee main-process fetch
 * (IPC + preload + fetch shim). Does not rebuild the Expo dist bundle.
 */
const asar = require("@electron/asar");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASAR =
  process.env.HSP_ASAR ||
  "C:/Program Files/Hyperlinks Space Program/current/resources/app.asar";
const TMP = path.join(ROOT, ".tmp-asar-patch");
const OUT = path.join(ROOT, ".tmp-asar-patch", "app.asar.new");
const SRC_WINDOWS = path.join(ROOT, "windows");

function ensureWindowsFromAsar() {
  const winDir = path.join(TMP, "windows");
  fs.mkdirSync(winDir, { recursive: true });

  const all = asar.listPackage(ASAR);
  const files = all.filter((p) => {
    const n = String(p).replace(/\\/g, "/").replace(/^\//, "").toLowerCase();
    return n === "windows" || n.startsWith("windows/");
  });
  console.log(`asar windows entries: ${files.length}`);

  for (const f of files) {
    const rel = String(f).replace(/\\/g, "/").replace(/^\//, "");
    if (!rel || rel.endsWith("/")) continue;
    // Skip directory markers
    if (rel === "windows") continue;
    const dest = path.join(TMP, ...rel.split("/"));
    let buf = null;
    for (const candidate of [rel, rel.replace(/\//g, "\\"), "/" + rel]) {
      try {
        buf = asar.extractFile(ASAR, candidate);
        break;
      } catch (_) {}
    }
    if (!buf) {
      console.warn(`skip extract: ${rel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return winDir;
}

function overlaySourceWindows() {
  const copies = ["build.cjs", "preload.cjs", "swap-coffee-fetch.cjs"];
  for (const name of copies) {
    const src = path.join(SRC_WINDOWS, name);
    const dest = path.join(TMP, "windows", name);
    if (!fs.existsSync(src)) throw new Error(`missing source ${src}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`overlay ${name} (${fs.statSync(dest).size} bytes)`);
  }
}

async function main() {
  if (!fs.existsSync(ASAR)) throw new Error(`asar not found: ${ASAR}`);
  if (!fs.existsSync(TMP) || !fs.existsSync(path.join(TMP, "dist"))) {
    console.log("Full extract missing or incomplete; extracting asar (slow)...");
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    asar.extractAll(ASAR, TMP);
    console.log("extract done");
  } else {
    console.log("Reusing existing extract at", TMP);
  }

  ensureWindowsFromAsar();
  overlaySourceWindows();

  // Verify markers
  const build = fs.readFileSync(path.join(TMP, "windows", "build.cjs"), "utf8");
  if (!build.includes("registerSwapCoffeeFetchIpc")) {
    throw new Error("build.cjs overlay missing registerSwapCoffeeFetchIpc");
  }
  if (!fs.existsSync(path.join(TMP, "windows", "swap-coffee-fetch.cjs"))) {
    throw new Error("swap-coffee-fetch.cjs missing after overlay");
  }

  console.log("Packing asar...");
  await asar.createPackage(TMP, OUT);
  console.log("Packed:", OUT, fs.statSync(OUT).size);

  const packed = fs.readFileSync(OUT);
  for (const marker of [
    "registerSwapCoffeeFetchIpc",
    "hsp-swap-coffee-fetch",
    "swap.coffee fetch shim",
  ]) {
    if (!packed.includes(Buffer.from(marker))) {
      throw new Error(`packed asar missing marker: ${marker}`);
    }
    console.log("ok marker:", marker);
  }

  const dest = ASAR;
  const bak = ASAR + ".bak-pre-swap-coffee";
  if (!fs.existsSync(bak)) {
    console.log("Backing up original asar ->", bak);
    fs.copyFileSync(dest, bak);
  }
  console.log("Installing patched asar ->", dest);
  fs.copyFileSync(OUT, dest);
  console.log("Done. Restart Hyperlinks Space Program to load tokens.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
