const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { Pickle } = require("@electron/asar/lib/pickle");
const { getFileIntegrity } = require("@electron/asar/lib/integrity");
const { readArchiveHeaderSync } = require("@electron/asar/lib/disk");

const ROOT = path.resolve(__dirname, "..");
const ASAR =
  "C:/Program Files/Hyperlinks Space Program/current/resources/app.asar";
const OUT = path.join(ROOT, ".tmp-app.asar.sparkline");
const REL = "dist/_expo/static/js/web/index-9d007af5f0410228ddbd434b3489e8e5.js";
const LOCAL = path.join(ROOT, ".tmp-index-bundle.js");

const OLD =
  "c=1,f=Math.max(t.CHART_RATE_LIMIT_MS+400,1500),h=4e3,y=24e3,p=40,C=6e4,w=48";
const NEU =
  "c=2,f=Math.max(t.CHART_RATE_LIMIT_MS+40,1100),h=4e3,y=24e3,p=240,C=6e4,w=48";

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

function find(node, parts) {
  if (!node || !parts.length) return node;
  return find(node.files && node.files[parts[0]], parts.slice(1));
}

async function main() {
  if (OLD.length !== NEU.length) throw new Error(`length ${OLD.length} vs ${NEU.length}`);
  let s = fs.readFileSync(LOCAL, "utf8");
  if (!s.includes(OLD)) throw new Error("pattern not found");
  s = s.replace(OLD, NEU);
  if (!s.includes(NEU) || s.includes(OLD)) throw new Error("replace failed");
  const patched = Buffer.from(s, "utf8");
  console.log("patched bytes", patched.length);

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
  console.log("append at", appendAt);

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

  const { header: h2, headerSize: hs2 } = readArchiveHeaderSync(OUT);
  const f = find(h2, REL.split("/"));
  if (!f) throw new Error("missing file in new header");
  const full = Buffer.alloc(f.size);
  const fd = fs.openSync(OUT, "r");
  fs.readSync(fd, full, 0, f.size, 8 + hs2 + Number(f.offset));
  fs.closeSync(fd);
  const txt = full.toString("utf8");
  if (!txt.includes(NEU)) throw new Error("patched string missing");
  if (txt.includes(OLD)) throw new Error("old string still present");
  console.log("validation ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
