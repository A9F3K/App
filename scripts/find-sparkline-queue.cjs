const asar = require("@electron/asar");
const p = "C:/Program Files/Hyperlinks Space Program/current/resources/app.asar";
const files = asar.listPackage(p).filter((f) => {
  const n = String(f).replace(/\\/g, "/");
  return n.includes("dist/_expo/static/js/web/index-");
});
console.log("index bundles", files.length, files[0]);
const rel = String(files[0] || "")
  .replace(/\\/g, "/")
  .replace(/^\//, "");
const s = asar.extractFile(p, rel).toString("utf8");

const needles = [
  "queued.length>=40",
  "queued.length >= 40",
  "MAX_QUEUED",
  "EMPTY_RETRY_COOLDOWN",
  "MINI_CHART_MAX_POINTS",
  "RETRY_MAX_DELAY_MS",
  "respectGlobalRateLimit",
];
for (const pat of needles) {
  console.log(pat, s.indexOf(pat));
}

// Broader: find ">=40" near "queued"
let idx = 0;
let hits = 0;
while ((idx = s.indexOf("queued", idx)) >= 0 && hits < 8) {
  console.log("queued ctx", JSON.stringify(s.slice(idx, idx + 80)));
  idx += 6;
  hits += 1;
}
