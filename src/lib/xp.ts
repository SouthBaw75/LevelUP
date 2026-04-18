/**
 * XP & leveling math. Simple quadratic curve so early levels come fast
 * and later ones take commitment.
 */

export const XP_AWARDS = {
  meal: 15,
  snack: 8,
  exercise: 40,
  water: 2, // per logged cup (~240ml)
  streakBonus: 25,
} as const;

/** XP required to reach `level` (cumulative). Level 1 = 0. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(50 * (level - 1) ** 1.7);
}

export function levelFromXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

export function progressWithinLevel(xp: number) {
  const level = levelFromXp(xp);
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const into = xp - floor;
  const span = ceil - floor;
  return { level, into, span, pct: span > 0 ? into / span : 0 };
}
