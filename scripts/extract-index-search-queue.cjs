const fs = require("fs");
const path = require("path");
const { readArchiveHeaderSync } = require("@electron/asar/lib/disk");

const ASAR =
  "C:/Program Files/Hyperlinks Space Program/current/resources/app.asar";
const OUT = path.join(__dirname, "..", ".tmp-index-bundle.js");

function find(node, parts) {
  if (!node || !parts.length) return node;
  const [h, ...t] = parts;
  return find(node.files && node.files[h], t);
}

const { header, headerSize } = readArchiveHeaderSync(ASAR);
const rel = "dist/_expo/static/js/web/index-9d007af5f0410228ddbd434b3489e8e5.js";
const file = find(header, rel.split("/"));
if (!file) throw new Error("index not in header");
const payloadStart = 8 + headerSize;
const abs = payloadStart + Number(file.offset);
const buf = Buffer.alloc(file.size);
const fd = fs.openSync(ASAR, "r");
fs.readSync(fd, buf, 0, file.size, abs);
fs.closeSync(fd);
fs.writeFileSync(OUT, buf);
console.log("wrote", OUT, buf.length);

const s = buf.toString("utf8");
const searches = [
  "1500",
  "24000",
  "60000",
  "MAX_QUEUED",
  "MiniChart",
  "lastYear",
  "day1",
  "respectGlobalRateLimit",
  "EMPTY_RETRY",
  "queuedSet",
  "activeCount",
  "isVoiceDialogUiOpen",
];
for (const q of searches) {
  const i = s.indexOf(q);
  console.log(q, i >= 0 ? i : -1);
  if (i >= 0) console.log("  ctx", JSON.stringify(s.slice(i - 60, i + 80)));
}
