"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Nav } from "@/components/Nav";
import { RetroPanel } from "@/components/RetroPanel";
import { useAuth } from "@/hooks/useAuth";
import { subscribeUser, updateSettings } from "@/lib/data";
import type { UserDoc, UserSettings } from "@/lib/schema";

function SettingsInner() {
  const { user, signOut } = useAuth();
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);

  useEffect(() => {
    if (!user) return;
    return subscribeUser(user.uid, setUserDoc);
  }, [user]);

  async function update(patch: Partial<UserSettings>) {
    if (!user) return;
    await updateSettings(user.uid, patch);
  }

  if (!userDoc) return null;
  const s = userDoc.settings;
  const healthSyncUrl = typeof window !== "undefined" ? `${window.location.origin}/api/health-sync` : "/api/health-sync";

  return (
    <main className="relative mx-auto max-w-xl pb-24">
      <header className="sticky top-0 z-30 border-b border-[color:var(--color-cyan)]/30 bg-[color:var(--color-void)]/80 backdrop-blur px-4 py-3">
        <div className="neon-text-cyan" style={{ fontFamily: "var(--font-display)", fontSize: 28, lineHeight: 1 }}>
          ◄ SYSTEM ►
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        <RetroPanel title="◄ Rex's Tone ►">
          <div className="grid grid-cols-3 gap-2">
            {(["hype", "chill", "drill"] as const).map((t) => (
              <button
                key={t}
                onClick={() => update({ tone: t })}
                className={`panel py-3 text-center font-mono text-xs uppercase tracking-widest ${s.tone === t ? "panel-magenta" : ""}`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="font-mono text-[10px] opacity-70 mt-2">
            {s.tone === "hype" && "Arcade announcer energy. READY PLAYER ONE."}
            {s.tone === "chill" && "Mellow mentor. Still retro, dialed down."}
            {s.tone === "drill" && "Playful drill sergeant. DROP AND GIVE ME 10."}
          </p>
        </RetroPanel>

        <RetroPanel title="◄ Units ►">
          <div className="grid grid-cols-2 gap-2">
            {(["imperial", "metric"] as const).map((u) => (
              <button
                key={u}
                onClick={() => update({ units: u })}
                className={`panel py-3 text-center font-mono text-xs uppercase tracking-widest ${s.units === u ? "panel-magenta" : ""}`}
              >
                {u}
              </button>
            ))}
          </div>
        </RetroPanel>

        <RetroPanel title="◄ Daily Goals ►">
          <NumberRow label="Water (ml)" value={s.waterGoalMl} onChange={(v) => update({ waterGoalMl: v })} step={100} />
          <NumberRow label="Calories (kcal)" value={s.dailyCalorieGoal} onChange={(v) => update({ dailyCalorieGoal: v })} step={50} />
          <NumberRow label="Steps" value={s.dailyStepGoal} onChange={(v) => update({ dailyStepGoal: v })} step={500} />
        </RetroPanel>

        <RetroPanel title="◄ Apple Health Sync ►" variant="magenta">
          <div className="font-mono text-xs leading-relaxed opacity-90 space-y-2">
            <p>
              iOS/web limitation: HealthKit is not reachable from the browser. Use an
              <strong> Apple Shortcut</strong> to push daily metrics here.
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Open Shortcuts → <em>+ New Automation</em> → <em>Time of Day</em> (e.g. 11:55pm).</li>
              <li>Add "Find Health Samples" for Steps / Active Energy / Basal Energy / Walking+Running Distance (today).</li>
              <li>Add <em>Get Contents of URL</em>, POST JSON to the endpoint below with your <code>userId</code> + <code>secret</code>.</li>
            </ol>
            <div className="panel p-2 mt-2">
              <div className="text-[10px] uppercase tracking-widest opacity-70">POST</div>
              <code className="text-[color:var(--color-lemon)]">{healthSyncUrl}</code>
              <pre className="whitespace-pre-wrap text-[11px] mt-2">{`{
  "secret": "<HEALTH_SYNC_SECRET>",
  "userId": "${user?.uid ?? "<your uid>"}",
  "date": "YYYY-MM-DD",
  "steps": 8123,
  "activeCalories": 412,
  "basalCalories": 1500,
  "distanceMeters": 6200
}`}</pre>
            </div>
          </div>
        </RetroPanel>

        <RetroPanel title="◄ Account ►">
          <div className="font-mono text-xs space-y-1">
            <div>Cadet: <span className="neon-text-cyan">{userDoc.displayName ?? "Unknown"}</span></div>
            <div>UID: <code className="opacity-70">{userDoc.uid}</code></div>
          </div>
          <button onClick={signOut} className="btn-retro-ghost btn-retro w-full mt-4">Sign out</button>
        </RetroPanel>
      </div>

      <Nav />
    </main>
  );
}

function NumberRow({
  label, value, onChange, step,
}: { label: string; value: number; onChange: (v: number) => void; step: number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="font-mono text-xs uppercase tracking-widest opacity-80">{label}</span>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(Math.max(0, value - step))} className="btn-retro-ghost btn-retro" style={{ padding: "0.25rem 0.75rem", fontSize: 14 }}>−</button>
        <span className="font-mono text-sm w-16 text-center neon-text-cyan">{value}</span>
        <button onClick={() => onChange(value + step)} className="btn-retro-ghost btn-retro" style={{ padding: "0.25rem 0.75rem", fontSize: 14 }}>+</button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <SettingsInner />
    </AuthGate>
  );
}
