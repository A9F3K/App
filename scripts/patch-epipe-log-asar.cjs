/**
 * Hotpatch installed asar: fix EPIPE→log infinite loop that filled main.log to multi-GB.
 */
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
const OUT = path.join(ROOT, ".tmp-app.asar.epipe");
const REL = "windows/build.cjs";
const SRC = path.join(ROOT, "windows", "build.cjs");

function ensureFileNode(root, relPath) {
  const parts = relPath.split("/");
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (!node.files) node.files = {};
    if (isLast) {
      if (!node.files[part] || node.files[part].files) node.files[part] = {};
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
  const patched = fs.readFileSync(SRC);
  if (!patched.includes("EPIPE") || !patched.includes("log truncated")) {
    throw new Error("source build.cjs missing EPIPE/log-cap fix");
  }

  const { header, headerSize } = readArchiveHeaderSync(ASAR);
  const newHeader = JSON.parse(JSON.stringify(header));
  const srcStat = fs.statSync(ASAR);
  const payloadStart = 8 + headerSize;
  const oldPayloadSize = srcStat.size - payloadStart;
  const appendAt = Math.max(oldPayloadSize, payloadSizeFromHeader(header));
  const integrity = await getFileIntegrity(Readable.from(patched));
  const node = ensureFileNode(newHeader, REL);
  delete node.files;
  node.size = patched.length;
  node.offset = String(appendAt);
  node.integrity = integrity;

  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(newHeader));
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

  await write(sizeBuf);
  await write(headerBuf);
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(ASAR, {
      start: payloadStart,
      end: srcStat.size - 1,
    });
    rs.on("error", reject);
    rs.on("end", resolve);
    rs.pipe(out, { end: false });
  });
  await write(patched);
  await new Promise((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  console.log("packed", fs.statSync(OUT).size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
