"use client";

export function Ring({
  value,
  goal,
  label,
  unit,
  color = "cyan",
  size = 96,
}: {
  value: number;
  goal: number;
  label: string;
  unit?: string;
  color?: "cyan" | "magenta" | "lemon";
  size?: number;
}) {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct);

  const colorVar =
    color === "magenta" ? "var(--color-magenta)" :
    color === "lemon" ? "var(--color-lemon)" :
    "var(--color-cyan)";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke="rgba(255,255,255,0.1)"
            strokeWidth={stroke}
            fill="none"
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colorVar}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={c}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${colorVar})`, transition: "stroke-dashoffset 500ms" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            style={{ fontFamily: "var(--font-display)", fontSize: 22, color: colorVar }}
          >
            {Math.round(value).toLocaleString()}
          </span>
          {unit && <span className="font-mono text-[10px] uppercase opacity-70">{unit}</span>}
        </div>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-widest opacity-80">{label}</span>
    </div>
  );
}
