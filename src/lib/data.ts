/**
 * Data access layer — all Firestore reads/writes centralize here.
 * Client-side only (uses modular Firestore SDK).
 */

"use client";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "./firebase";
import {
  paths,
  type HealthDayDoc,
  type LogDoc,
  type LogPayload,
  type LogType,
  type LogSource,
  type MissionDoc,
  type UserDoc,
  type UserSettings,
  type ConversationMessageDoc,
} from "./schema";
import { XP_AWARDS, levelFromXp } from "./xp";
import { applySip, DEFAULT_SETTINGS, recommendedTargetMl } from "./mission";
import type { User } from "firebase/auth";

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function ensureUserDoc(user: User): Promise<void> {
  const db = getClientDb();
  const ref = doc(db, paths.user(user.uid));
  const snap = await getDoc(ref);
  if (snap.exists()) return;

  const settings: UserSettings = {
    units: "imperial",
    tone: "hype",
    waterGoalMl: 2000,
    dailyCalorieGoal: 2200,
    dailyStepGoal: 10_000,
  };

  await setDoc(ref, {
    uid: user.uid,
    displayName: user.displayName,
    email: user.email,
    photoURL: user.photoURL,
    createdAt: serverTimestamp(),
    xp: 0,
    level: 1,
    streak: 0,
    lastActiveDate: todayDate(),
    settings,
  });
}

export function subscribeUser(uid: string, cb: (u: UserDoc | null) => void): Unsubscribe {
  const db = getClientDb();
  return onSnapshot(doc(db, paths.user(uid)), (snap) => {
    cb(snap.exists() ? (snap.data() as UserDoc) : null);
  });
}

export function subscribeTodayLogs(uid: string, cb: (logs: LogDoc[]) => void): Unsubscribe {
  const db = getClientDb();
  const q = query(
    collection(db, paths.logs(uid)),
    where("date", "==", todayDate()),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LogDoc, "id">) })));
  });
}

export function subscribeRecentLogs(uid: string, days: number, cb: (logs: LogDoc[]) => void): Unsubscribe {
  const db = getClientDb();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceDate = since.toISOString().slice(0, 10);
  const q = query(
    collection(db, paths.logs(uid)),
    where("date", ">=", sinceDate),
    orderBy("date", "desc"),
    orderBy("createdAt", "desc"),
    limit(200),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LogDoc, "id">) })));
  });
}

export async function getActiveMission(uid: string): Promise<MissionDoc | null> {
  const db = getClientDb();
  const q = query(
    collection(db, paths.missions(uid)),
    where("status", "==", "active"),
    limit(1),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...(d.data() as Omit<MissionDoc, "id">) };
}

export function subscribeActiveMission(uid: string, cb: (m: MissionDoc | null) => void): Unsubscribe {
  const db = getClientDb();
  const q = query(
    collection(db, paths.missions(uid)),
    where("status", "==", "active"),
    limit(1),
  );
  return onSnapshot(q, (snap) => {
    if (snap.empty) return cb(null);
    const d = snap.docs[0];
    cb({ id: d.id, ...(d.data() as Omit<MissionDoc, "id">) });
  });
}

export async function createMission(
  uid: string,
  opts: {
    destination: MissionDoc["destination"];
    durationDays: number;
    ratioFuelPct?: number;
    lifeSupportFloorMlPerDay?: number;
  },
): Promise<string> {
  const db = getClientDb();
  const settings = {
    ratioFuelPct: opts.ratioFuelPct ?? DEFAULT_SETTINGS.ratioFuelPct,
    lifeSupportFloorMlPerDay:
      opts.lifeSupportFloorMlPerDay ?? DEFAULT_SETTINGS.lifeSupportFloorMlPerDay,
  };
  const targetMl = recommendedTargetMl(opts.durationDays, settings);
  const ref = await addDoc(collection(db, paths.missions(uid)), {
    destination: opts.destination,
    targetMl,
    durationDays: opts.durationDays,
    startDate: todayDate(),
    status: "active",
    settings,
    lifeSupportMl: 0,
    fuelMl: 0,
    distanceTraveled: 0,
    lastTickAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Record a log and atomically update XP, streak, and (for water) the active mission.
 */
export async function recordLog(
  uid: string,
  type: LogType,
  payload: LogPayload,
  source: LogSource = "manual",
): Promise<{ xpAwarded: number; leveledUp: boolean; sip?: { toLS: number; toFuel: number } }> {
  const db = getClientDb();
  const today = todayDate();
  const xpAwarded =
    type === "meal" ? XP_AWARDS.meal
    : type === "snack" ? XP_AWARDS.snack
    : type === "exercise" ? XP_AWARDS.exercise
    : type === "water" ? XP_AWARDS.water
    : 0;

  const userRef = doc(db, paths.user(uid));
  const logRef = doc(collection(db, paths.logs(uid)));

  // Find the active mission ref ahead of the transaction so the tx can do a
  // consistent read-then-write on it.
  let missionRef: ReturnType<typeof doc> | null = null;
  if (type === "water") {
    const missionsSnap = await getDocs(
      query(collection(db, paths.missions(uid)), where("status", "==", "active"), limit(1)),
    );
    if (!missionsSnap.empty) missionRef = missionsSnap.docs[0].ref;
  }

  let leveledUp = false;
  let sip: { toLS: number; toFuel: number } | undefined;

  await runTransaction(db, async (tx) => {
    // All reads first.
    const userSnap = await tx.get(userRef);
    const user = userSnap.data() as UserDoc | undefined;
    if (!user) throw new Error("User doc missing");

    let missionCtx: { ref: ReturnType<typeof doc>; data: MissionDoc; lsToday: number } | null = null;
    if (type === "water" && missionRef) {
      const mSnap = await tx.get(missionRef);
      if (mSnap.exists()) {
        const m = mSnap.data() as MissionDoc;
        const lastTick = m.lastTickAt as unknown as Timestamp | undefined;
        const lastTickDate = lastTick ? lastTick.toDate().toISOString().slice(0, 10) : today;
        const lsToday = lastTickDate === today ? m.lifeSupportMl : 0;
        missionCtx = { ref: missionRef, data: m, lsToday };
      }
    }

    // Then writes.
    const prevLevel = user.level;
    const nextXp = user.xp + xpAwarded;
    const nextLevel = levelFromXp(nextXp);
    leveledUp = nextLevel > prevLevel;

    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const nextStreak =
      user.lastActiveDate === today
        ? user.streak
        : user.lastActiveDate === yesterday
          ? user.streak + 1
          : 1;

    tx.update(userRef, {
      xp: nextXp,
      level: nextLevel,
      streak: nextStreak,
      lastActiveDate: today,
    });

    tx.set(logRef, {
      type,
      source,
      createdAt: serverTimestamp(),
      date: today,
      payload,
      xpAwarded,
    });

    if (missionCtx) {
      const amountMl = (payload as { amountMl: number }).amountMl;
      const next = applySip({ ...missionCtx.data, lifeSupportMl: missionCtx.lsToday }, amountMl);
      sip = { toLS: next.allocation.toLifeSupport, toFuel: next.allocation.toFuel };
      tx.update(missionCtx.ref, {
        lifeSupportMl: next.lifeSupportMl,
        fuelMl: next.fuelMl,
        distanceTraveled: next.distanceTraveled,
        lastTickAt: serverTimestamp(),
        ...(next.distanceTraveled >= 1 ? { status: "complete" } : {}),
      });
    }
  });

  return { xpAwarded, leveledUp, sip };
}

export async function getTodayHealth(uid: string): Promise<HealthDayDoc | null> {
  const db = getClientDb();
  const ref = doc(db, paths.healthDay(uid, todayDate()));
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data() as HealthDayDoc) : null;
}

export function subscribeTodayHealth(uid: string, cb: (h: HealthDayDoc | null) => void): Unsubscribe {
  const db = getClientDb();
  return onSnapshot(doc(db, paths.healthDay(uid, todayDate())), (snap) => {
    cb(snap.exists() ? (snap.data() as HealthDayDoc) : null);
  });
}

export async function updateSettings(uid: string, patch: Partial<UserSettings>) {
  const db = getClientDb();
  const ref = doc(db, paths.user(uid));
  const snap = await getDoc(ref);
  const current = (snap.data() as UserDoc | undefined)?.settings;
  await setDoc(ref, { settings: { ...current, ...patch } }, { merge: true });
}

export async function updateMissionSettings(
  uid: string,
  missionId: string,
  patch: Partial<MissionDoc["settings"]> & { durationDays?: number },
) {
  const db = getClientDb();
  const ref = doc(db, paths.mission(uid, missionId));
  const snap = await getDoc(ref);
  const current = snap.data() as MissionDoc | undefined;
  if (!current) return;
  const settings = { ...current.settings, ...patch };
  await setDoc(
    ref,
    {
      settings,
      ...(patch.durationDays ? { durationDays: patch.durationDays } : {}),
    },
    { merge: true },
  );
}

export async function appendMessage(
  uid: string,
  msg: Omit<ConversationMessageDoc, "id" | "createdAt"> & { createdAt?: unknown },
): Promise<string> {
  const db = getClientDb();
  const ref = await addDoc(collection(db, paths.conversation(uid)), {
    ...msg,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function subscribeMessages(
  uid: string,
  cb: (msgs: ConversationMessageDoc[]) => void,
): Unsubscribe {
  const db = getClientDb();
  const q = query(
    collection(db, paths.conversation(uid)),
    orderBy("createdAt", "asc"),
    limit(200),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ConversationMessageDoc, "id">) })));
  });
}
