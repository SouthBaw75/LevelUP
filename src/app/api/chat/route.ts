import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";
import { askRex } from "@/lib/ai/rex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const idToken = authHeader.slice("Bearer ".length);

  try {
    await getAdminAuth().verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = (await req.json()) as {
    message: string;
    tone: "hype" | "chill" | "drill";
    context: {
      todayWaterMl: number;
      todayKcalIn: number;
      todayKcalOut: number;
      steps: number;
      streak: number;
      level: number;
      missionSummary?: string;
    };
  };

  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }

  const output = await askRex({
    message: body.message,
    tone: body.tone ?? "hype",
    context: body.context,
  });

  return NextResponse.json(output);
}
