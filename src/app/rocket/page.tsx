"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { Nav } from "@/components/Nav";
import { RetroPanel } from "@/components/RetroPanel";
import { RocketCanvas } from "@/components/RocketCanvas";
import { QuickLog } from "@/components/QuickLog";
import { useAuth } from "@/hooks/useAuth";
import {
  createMission,
  subscribeActiveMission,
  updateMissionSettings,
} from "@/lib/data";
import { DESTINATIONS, missionProgress, recommendedTargetMl } from "@/lib/mission";
import type { Destination, MissionDoc } from "@/lib/schema";
import { formatMl } from "@/lib/utils";

function RocketInner() {
  const { user } = useAuth();
  const [mission, setMission] = useState<MissionDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [destination, setDestination] = useState<Destination>("moon");
  const [duration, setDuration] = useState(7);
  const [ratio, setRatio] = useState(30);
  const [lsFloor, setLsFloor] = useState(2000);

  useEffect(() => {
    if (!user) return;
    return subscribeActiveMission(user.uid, setMission);
  }, [user]);

  async function launch() {
    if (!user) return;
    setCreating(true);
    try {
      await createMission(user.uid, {
        destination,
        durationDays: duration,
        ratioFuelPct: ratio,
        lifeSupportFloorMlPerDay: lsFloor,
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="relative mx-auto max-w-xl pb-24">
      <header className="sticky top-0 z-30 border-b border-[color:var(--color-magenta)]/40 bg-[color:var(--color-void)]/80 backdrop-blur px-4 py-3">
        <div
          className="neon-text-magenta"
          style={{ fontFamily: "var(--font-display)", fontSize: 28, lineHeight: 1 }}
        >
          🚀 ROCKET MISSION
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest opacity-70">
          Hydrate to fly. Every sip fuels the void.
        </div>
      </header>

      <div className="flex flex-col gap-4 p-4">
        {mission ? <ActiveMission mission={mission} /> : (
          <NewMissionForm
            destination={destination}
            setDestination={setDestination}
            duration={duration}
            setDuration={setDuration}
            ratio={ratio}
            setRatio={setRatio}
            lsFloor={lsFloor}
            setLsFloor={setLsFloor}
            creating={creating}
            launch={launch}
          />
        )}
      </div>

      <Nav />
    </main>
  );
}

function ActiveMission({ mission }: { mission: MissionDoc }) {
  const dest = DESTINATIONS[mission.destination];
  const prog = missionProgress(mission);
  const fuelPct = Math.min(100, Math.round(mission.distanceTraveled * 100));
  const lsPct = Math.min(
    100,
    Math.round((mission.lifeSupportMl / mission.settings.lifeSupportFloorMlPerDay) * 100),
  );
  const floorMet = mission.lifeSupportMl >= mission.settings.lifeSupportFloorMlPerDay;

  const [showSettings, setShowSettings] = useState(false);
  const [ratio, setRatio] = useState(mission.settings.ratioFuelPct);
  const [lsFloor, setLsFloor] = useState(mission.settings.lifeSupportFloorMlPerDay);
  const [duration, setDuration] = useState(mission.durationDays);
  const { user } = useAuth();

  async function save() {
    if (!user) return;
    await updateMissionSettings(user.uid, mission.id, {
      ratioFuelPct: ratio,
      lifeSupportFloorMlPerDay: lsFloor,
      durationDays: duration,
    });
    setShowSettings(false);
  }

  return (
    <>
      <RetroPanel title={`◄ ${dest.label.toUpperCase()} · DAY ${prog.elapsed + 1}/${prog.totalDays} ►`} variant="magenta">
        <RocketCanvas
          progress={mission.distanceTraveled}
          fuelActive={mission.fuelMl > 0}
          destinationLabel={dest.label}
        />

        <div className="mt-4 grid grid-cols-2 gap-3 text-center">
          <div className="panel p-2">
            <div className="font-mono text-[10px] uppercase opacity-70">Fuel</div>
            <div className="neon-text-lemon" style={{ fontFamily: "var(--font-display)", fontSize: 24 }}>
              {fuelPct}%
            </div>
            <div className="font-mono text-[10px] opacity-70">
              {formatMl(mission.fuelMl)} / {formatMl(mission.targetMl)}
            </div>
          </div>
          <div className="panel p-2">
            <div className="font-mono text-[10px] uppercase opacity-70">Life Support (today)</div>
            <div className={`neon-text-cyan ${floorMet ? "" : "text-[color:var(--color-danger)]"}`} style={{ fontFamily: "var(--font-display)", fontSize: 24 }}>
              {lsPct}%
            </div>
            <div className="font-mono text-[10px] opacity-70">
              {formatMl(mission.lifeSupportMl)} / {formatMl(mission.settings.lifeSupportFloorMlPerDay)}
            </div>
          </div>
        </div>

        {!floorMet && (
          <div className="mt-3 font-mono text-xs uppercase tracking-widest text-[color:var(--color-danger)] text-center blink">
            ⚠ LIFE SUPPORT LOW — DRINK UP, CADET
          </div>
        )}
      </RetroPanel>

      <RetroPanel title="◄ Log Hydro ►">
        <QuickLog />
      </RetroPanel>

      <RetroPanel title="◄ Mission Settings ►">
        {!showSettings ? (
          <button onClick={() => setShowSettings(true)} className="btn-retro-ghost btn-retro w-full">
            Adjust Parameters
          </button>
        ) : (
          <div className="space-y-4">
            <RangeControl
              label="Fuel Ratio (after life support)"
              value={ratio}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={setRatio}
            />
            <RangeControl
              label="Life Support Floor / day"
              value={lsFloor}
              min={1000}
              max={4000}
              step={100}
              suffix="ml"
              onChange={setLsFloor}
            />
            <RangeControl
              label="Mission Duration"
              value={duration}
              min={3}
              max={30}
              step={1}
              suffix="d"
              onChange={setDuration}
            />
            <div className="flex gap-2">
              <button onClick={save} className="btn-retro flex-1">Save</button>
              <button onClick={() => setShowSettings(false)} className="btn-retro-ghost btn-retro flex-1">Cancel</button>
            </div>
          </div>
        )}
      </RetroPanel>
    </>
  );
}

function NewMissionForm(props: {
  destination: Destination;
  setDestination: (d: Destination) => void;
  duration: number;
  setDuration: (d: number) => void;
  ratio: number;
  setRatio: (r: number) => void;
  lsFloor: number;
  setLsFloor: (v: number) => void;
  creating: boolean;
  launch: () => void;
}) {
  const estTarget = recommendedTargetMl(props.duration, {
    ratioFuelPct: props.ratio,
    lifeSupportFloorMlPerDay: props.lsFloor,
  });

  return (
    <RetroPanel title="◄ NEW MISSION ►" variant="magenta">
      <div className="font-mono text-xs opacity-80 mb-3">
        Choose a destination. Hydrate daily to stay alive AND fuel the rocket.
      </div>

      <div className="grid grid-cols-2 gap-2 mb-4">
        {(Object.keys(DESTINATIONS) as Destination[]).map((d) => {
          const def = DESTINATIONS[d];
          const active = props.destination === d;
          return (
            <button
              key={d}
              onClick={() => props.setDestination(d)}
              className={`panel p-3 text-left ${active ? "panel-magenta" : ""}`}
            >
              <div style={{ fontFamily: "var(--font-display)", fontSize: 20 }} className={active ? "neon-text-magenta" : "neon-text-cyan"}>
                {def.label}
              </div>
              <div className="font-mono text-[10px] opacity-70">
                {def.distanceKm.toLocaleString()} km
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-4">
        <RangeControl label="Duration" value={props.duration} min={3} max={30} step={1} suffix="d" onChange={props.setDuration} />
        <RangeControl label="Fuel Ratio" value={props.ratio} min={0} max={100} step={5} suffix="%" onChange={props.setRatio} />
        <RangeControl label="Life Support Floor" value={props.lsFloor} min={1000} max={4000} step={100} suffix="ml/d" onChange={props.setLsFloor} />
      </div>

      <div className="mt-4 font-mono text-[11px] uppercase tracking-widest opacity-80 text-center">
        Target fuel: {formatMl(estTarget)}
      </div>

      <button onClick={props.launch} disabled={props.creating} className="btn-retro w-full mt-4">
        {props.creating ? "Igniting…" : "▶ LAUNCH"}
      </button>
    </RetroPanel>
  );
}

function RangeControl({
  label, value, min, max, step, suffix, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between font-mono text-[11px] uppercase tracking-widest mb-1">
        <span className="opacity-80">{label}</span>
        <span className="neon-text-cyan">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[color:var(--color-magenta)]"
      />
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <RocketInner />
    </AuthGate>
  );
}
