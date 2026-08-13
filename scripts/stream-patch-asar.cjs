/**
 * Fast asar hotpatch: copy original payload, append replaced/new files at end,
 * rewrite header offsets. Does not extract individual files.
 */
const asar = require("@electron/asar");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { Pickle } = require("@electron/asar/lib/pickle");
const { getFileIntegrity } = require("@electron/asar/lib/integrity");
const { readArchiveHeaderSync } = require("@electron/asar/lib/disk");

const ROOT = path.resolve(__dirname, "..");
const ASAR =
  process.env.HSP_ASAR ||
  "C:/Program Files/Hyperlinks Space Program/current/resources/app.asar";
const OUT =
  process.env.HSP_ASAR_OUT || path.join(ROOT, ".tmp-app.asar.new");
const SRC_WINDOWS = path.join(ROOT, "windows");

async function integrityForBuffer(buf) {
  return getFileIntegrity(Readable.from(buf));
}

function ensureFileNode(root, relPath) {
  const parts = relPath.split("/");
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (!node.files) node.files = {};
    if (isLast) {
      if (!node.files[part] || node.files[part].files) {
        node.files[part] = {};
      }
      return node.files[part];
    }
    if (!node.files[part]) node.files[part] = { files: {} };
    if (!node.files[part].files) node.files[part] = { files: {} };
    node = node.files[part];
  }
  throw new Error("empty path");
}

function payloadSizeFromHeader(header) {
  let max = 0;
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.files) {
      for (const child of Object.values(node.files)) walk(child);
      return;
    }
    if (typeof node.size === "number" && node.offset != null) {
      const end = Number(node.offset) + node.size;
      if (end > max) max = end;
    }
  }
  walk(header);
  return max;
}

async function main() {
  const replacements = {
    "windows/build.cjs": fs.readFileSync(path.join(SRC_WINDOWS, "build.cjs")),
    "windows/preload.cjs": fs.readFileSync(path.join(SRC_WINDOWS, "preload.cjs")),
    "windows/swap-coffee-fetch.cjs": fs.readFileSync(
      path.join(SRC_WINDOWS, "swap-coffee-fetch.cjs"),
    ),
  };

  console.log("reading header", ASAR);
  const { header, headerSize } = readArchiveHeaderSync(ASAR);
  // headerSize is the pickle string length; on-disk header region = 8 + headerSize (size pickle is 8 bytes)
  const sizePickleSize = 8;
  const payloadStart = sizePickleSize + headerSize;
  const srcStat = fs.statSync(ASAR);
  const oldPayloadSize = srcStat.size - payloadStart;
  const computedPayload = payloadSizeFromHeader(header);
  console.log({
    headerSize,
    payloadStart,
    oldPayloadSize,
    computedPayload,
    fileSize: srcStat.size,
  });

  // Clone header JSON
  const newHeader = JSON.parse(JSON.stringify(header));
  let appendAt = Math.max(oldPayloadSize, computedPayload);
  const appendChunks = [];

  for (const [rel, buf] of Object.entries(replacements)) {
    const integrity = await integrityForBuffer(buf);
    const node = ensureFileNode(newHeader, rel);
    // Keep as file node (not directory)
    delete node.files;
    node.size = buf.length;
    node.offset = String(appendAt);
    node.integrity = integrity;
    appendChunks.push(buf);
    appendAt += buf.length;
    console.log("replace", rel, "-> offset", node.offset, "size", node.size);
  }

  const headerJson = JSON.stringify(newHeader);
  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(headerJson);
  const headerBuf = headerPickle.toBuffer();
  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuf.length);
  const sizeBuf = sizePickle.toBuffer();

  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const out = fs.createWriteStream(OUT);

  const write = (buf) =>
    new Promise((resolve, reject) => {
      const ok = out.write(buf);
      if (ok) resolve();
      else out.once("drain", resolve);
      out.once("error", reject);
    });

  console.log("writing new header + copying payload...");
  await write(sizeBuf);
  await write(headerBuf);

  // Stream-copy old payload
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(ASAR, {
      start: payloadStart,
      end: srcStat.size - 1,
    });
    rs.on("error", reject);
    rs.on("end", resolve);
    rs.pipe(out, { end: false });
  });

  for (const buf of appendChunks) {
    await write(buf);
  }

  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });

  console.log("packed", fs.statSync(OUT).size);

  // Validate
  const preload = asar.extractFile(OUT, "windows/preload.cjs").toString("utf8");
  if (!preload.includes("fetchSwapCoffee")) throw new Error("preload missing bridge");
  const build = asar.extractFile(OUT, "windows/build.cjs").toString("utf8");
  if (!build.includes("registerSwapCoffeeFetchIpc")) throw new Error("build missing ipc");
  const mod = asar.extractFile(OUT, "windows/swap-coffee-fetch.cjs").toString("utf8");
  if (!mod.includes("hsp-swap-coffee-fetch")) throw new Error("module missing ipc handler");
  console.log("validation ok");

  const bak = ASAR + ".bak-pre-swap-coffee";
  if (!fs.existsSync(bak)) {
    console.log("backup original...");
    fs.copyFileSync(ASAR, bak);
  }
  console.log("installing...");
  fs.copyFileSync(OUT, ASAR);
  fs.unlinkSync(OUT);
  console.log("Done. Restart Hyperlinks Space Program.");
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
