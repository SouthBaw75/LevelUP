"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Nav } from "@/components/Nav";
import { useAuth } from "@/hooks/useAuth";
import {
  appendMessage,
  recordLog,
  subscribeActiveMission,
  subscribeMessages,
  subscribeTodayHealth,
  subscribeTodayLogs,
  subscribeUser,
} from "@/lib/data";
import type {
  ConversationMessageDoc,
  HealthDayDoc,
  LogDoc,
  MissionDoc,
  UserDoc,
} from "@/lib/schema";
import { DESTINATIONS } from "@/lib/mission";
import { cn } from "@/lib/utils";

type RexAction =
  | { type: "water"; amountMl: number }
  | { type: "meal"; description: string; mealType: "breakfast" | "lunch" | "dinner" | "snack"; estimatedCalories?: number; estimatedProteinG?: number; estimatedCarbsG?: number; estimatedFatG?: number }
  | { type: "snack"; description: string; estimatedCalories?: number }
  | { type: "exercise"; activity: string; durationMin?: number; distanceKm?: number; intensity?: "low" | "moderate" | "high"; estimatedCalories?: number };

function ChatInner() {
  const { user } = useAuth();
  const [userDoc, setUserDoc] = useState<UserDoc | null>(null);
  const [messages, setMessages] = useState<ConversationMessageDoc[]>([]);
  const [logs, setLogs] = useState<LogDoc[]>([]);
  const [health, setHealth] = useState<HealthDayDoc | null>(null);
  const [mission, setMission] = useState<MissionDoc | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    const u1 = subscribeUser(user.uid, setUserDoc);
    const u2 = subscribeMessages(user.uid, setMessages);
    const u3 = subscribeTodayLogs(user.uid, setLogs);
    const u4 = subscribeTodayHealth(user.uid, setHealth);
    const u5 = subscribeActiveMission(user.uid, setMission);
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, [user]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const todayTotals = useMemo(() => {
    let waterMl = 0, kcalIn = 0, kcalOut = 0;
    for (const l of logs) {
      if (l.type === "water") waterMl += (l.payload as { amountMl: number }).amountMl;
      if (l.type === "meal" || l.type === "snack") kcalIn += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
      if (l.type === "exercise") kcalOut += (l.payload as { estimatedCalories?: number }).estimatedCalories ?? 0;
    }
    return { waterMl, kcalIn, kcalOut };
  }, [logs]);

  async function send() {
    if (!user || !userDoc || !input.trim() || sending) return;
    const message = input.trim();
    setInput("");
    setSending(true);

    try {
      await appendMessage(user.uid, { role: "user", content: message });

      const idToken = await user.getIdToken();
      const missionSummary = mission
        ? `${DESTINATIONS[mission.destination].label} — fuel ${Math.round(mission.distanceTraveled * 100)}%, LS ${mission.lifeSupportMl}/${mission.settings.lifeSupportFloorMlPerDay}ml`
        : undefined;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          message,
          tone: userDoc.settings.tone,
          context: {
            todayWaterMl: todayTotals.waterMl,
            todayKcalIn: todayTotals.kcalIn,
            todayKcalOut: todayTotals.kcalOut,
            steps: health?.steps ?? 0,
            streak: userDoc.streak,
            level: userDoc.level,
            missionSummary,
          },
        }),
      });

      if (!res.ok) throw new Error("Rex is off-grid");
      const data = (await res.json()) as { reply: string; actions: RexAction[] };

      // Apply actions client-side (user auth, tx-safe)
      for (const a of data.actions ?? []) {
        if (a.type === "water") {
          await recordLog(user.uid, "water", { amountMl: a.amountMl }, "chat");
        } else if (a.type === "meal") {
          await recordLog(user.uid, "meal", {
            description: a.description,
            mealType: a.mealType,
            estimatedCalories: a.estimatedCalories,
            estimatedProteinG: a.estimatedProteinG,
            estimatedCarbsG: a.estimatedCarbsG,
            estimatedFatG: a.estimatedFatG,
          }, "chat");
        } else if (a.type === "snack") {
          await recordLog(user.uid, "snack", {
            description: a.description,
            estimatedCalories: a.estimatedCalories,
          }, "chat");
        } else if (a.type === "exercise") {
          await recordLog(user.uid, "exercise", {
            activity: a.activity,
            durationMin: a.durationMin,
            distanceKm: a.distanceKm,
            intensity: a.intensity,
            estimatedCalories: a.estimatedCalories,
          }, "chat");
        }
      }

      await appendMessage(user.uid, { role: "assistant", content: data.reply });
    } catch (err) {
      await appendMessage(user.uid, {
        role: "assistant",
        content: "⚠️ Transmission lost, Cadet. Check the uplink and try again.",
      });
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="relative mx-auto flex max-w-xl flex-col pb-24" style={{ minHeight: "100vh" }}>
      <header className="sticky top-0 z-30 border-b border-[color:var(--color-magenta)]/40 bg-[color:var(--color-void)]/80 backdrop-blur px-4 py-3">
        <div
          className="neon-text-magenta"
          style={{ fontFamily: "var(--font-display)", fontSize: 28, lineHeight: 1 }}
        >
          ◄ COMMANDER REX ►
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest opacity-70">
          Tell Rex what you ate, drank, or crushed today.
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {messages.length === 0 && (
          <div className="panel p-4">
            <div className="font-mono text-xs opacity-80 leading-relaxed">
              <span className="neon-text-magenta" style={{ fontFamily: "var(--font-display)", fontSize: 20 }}>
                {"> "}ATTENTION, CADET.
              </span>
              <br />
              Try: <em>"Had oatmeal and a cup of coffee"</em>, <em>"Ran 3 miles"</em>,
              or <em>"Chugged a bottle of water"</em>.
            </div>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {sending && (
          <div className="self-start panel panel-magenta px-3 py-2">
            <span className="blink font-mono text-xs uppercase tracking-widest text-[color:var(--color-magenta)]">
              Rex is typing…
            </span>
          </div>
        )}
      </div>

      <div className="fixed bottom-14 left-0 right-0 z-30 bg-[color:var(--color-void)]/90 backdrop-blur border-t border-[color:var(--color-cyan)]/30">
        <div className="mx-auto flex max-w-xl items-center gap-2 p-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Talk to Rex…"
            className="flex-1 rounded-sm border border-[color:var(--color-cyan)]/50 bg-black/60 px-3 py-2 font-mono text-sm text-[color:var(--color-electric)] placeholder-[color:var(--color-electric)]/40 focus:border-[color:var(--color-magenta)] focus:outline-none"
          />
          <button onClick={send} disabled={sending || !input.trim()} className="btn-retro">
            ►
          </button>
        </div>
      </div>

      <Nav />
    </main>
  );
}

function MessageBubble({ msg }: { msg: ConversationMessageDoc }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("max-w-[85%] px-3 py-2 rounded-sm font-mono text-sm", isUser ? "self-end panel" : "self-start panel panel-magenta")}>
      {!isUser && (
        <div className="font-mono text-[9px] uppercase tracking-widest text-[color:var(--color-magenta)] mb-1">
          REX
        </div>
      )}
      <div className="whitespace-pre-wrap">{msg.content}</div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <ChatInner />
    </AuthGate>
  );
}
