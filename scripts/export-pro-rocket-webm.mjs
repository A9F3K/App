/**
 * Export Pro metallic rocket as Telegram-ready WebM (VP9 + alpha).
 *
 * Outputs:
 *   assets/pro/rocket-emoji-100.webm   — custom emoji (100×100)
 *   assets/pro/rocket-sticker-512.webm — video sticker (512×512)
 *
 * Usage:
 *   node scripts/export-pro-rocket-webm.mjs
 *   FFMPEG=/path/to/ffmpeg.exe node scripts/export-pro-rocket-webm.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const FFMPEG =
  process.env.FFMPEG ||
  "C:/Users/ASUS/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin/ffmpeg.exe";

/** @type {typeof import("@napi-rs/canvas")} */
let canvasMod;
try {
  canvasMod = require("@napi-rs/canvas");
} catch {
  console.error("Install @napi-rs/canvas first: npm i -D @napi-rs/canvas");
  process.exit(1);
}

const { createCanvas } = canvasMod;

// --- draw (mirrors ui/pro/proMetallicRocketDraw.ts) ---

function drawProMetallicRocket(ctx, size, t, inverted = false) {
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.clip();

  const bob = Math.sin(t * 2.4) * size * 0.028;
  const drift = Math.cos(t * 1.7) * size * 0.018;
  const x = size * 0.5 + drift;
  const y = size * 0.52 + bob;
  const wobble = Math.sin(t * 3.2) * 0.035;

  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4 + wobble);
  ctx.scale(size / 17.5, size / 17.5);

  const outline = inverted ? "rgba(40,50,80,0.55)" : "rgba(18, 22, 32, 0.95)";
  const bodyHi = inverted ? "#ffffff" : "#f2f6ff";
  const bodyMid = inverted ? "#d8e0f4" : "#9aa8c4";
  const bodyLo = inverted ? "#9aa6c0" : "#4a556c";

  const pulse = 0.82 + 0.18 * Math.sin(t * 16);
  ctx.save();
  ctx.translate(0, 5.6);
  ctx.scale(1, pulse);
  const flame = ctx.createRadialGradient(0, 0.3, 0.15, 0, 2.6, 3.8);
  flame.addColorStop(0, "#fff6c8");
  flame.addColorStop(0.35, "#ff9a2a");
  flame.addColorStop(1, "rgba(255,50,10,0)");
  ctx.fillStyle = flame;
  ctx.beginPath();
  ctx.moveTo(-1.9, 0);
  ctx.quadraticCurveTo(-2.2, 2.2, 0, 4.6);
  ctx.quadraticCurveTo(2.2, 2.2, 1.9, 0);
  ctx.fill();
  ctx.restore();

  drawCartoonFin(ctx, -1, bodyHi, bodyLo, outline);
  drawCartoonFin(ctx, 1, bodyHi, bodyLo, outline);

  const body = ctx.createLinearGradient(-4, -6, 4.5, 7);
  body.addColorStop(0, bodyHi);
  body.addColorStop(0.45, bodyMid);
  body.addColorStop(1, bodyLo);
  roundedCapsule(ctx, -3.4, -4.2, 6.8, 10.4, 3.1);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = outline;
  ctx.stroke();

  ctx.fillStyle = inverted ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.55)";
  roundedCapsule(ctx, -2.1, -3.2, 1.5, 7.2, 0.8);
  ctx.fill();

  const nose = ctx.createLinearGradient(-2, -9.5, 3, -3.8);
  nose.addColorStop(0, "#ffffff");
  nose.addColorStop(0.55, bodyMid);
  nose.addColorStop(1, bodyLo);
  ctx.beginPath();
  ctx.moveTo(0, -9.2);
  ctx.quadraticCurveTo(3.8, -4.9, 2.9, -3.9);
  ctx.lineTo(-2.9, -3.9);
  ctx.quadraticCurveTo(-3.8, -4.9, 0, -9.2);
  ctx.closePath();
  ctx.fillStyle = nose;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0.1, -0.55, 2.15, 0, Math.PI * 2);
  ctx.fillStyle = outline;
  ctx.fill();
  const glass = ctx.createRadialGradient(-0.45, -1.15, 0.15, 0.1, -0.55, 1.85);
  glass.addColorStop(0, "#d9f4ff");
  glass.addColorStop(0.45, "#3d8ad4");
  glass.addColorStop(1, "#163058");
  ctx.beginPath();
  ctx.arc(0.1, -0.55, 1.55, 0, Math.PI * 2);
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-0.35, -1.15, 0.48, 0.28, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();

  ctx.restore();
}

function drawCartoonFin(ctx, side, hi, lo, outline) {
  const g = ctx.createLinearGradient(side * 2, 1, side * 6, 7);
  g.addColorStop(0, hi);
  g.addColorStop(1, lo);
  ctx.beginPath();
  ctx.moveTo(side * 2.4, 1.8);
  ctx.lineTo(side * 5.6, 6.4);
  ctx.lineTo(side * 2.2, 5.5);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.1;
  ctx.stroke();
}

function roundedCapsule(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function ensureFfmpeg() {
  if (!existsSync(FFMPEG)) {
    console.error(`ffmpeg not found at ${FFMPEG}`);
    process.exit(1);
  }
}

function exportVariant({ size, outName, durationSec = 2, fps = 30 }) {
  const frames = Math.round(durationSec * fps);
  const tmpDir = join(root, "assets", "pro", `.frames-${size}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    // Transparent clear
    ctx.clearRect(0, 0, size, size);
    drawProMetallicRocket(ctx, size, t, false);
    const png = canvas.toBuffer("image/png");
    writeFileSync(join(tmpDir, `frame_${String(i).padStart(4, "0")}.png`), png);
  }

  const outDir = join(root, "assets", "pro");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, outName);

  // Telegram video stickers / custom emoji: VP9 + alpha (yuva420p), no audio.
  const args = [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    join(tmpDir, "frame_%04d.png"),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-b:v",
    "0",
    "-crf",
    size <= 100 ? "36" : "32",
    "-an",
    "-auto-alt-ref",
    "0",
    "-row-mt",
    "1",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    outPath,
  ];

  console.log(`Encoding ${outName} (${size}×${size}, ${frames} frames)…`);
  const result = spawnSync(FFMPEG, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`ffmpeg failed for ${outName}`);
    process.exit(result.status ?? 1);
  }

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`Wrote ${outPath}`);
}

ensureFfmpeg();

exportVariant({ size: 100, outName: "rocket-emoji-100.webm", durationSec: 2, fps: 30 });
exportVariant({ size: 512, outName: "rocket-sticker-512.webm", durationSec: 2, fps: 30 });

console.log("Done. Transparent VP9 WebM ready for Telegram emoji (100) and sticker (512).");
