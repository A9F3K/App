/**
 * Canvas drawing for the Pro metallic rocket (shared by UI + asset export).
 * Coordinate system: origin at glyph center after translate/rotate.
 */

export type RocketDrawContext = {
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    a0: number,
    a1: number,
  ): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
};

export function drawProMetallicRocket(
  ctx: RocketDrawContext,
  size: number,
  t: number,
  inverted = false,
): void {
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size, size);
  ctx.clip();

  // Centered with a tiny bob — no long diagonal travel so the glyph can fill the chip.
  const bob = Math.sin(t * 2.4) * size * 0.028;
  const drift = Math.cos(t * 1.7) * size * 0.018;
  const x = size * 0.5 + drift;
  const y = size * 0.52 + bob;
  // Canvas +angle is clockwise: from "up" that aims the nose to upper-right.
  const wobble = Math.sin(t * 3.2) * 0.035;

  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4 + wobble);
  ctx.scale(size / 17.5, size / 17.5);

  const outline = inverted ? "rgba(40,50,80,0.55)" : "rgba(18, 22, 32, 0.95)";
  const bodyHi = inverted ? "#ffffff" : "#f2f6ff";
  const bodyMid = inverted ? "#d8e0f4" : "#9aa8c4";
  const bodyLo = inverted ? "#9aa6c0" : "#4a556c";

  // Flame (behind)
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

  // Fins
  drawCartoonFin(ctx, -1, bodyHi, bodyLo, outline);
  drawCartoonFin(ctx, 1, bodyHi, bodyLo, outline);

  // Body
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

  // Specular stripe
  ctx.fillStyle = inverted ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.55)";
  roundedCapsule(ctx, -2.1, -3.2, 1.5, 7.2, 0.8);
  ctx.fill();

  // Nose
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

  // Window — oversized for small-size readability
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

function drawCartoonFin(
  ctx: RocketDrawContext,
  side: -1 | 1,
  hi: string,
  lo: string,
  outline: string,
) {
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

function roundedCapsule(
  ctx: RocketDrawContext,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
