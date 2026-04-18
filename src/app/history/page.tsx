"use client";

import { useEffect, useMemo, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Nav } from "@/components/Nav";
import { RetroPanel } from "@/components/RetroPanel";
import { useAuth } from "@/hooks/useAuth";
import { subscribeRecentLogs } from "@/lib/data";
import type { LogDoc } from "@/lib/schema";

function HistoryInner() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<LogDoc[]>([]);

  useEffect(() => {
    if (!user) return;
    return subscribeRecentLogs(user.uid, 14, setLogs);
  }, [user]);

  const byDay = useMemo(() => {
    const map = new Map<string, LogDoc[]>();
    for (const l of logs) {
      const arr = map.get(l.date) ?? [];
      arr.push(l);
      map.set(l.date, arr);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [logs]);

  return (
    <main className="relative mx-auto max-w-xl pb-24">
      <header className="sticky top-0 z-30 border-b border-[color:var(--color-cyan)]/30 bg-[color:var(--color-void)]/80 backdrop-blur px-4 py-3">
        <div
          className="neon-text-cyan"
          style={{ fontFamily: "var(--font-display)", fontSize: 28, lineHeight: 1 }}
        >
          ◄ CAPTAIN'S LOG ►
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest opacity-70">
          Last 14 stardates
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {byDay.length === 0 && (
          <RetroPanel>
            <div className="font-mono text-xs opacity-70 text-center py-6">
              No entries yet. Start logging on HQ or ask Rex.
            </div>
          </RetroPanel>
        )}
        {byDay.map(([date, items]) => {
          const totals = dayTotals(items);
          return (
            <RetroPanel key={date} title={`◄ ${date} ►`}>
              <div className="flex justify-around font-mono text-[10px] uppercase tracking-widest mb-3 opacity-80">
                <span>💧 {totals.waterMl}ml</span>
                <span>🍽 {totals.kcalIn}kcal</span>
                <span>🏃 {totals.kcalOut}kcal</span>
                <span className="neon-text-lemon">+{totals.xp} XP</span>
              </div>
              <ul className="divide-y divide-white/10">
                {items.map((l) => <LogRow key={l.id} log={l} />)}
              </ul>
            </RetroPanel>
          );
        })}
      </div>

      <Nav />
    </main>
  );
}

function dayTotals(items: LogDoc[]) {
  let waterMl = 0, kcalIn = 0, kcalOut = 0, xp = 0;
  for (const l of items) {
    xp += l.xpAwarded;
    if (l.type === "water") waterMl += (l.payload as { amountMl: number }).amountMl;
    if (l.type === "meal" || l.type === "snack") kcalIn += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
    if (l.type === "exercise") kcalOut += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
  }
  return { waterMl, kcalIn, kcalOut, xp };
}

function LogRow({ log }: { log: LogDoc }) {
  const icon = log.type === "water" ? "💧" : log.type === "meal" ? "🍽" : log.type === "snack" ? "🍿" : "🏃";
  const desc =
    log.type === "water" ? `${(log.payload as { amountMl: number }).amountMl} ml` :
    log.type === "exercise" ? (log.payload as { activity: string }).activity :
    (log.payload as { description: string }).description;
  const time = log.createdAt && typeof (log.createdAt as unknown as { toDate?: () => Date }).toDate === "function"
    ? (log.createdAt as unknown as { toDate: () => Date }).toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <li className="flex items-center justify-between gap-3 py-2 font-mono text-xs">
      <span className="flex items-center gap-2">
        <span>{icon}</span>
        <span>{desc}</span>
      </span>
      <span className="opacity-60">{time}</span>
    </li>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <HistoryInner />
    </AuthGate>
  );
}
