"use client";

import { useEffect, useRef } from "react";

/**
 * Pixel-art rocket. Renders on <canvas> with image-rendering: pixelated.
 * `progress` 0..1 positions the rocket along a vertical path from planet → destination.
 * `fuelActive` triggers a jittery flame.
 */
export function RocketCanvas({
  progress,
  fuelActive,
  destinationLabel,
}: {
  progress: number;
  fuelActive: boolean;
  destinationLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 160;
    const H = 240;
    canvas.width = W;
    canvas.height = H;

    let raf = 0;
    const stars: { x: number; y: number; v: number }[] = Array.from({ length: 40 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      v: 0.2 + Math.random() * 0.8,
    }));

    function draw(t: number) {
      ctx!.imageSmoothingEnabled = false;

      // Space backdrop
      const grd = ctx!.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, "#0a0418");
      grd.addColorStop(1, "#1d0f47");
      ctx!.fillStyle = grd;
      ctx!.fillRect(0, 0, W, H);

      // Stars
      for (const s of stars) {
        s.y += s.v;
        if (s.y > H) { s.y = 0; s.x = Math.random() * W; }
        ctx!.fillStyle = s.v > 0.6 ? "#ffffff" : "#a0f8ff";
        ctx!.fillRect(Math.floor(s.x), Math.floor(s.y), 1, 1);
      }

      // Destination badge at top
      ctx!.fillStyle = "#fff176";
      ctx!.font = "10px monospace";
      ctx!.textAlign = "center";
      ctx!.fillText(`► ${destinationLabel.toUpperCase()}`, W / 2, 14);

      // Planet at bottom (start)
      drawPlanet(ctx!, W / 2, H - 20, 18, "#00f0ff");

      // Rocket travels from bottom → top as progress grows
      const startY = H - 40;
      const endY = 30;
      const y = startY + (endY - startY) * Math.max(0, Math.min(1, progress));
      const x = W / 2;

      // Flame
      if (fuelActive) {
        const flicker = (Math.sin(t / 60) + 1) / 2;
        drawFlame(ctx!, x, y + 5, flicker);
      }

      drawRocket(ctx!, x, y);

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [progress, fuelActive, destinationLabel]);

  return (
    <canvas
      ref={canvasRef}
      className="pixelated mx-auto block"
      style={{ width: 240, height: 360, imageRendering: "pixelated" }}
    />
  );
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.floor(x), Math.floor(y), w, h);
}

function drawRocket(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const WHITE = "#f4fbff";
  const CYAN = "#00f0ff";
  const MAG = "#ff2bd6";
  const DARK = "#1d0f47";

  // Nose
  px(ctx, cx, cy - 8, WHITE);
  px(ctx, cx - 1, cy - 7, WHITE, 3, 1);
  // Body
  px(ctx, cx - 2, cy - 6, WHITE, 5, 9);
  // Window
  px(ctx, cx - 1, cy - 3, CYAN, 3, 2);
  // Stripe
  px(ctx, cx - 2, cy + 1, MAG, 5, 1);
  // Fins
  px(ctx, cx - 4, cy + 2, WHITE, 2, 3);
  px(ctx, cx + 3, cy + 2, WHITE, 2, 3);
  // Thruster
  px(ctx, cx - 2, cy + 4, DARK, 5, 1);
}

function drawFlame(ctx: CanvasRenderingContext2D, cx: number, cy: number, flicker: number) {
  const inner = flicker > 0.5 ? "#fff176" : "#ff9f1c";
  const outer = "#ff2975";
  px(ctx, cx - 2, cy, outer, 5, 1);
  px(ctx, cx - 1, cy + 1, inner, 3, 2);
  px(ctx, cx, cy + 3, inner, 1, 1);
  if (flicker > 0.3) px(ctx, cx - 3, cy + 1, outer, 1, 1);
  if (flicker > 0.7) px(ctx, cx + 3, cy + 1, outer, 1, 1);
}

function drawPlanet(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.arc(cx + r / 3, cy - r / 4, r / 2, 0, Math.PI * 2);
  ctx.fill();
}
