"use client";

import Link from "next/link";
import type { MissionDoc } from "@/lib/schema";
import { DESTINATIONS, missionProgress } from "@/lib/mission";
import { formatMl } from "@/lib/utils";

export function RocketTile({ mission }: { mission: MissionDoc | null }) {
  if (!mission) {
    return (
      <Link href="/rocket" className="panel panel-magenta block p-4">
        <div className="font-mono text-xs uppercase tracking-widest text-[color:var(--color-magenta)]">
          No active mission
        </div>
        <div className="mt-2" style={{ fontFamily: "var(--font-display)", fontSize: 22 }}>
          <span className="neon-text-magenta">LAUNCH A ROCKET →</span>
        </div>
      </Link>
    );
  }

  const dest = DESTINATIONS[mission.destination];
  const prog = missionProgress(mission);
  const pct = Math.round(mission.distanceTraveled * 100);
  const lsPct = Math.min(
    100,
    Math.round((mission.lifeSupportMl / mission.settings.lifeSupportFloorMlPerDay) * 100),
  );

  return (
    <Link href="/rocket" className="panel panel-magenta block p-4">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest">
        <span className="text-[color:var(--color-magenta)]">Mission → {dest.label}</span>
        <span className="text-[color:var(--color-electric)]/80">Day {prog.elapsed + 1}/{prog.totalDays}</span>
      </div>

      <div className="mt-3 grid grid-cols-[auto,1fr] gap-3 items-center">
        <div className="text-4xl" style={{ fontFamily: "var(--font-display)" }}>🚀</div>
        <div className="flex-1 space-y-2">
          <Bar label="Fuel" pct={pct} color="var(--color-sunset)" />
          <Bar label="Life Support" pct={lsPct} color="var(--color-cyan)" />
        </div>
      </div>

      <div className="mt-3 font-mono text-[10px] uppercase tracking-widest opacity-80 flex justify-between">
        <span>Fuel {formatMl(mission.fuelMl)} / {formatMl(mission.targetMl)}</span>
        <span>{pct}%</span>
      </div>
    </Link>
  );
}

function Bar({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-widest opacity-80">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-sm border border-white/20 bg-black/50">
        <div
          className="h-full"
          style={{
            width: `${Math.min(100, pct)}%`,
            background: color,
            boxShadow: `0 0 8px ${color}`,
          }}
        />
      </div>
    </div>
  );
}
