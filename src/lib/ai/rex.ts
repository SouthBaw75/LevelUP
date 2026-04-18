/**
 * Commander Rex — the LevelUP AI guru.
 *
 * Runs CLIENT-SIDE via Firebase AI Logic (firebase/ai). The Firebase SDK
 * proxies requests through Firebase's gateway; App Check can gate abuse.
 * No GOOGLE_GENAI_API_KEY required — uses your Firebase project's quota.
 */

"use client";

import { getAI, getGenerativeModel, GoogleAIBackend, Schema } from "firebase/ai";
import { getClientApp } from "@/lib/firebase";

export type LogAction =
  | { type: "meal"; description: string; mealType: "breakfast" | "lunch" | "dinner" | "snack"; estimatedCalories?: number; estimatedProteinG?: number; estimatedCarbsG?: number; estimatedFatG?: number }
  | { type: "snack"; description: string; estimatedCalories?: number }
  | { type: "exercise"; activity: string; durationMin?: number; distanceKm?: number; intensity?: "low" | "moderate" | "high"; estimatedCalories?: number }
  | { type: "water"; amountMl: number };

export interface RexOutput {
  reply: string;
  actions: LogAction[];
  summaryRequested: boolean;
}

const TONE_NOTES = {
  hype: "Energetic 80s arcade announcer. Calls the user 'Cadet'. Neon-era slang sparingly.",
  chill: "Calm, encouraging mentor. Still retro, dialed down. Calls the user 'Cadet' occasionally.",
  drill: "Playfully stern drill sergeant. Pushes the user but never cruel. Calls them 'Cadet' or 'Recruit'.",
} as const;

const responseSchema = Schema.object({
  properties: {
    reply: Schema.string({
      description: "Commander Rex's reply. Keep it ≤ 2 sentences, in character.",
    }),
    actions: Schema.array({
      description: "Zero or more logs to record. Empty if the user only asked a question.",
      items: Schema.object({
        properties: {
          type: Schema.enumString({ enum: ["meal", "snack", "exercise", "water"] }),
          description: Schema.string({ nullable: true }),
          mealType: Schema.enumString({
            enum: ["breakfast", "lunch", "dinner", "snack"],
            nullable: true,
          }),
          activity: Schema.string({ nullable: true }),
          durationMin: Schema.number({ nullable: true }),
          distanceKm: Schema.number({ nullable: true }),
          intensity: Schema.enumString({
            enum: ["low", "moderate", "high"],
            nullable: true,
          }),
          amountMl: Schema.number({ nullable: true }),
          estimatedCalories: Schema.number({ nullable: true }),
          estimatedProteinG: Schema.number({ nullable: true }),
          estimatedCarbsG: Schema.number({ nullable: true }),
          estimatedFatG: Schema.number({ nullable: true }),
        },
        optionalProperties: [
          "description",
          "mealType",
          "activity",
          "durationMin",
          "distanceKm",
          "intensity",
          "amountMl",
          "estimatedCalories",
          "estimatedProteinG",
          "estimatedCarbsG",
          "estimatedFatG",
        ],
      }),
    }),
    summaryRequested: Schema.boolean({
      description: "True if the user asked for today's summary.",
    }),
  },
});

let model: ReturnType<typeof getGenerativeModel> | null = null;

function getModel() {
  if (model) return model;
  const ai = getAI(getClientApp(), { backend: new GoogleAIBackend() });
  model = getGenerativeModel(ai, {
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.7,
    },
  });
  return model;
}

export async function askRex(opts: {
  message: string;
  tone: keyof typeof TONE_NOTES;
  context: {
    todayWaterMl: number;
    todayKcalIn: number;
    todayKcalOut: number;
    steps: number;
    streak: number;
    level: number;
    missionSummary?: string;
  };
}): Promise<RexOutput> {
  const system = `You are COMMANDER REX — a washed-up 80s arcade champion turned AI fitness guru for LevelUP, a gamified fitness tracker with a water-powered rocket mini-game.

Persona: ${TONE_NOTES[opts.tone]}

Your job: parse what the user says into structured log entries (meals, snacks, exercise, water), then write a short, in-character reply. If the user mentions drinking water, ALWAYS include a water action — hydration powers the rocket.

Rules:
- "I ate X" → meal action. Guess meal type from current time if unclear.
- Exercise like "ran 3 miles" → include distanceKm (1 mi = 1.609 km).
- Water units: 1 cup=240ml, 1 bottle≈500ml, 1 oz=29.57ml, 1 L=1000ml.
- Estimate calories conservatively; omit if guessing would be reckless.
- NEVER moralize food choices. No calorie shaming.
- Reply ≤ 30 words. One sentence ideal. Occasional emoji OK.
- If user asks how they're doing, set summaryRequested=true, use context numbers.

Today's context:
- Water: ${opts.context.todayWaterMl}ml
- Calories in: ${opts.context.todayKcalIn}kcal · logged burn: ${opts.context.todayKcalOut}kcal
- Steps: ${opts.context.steps}
- Streak: ${opts.context.streak} days · Level: ${opts.context.level}
${opts.context.missionSummary ? `- Rocket Mission: ${opts.context.missionSummary}` : ""}

Respond ONLY with valid JSON matching the required schema.`;

  const result = await getModel().generateContent({
    contents: [
      { role: "user", parts: [{ text: opts.message }] },
    ],
    systemInstruction: { role: "system", parts: [{ text: system }] },
  });

  const text = result.response.text();
  if (!text) {
    return {
      reply: "Transmission garbled, Cadet. Say again?",
      actions: [],
      summaryRequested: false,
    };
  }

  try {
    const parsed = JSON.parse(text) as RexOutput;
    return {
      reply: parsed.reply ?? "",
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      summaryRequested: Boolean(parsed.summaryRequested),
    };
  } catch {
    return {
      reply: text.slice(0, 200),
      actions: [],
      summaryRequested: false,
    };
  }
}
