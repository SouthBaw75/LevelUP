import { Timestamp } from "firebase/firestore";

/**
 * Firestore schema for LevelUP.
 * Top-level collection: `users/{uid}` with subcollections below.
 */

export type LogType = "meal" | "snack" | "exercise" | "water";
export type LogSource = "chat" | "manual" | "health";

export interface UserDoc {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  createdAt: Timestamp;
  xp: number;
  level: number;
  streak: number;
  lastActiveDate: string; // YYYY-MM-DD
  settings: UserSettings;
}

export interface UserSettings {
  units: "imperial" | "metric";
  tone: "hype" | "chill" | "drill";
  waterGoalMl: number;
  dailyCalorieGoal: number;
  dailyStepGoal: number;
}

export interface MealPayload {
  description: string;
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  estimatedCalories?: number;
  estimatedProteinG?: number;
  estimatedCarbsG?: number;
  estimatedFatG?: number;
}

export interface ExercisePayload {
  activity: string;
  durationMin?: number;
  distanceKm?: number;
  intensity?: "low" | "moderate" | "high";
  estimatedCalories?: number;
}

export interface WaterPayload {
  amountMl: number;
}

export interface SnackPayload {
  description: string;
  estimatedCalories?: number;
}

export type LogPayload = MealPayload | ExercisePayload | WaterPayload | SnackPayload;

export interface LogDoc {
  id: string;
  type: LogType;
  source: LogSource;
  createdAt: Timestamp;
  date: string; // YYYY-MM-DD for easy grouping
  payload: LogPayload;
  xpAwarded: number;
}

export interface HealthDayDoc {
  date: string; // YYYY-MM-DD
  steps: number;
  activeCalories: number;
  basalCalories: number;
  distanceMeters: number;
  updatedAt: Timestamp;
}

export type Destination = "moon" | "mars" | "jupiter" | "pluto";

export interface MissionSettings {
  ratioFuelPct: number; // 0-100. Soft split — portion of each sip routed to fuel once LS floor met.
  lifeSupportFloorMlPerDay: number; // Minimum water/day to keep astronaut alive.
}

export interface MissionDoc {
  id: string;
  destination: Destination;
  targetMl: number; // Total water needed over mission to complete distance.
  durationDays: number;
  startDate: string; // YYYY-MM-DD
  status: "active" | "complete" | "failed";
  settings: MissionSettings;
  lifeSupportMl: number; // Current tank (today)
  fuelMl: number; // Cumulative fuel
  distanceTraveled: number; // 0-1 fraction of targetMl
  lastTickAt: Timestamp;
}

export interface ConversationMessageDoc {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: Timestamp;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface AchievementDoc {
  id: string;
  title: string;
  description: string;
  unlockedAt: Timestamp;
}

/* Firestore path helpers */
export const paths = {
  user: (uid: string) => `users/${uid}`,
  logs: (uid: string) => `users/${uid}/logs`,
  log: (uid: string, logId: string) => `users/${uid}/logs/${logId}`,
  healthDays: (uid: string) => `users/${uid}/healthDays`,
  healthDay: (uid: string, date: string) => `users/${uid}/healthDays/${date}`,
  missions: (uid: string) => `users/${uid}/missions`,
  mission: (uid: string, missionId: string) => `users/${uid}/missions/${missionId}`,
  conversation: (uid: string) => `users/${uid}/conversation`,
  achievements: (uid: string) => `users/${uid}/achievements`,
};
