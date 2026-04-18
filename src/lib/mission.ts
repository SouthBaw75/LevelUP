/**
 * Water Rocket mission math.
 *
 * Rules:
 *  - Life-support floor per day takes priority. Every sip routes to LS until floor is met.
 *  - Once floor is met, each sip splits by `ratioFuelPct`.
 *  - Fuel is cumulative across the mission and drives `distanceTraveled` toward `targetMl`.
 *  - At each day rollover, life-support tank resets to 0 (astronauts need fresh water).
 *    If the previous day's floor wasn't met, mission fails.
 */

import type { MissionDoc, MissionSettings } from "./schema";

export const DESTINATIONS = {
  moon: { label: "The Moon", distanceKm: 384_400, emoji: "MOON" },
  mars: { label: "Mars", distanceKm: 225_000_000, emoji: "MARS" },
  jupiter: { label: "Jupiter", distanceKm: 778_000_000, emoji: "JUPITER" },
  pluto: { label: "Pluto", distanceKm: 5_900_000_000, emoji: "PLUTO" },
} as const;

export const DEFAULT_SETTINGS: MissionSettings = {
  ratioFuelPct: 30,
  lifeSupportFloorMlPerDay: 2000, // ~8 cups, roughly the common recommendation
};

export interface SipAllocation {
  toLifeSupport: number;
  toFuel: number;
}

/**
 * Allocate a sip of water between life support and fuel.
 * @param amountMl amount drunk
 * @param lifeSupportMl current LS tank (today)
 * @param settings mission settings
 */
export function allocateSip(
  amountMl: number,
  lifeSupportMl: number,
  settings: MissionSettings,
): SipAllocation {
  if (amountMl <= 0) return { toLifeSupport: 0, toFuel: 0 };

  const floor = Math.max(0, settings.lifeSupportFloorMlPerDay);
  const lsNeeded = Math.max(0, floor - lifeSupportMl);

  // Phase 1: fill life-support floor
  const toLS = Math.min(amountMl, lsNeeded);
  let remaining = amountMl - toLS;

  if (remaining <= 0) {
    return { toLifeSupport: toLS, toFuel: 0 };
  }

  // Phase 2: split surplus by ratio
  const fuelPct = Math.max(0, Math.min(100, settings.ratioFuelPct)) / 100;
  const toFuel = Math.round(remaining * fuelPct);
  const toLSurplus = remaining - toFuel;

  return {
    toLifeSupport: toLS + toLSurplus,
    toFuel,
  };
}

/** Apply a sip to a mission, returning the mutated doc fields. */
export function applySip(
  mission: Pick<MissionDoc, "lifeSupportMl" | "fuelMl" | "targetMl" | "settings" | "distanceTraveled">,
  amountMl: number,
) {
  const alloc = allocateSip(amountMl, mission.lifeSupportMl, mission.settings);
  const newFuel = mission.fuelMl + alloc.toFuel;
  const newDistance = Math.min(1, newFuel / Math.max(1, mission.targetMl));
  return {
    lifeSupportMl: mission.lifeSupportMl + alloc.toLifeSupport,
    fuelMl: newFuel,
    distanceTraveled: newDistance,
    allocation: alloc,
  };
}

export function missionProgress(mission: Pick<MissionDoc, "startDate" | "durationDays">) {
  const start = new Date(mission.startDate + "T00:00:00");
  const now = new Date();
  const msPerDay = 86_400_000;
  const elapsed = Math.floor((now.getTime() - start.getTime()) / msPerDay);
  const daysRemaining = Math.max(0, mission.durationDays - elapsed);
  return { elapsed, daysRemaining, totalDays: mission.durationDays };
}

export function recommendedTargetMl(durationDays: number, settings: MissionSettings): number {
  // Surplus-above-floor × fuel ratio × durationDays ≈ achievable fuel at "typical" hydration.
  // We assume the user drinks ~1.3× the floor on a good day.
  const typicalDailyMl = settings.lifeSupportFloorMlPerDay * 1.3;
  const dailySurplus = Math.max(0, typicalDailyMl - settings.lifeSupportFloorMlPerDay);
  const dailyFuel = dailySurplus * (settings.ratioFuelPct / 100);
  return Math.max(500, Math.round(dailyFuel * durationDays));
}
