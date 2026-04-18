import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMl(ml: number): string {
  if (ml < 1000) return `${Math.round(ml)} ml`;
  return `${(ml / 1000).toFixed(2)} L`;
}

export function formatKcal(kcal: number): string {
  return `${Math.round(kcal).toLocaleString()} kcal`;
}
