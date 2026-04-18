"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Nav } from "@/components/Nav";
import { RetroPanel } from "@/components/RetroPanel";
import { XPBar } from "@/components/XPBar";
import { Ring } from "@/components/Ring";
import { RocketTile } from "@/components/RocketTile";
import { QuickLog } from "@/components/QuickLog";
import { useAuth } from "@/hooks/useAuth";
import {
  subscribeActiveMission,
  subscribeTodayHealth,
  subscribeTodayLogs,
  subscribeUser,
} from "@/lib/data";
import type { HealthDayDoc, LogDoc, MissionDoc, UserDoc } from "@/lib/schema";
import Link from "next/link";

function HQInner() {
  const { user, signOut } = useAuth();
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [logs, setLogs] = useState<LogDoc[]>([]);
  const [health, setHealth] = useState<HealthDayDoc | null>(null);
  const [mission, setMission] = useState<MissionDoc | null>(null);

  useEffect(() => {
    if (!user) return;
    const u1 = subscribeUser(user.uid, setUserDoc);
    const u2 = subscribeTodayLogs(user.uid, setLogs);
    const u3 = subscribeTodayHealth(user.uid, setHealth);
    const u4 = subscribeActiveMission(user.uid, setMission);
    return () => {
      u1(); u2(); u3(); u4();
    };
  }, [user]);

  const totals = useMemo(() => {
    let waterMl = 0;
    let kcalIn = 0;
    let kcalOut = 0;
    for (const l of logs) {
      if (l.type === "water") waterMl += (l.payload as { amountMl: number }).amountMl;
      if (l.type === "meal" || l.type === "snack")
        kcalIn += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
      if (l.type === "exercise")
        kcalOut += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
    }
    return { waterMl, kcalIn, kcalOut };
  }, [logs]);

  return (
    <main className="relative mx-auto max-w-xl pb-24">
      <header className="sticky top-0 z-30 border-b border-[color:var(--color-cyan)]/30 bg-[color:var(--color-void)]/80 backdrop-blur px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div
              className="neon-text-magenta"
              style={{ fontFamily: "var(--font-display)", fontSize: 28, lineHeight: 1 }}
            >
              HQ
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest opacity-70">
              Cadet {userDoc?.displayName ?? "…"}
            </div>
          </div>
          <button onClick={signOut} className="chip">SIGN OUT</button>
        </div>
        <div className="mt-3"><XPBar xp={userDoc?.xp ?? 0} /></div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        <RetroPanel title={`◄ Today · Streak ${userDoc?.streak ?? 0} 🔥 ►`}>
          <div className="flex items-center justify-around">
            <Ring
              value={totals.waterMl}
              goal={userDoc?.settings.waterGoalMl ?? 2000}
              label="Hydro"
              unit="ml"
              color="cyan"
            />
            <Ring
              value={health?.steps ?? 0}
              goal={userDoc?.settings.dailyStepGoal ?? 10000}
              label="Steps"
              color="magenta"
            />
            <Ring
              value={totals.kcalIn}
              goal={userDoc?.settings.dailyCalorieGoal ?? 2200}
              label="Fuel In"
              unit="kcal"
              color="lemon"
            />
          </div>
          <div className="mt-3 flex justify-around font-mono text-[10px] uppercase tracking-widest opacity-80">
            <span>Active kcal · {Math.round(health?.activeCalories ?? 0)}</span>
            <span>Burn (logs) · {Math.round(totals.kcalOut)}</span>
          </div>
        </RetroPanel>

        <RetroPanel title="◄ Quick-Log Hydro ►" variant="magenta">
          <QuickLog />
          <div className="mt-3 text-center">
            <Link href="/chat" className="font-mono text-[10px] uppercase tracking-widest opacity-80 hover:opacity-100">
              Or talk to Rex →
            </Link>
          </div>
        </RetroPanel>

        <RocketTile mission={mission} />

        <RetroPanel title="◄ Today's feed ►">
          {logs.length === 0 ? (
            <div className="font-mono text-xs opacity-70 text-center py-4">
              No activity yet. Log your first rep, sip, or snack.
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-white/10">
              {logs.slice(0, 8).map((l) => (
                <LogRow key={l.id} log={l} />
              ))}
            </ul>
          )}
        </RetroPanel>
      </div>

      <Nav />
    </main>
  );
}

function LogRow({ log }: { log: LogDoc }) {
  const icon =
    log.type === "water" ? "💧" :
    log.type === "meal" ? "🍽" :
    log.type === "snack" ? "🍿" :
    "🏃";
  const desc =
    log.type === "water"
      ? `${(log.payload as { amountMl: number }).amountMl} ml`
      : log.type === "exercise"
        ? (log.payload as { activity: string }).activity
        : (log.payload as { description: string }).description;
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center gap-3">
        <span>{icon}</span>
        <span className="font-mono text-xs">{desc}</span>
      </div>
      <span className="chip">+{log.xpAwarded} XP</span>
    </li>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <HQInner />
    </AuthGate>
  );
}
