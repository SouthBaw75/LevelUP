import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Endpoint for Apple Shortcuts (or any trusted caller) to push daily HealthKit data.
 *
 * POST body:
 * {
 *   "secret": "<HEALTH_SYNC_SECRET>",
 *   "userId": "<firebase uid>",
 *   "date": "YYYY-MM-DD",
 *   "steps": number,
 *   "activeCalories": number,
 *   "basalCalories": number,
 *   "distanceMeters": number
 * }
 */
export async function POST(req: Request) {
  const secret = process.env.HEALTH_SYNC_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  let body: {
    secret?: string;
    userId?: string;
    date?: string;
    steps?: number;
    activeCalories?: number;
    basalCalories?: number;
    distanceMeters?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.secret || body.secret !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!body.userId || !body.date) {
    return NextResponse.json({ error: "Missing userId or date" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const db = getAdminDb();
  const ref = db.doc(`users/${body.userId}/healthDays/${body.date}`);
  await ref.set(
    {
      date: body.date,
      steps: Number(body.steps ?? 0),
      activeCalories: Number(body.activeCalories ?? 0),
      basalCalories: Number(body.basalCalories ?? 0),
      distanceMeters: Number(body.distanceMeters ?? 0),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await db.doc(`users/${body.userId}`).set(
    { health: { lastSyncAt: FieldValue.serverTimestamp() } },
    { merge: true },
  );

  return NextResponse.json({ ok: true });
}
