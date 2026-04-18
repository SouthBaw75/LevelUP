"use client";

import { useState } from "react";
import { recordLog } from "@/lib/data";
import { useAuth } from "@/hooks/useAuth";

const WATER_SIPS = [
  { label: "Sip", ml: 120 },
  { label: "Cup", ml: 240 },
  { label: "Bottle", ml: 500 },
];

export function QuickLog() {
  const { user } = useAuth();
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function logWater(ml: number) {
    if (!user) return;
    setBusy(ml);
    try {
      const res = await recordLog(user.uid, "water", { amountMl: ml }, "manual");
      const bits = [`+${res.xpAwarded} XP`];
      if (res.sip && res.sip.toFuel > 0) bits.push(`+${res.sip.toFuel}ml FUEL`);
      if (res.leveledUp) bits.push("LEVEL UP!");
      setToast(bits.join(" · "));
      setTimeout(() => setToast(null), 2200);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {WATER_SIPS.map((s) => (
          <button
            key={s.ml}
            onClick={() => logWater(s.ml)}
            disabled={busy === s.ml}
            className="btn-retro-ghost btn-retro flex-1"
            style={{ fontSize: 16 }}
          >
            {s.label}
            <span className="ml-1 opacity-70 font-mono text-[10px]">{s.ml}ml</span>
          </button>
        ))}
      </div>
      {toast && (
        <div className="font-mono text-xs uppercase tracking-widest text-center neon-text-lemon">
          {toast}
        </div>
      )}
    </div>
  );
}
