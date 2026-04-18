/**
 * Commander Rex — the LevelUP AI guru.
 * Runs server-side via Genkit + Gemini. Returns a structured parse of the user's message
 * into log actions, plus a quirky reply. Logging itself is done client-side so the
 * Firestore transaction can run with the user's auth state.
 */

import { genkit, z } from "genkit";
import { googleAI } from "@genkit-ai/googleai";

const ai = genkit({
  plugins: [googleAI()],
  model: "googleai/gemini-2.0-flash",
});

const LogAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("meal"),
    description: z.string(),
    mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]),
    estimatedCalories: z.number().optional(),
    estimatedProteinG: z.number().optional(),
    estimatedCarbsG: z.number().optional(),
    estimatedFatG: z.number().optional(),
  }),
  z.object({
    type: z.literal("snack"),
    description: z.string(),
    estimatedCalories: z.number().optional(),
  }),
  z.object({
    type: z.literal("exercise"),
    activity: z.string(),
    durationMin: z.number().optional(),
    distanceKm: z.number().optional(),
    intensity: z.enum(["low", "moderate", "high"]).optional(),
    estimatedCalories: z.number().optional(),
  }),
  z.object({
    type: z.literal("water"),
    amountMl: z.number(),
  }),
]);

export type LogAction = z.infer<typeof LogAction>;

const RexOutput = z.object({
  reply: z.string().describe("Commander Rex's reply. Keep it <= 2 sentences, in character."),
  actions: z.array(LogAction).describe("Zero or more logs to record. Leave empty if the user only asked a question."),
  summaryRequested: z.boolean().describe("True if the user asked for today's summary."),
});

export type RexOutput = z.infer<typeof RexOutput>;

const TONE_NOTES = {
  hype: "Energetic 80s arcade announcer. Calls the user 'Cadet'. Use neon-era slang sparingly.",
  chill: "Calm, encouraging mentor. Still retro, but dialed down. Calls the user 'Cadet' occasionally.",
  drill: "Playfully stern drill sergeant. Pushes the user but never cruel. Calls the user 'Cadet' or 'Recruit'.",
} as const;

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
  const system = `You are COMMANDER REX — a washed-up 80s arcade champion turned AI fitness guru for LevelUP,
a gamified fitness tracker with a water-powered rocket mini-game. Persona: ${TONE_NOTES[opts.tone]}

Your job: parse what the user says into structured log entries (meals, snacks, exercise, water),
then write a short, in-character reply. If the user drinks water, ALWAYS include a water action —
hydration powers the rocket.

Rules:
- If the user says "I ate X", emit a meal action. Guess meal type from time of day if unclear.
- If exercise mentions duration + activity (e.g., "ran 3 miles"), include distanceKm (convert miles: mi*1.609).
- For water, convert units: 1 cup = 240ml, 1 bottle ≈ 500ml, 1 oz = 29.57ml, 1 L = 1000ml.
- Estimate calories conservatively when you have enough info; leave blank if guessing would be reckless.
- NEVER moralize about food choices. No calorie shaming.
- Keep replies under 30 words. One sentence is ideal. Occasional emoji OK.
- If the user asks how they're doing, set summaryRequested=true and use context numbers in your reply.

Context for today:
- Water: ${opts.context.todayWaterMl}ml
- Calories in: ${opts.context.todayKcalIn}kcal · logged burn: ${opts.context.todayKcalOut}kcal
- Steps (Apple Health): ${opts.context.steps}
- Streak: ${opts.context.streak} days · Level: ${opts.context.level}
${opts.context.missionSummary ? `- Rocket Mission: ${opts.context.missionSummary}` : ""}`;

  const { output } = await ai.generate({
    system,
    prompt: opts.message,
    output: { schema: RexOutput },
  });

  if (!output) {
    return {
      reply: "Transmission garbled, Cadet. Say again?",
      actions: [],
      summaryRequested: false,
    };
  }
  return output;
}
