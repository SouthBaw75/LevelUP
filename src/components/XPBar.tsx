"use client";

import { progressWithinLevel } from "@/lib/xp";

export function XPBar({ xp }: { xp: number }) {
  const { level, into, span, pct } = progressWithinLevel(xp);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-electric)]">
        <span className="neon-text-magenta" style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>
          LVL {level}
        </span>
        <span>
          {into} / {span} XP
        </span>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-sm border border-[color:var(--color-cyan)]/50 bg-black/50">
        <div
          className="h-full bg-gradient-to-r from-[color:var(--color-magenta)] via-[color:var(--color-hotpink)] to-[color:var(--color-sunset)]"
          style={{
            width: `${Math.min(100, pct * 100)}%`,
            boxShadow: "0 0 10px var(--color-magenta)",
          }}
        />
      </div>
    </div>
  );
}
