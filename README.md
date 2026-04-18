# LevelUP 🚀

A retro synthwave, AI-guided fitness tracker with a water-powered rocket mini-game.

> **Insert coin. Hydrate. Fly.**

LevelUP is a gamified fitness PWA built with Next.js 15, Firebase, and
Genkit + Gemini. Log meals, snacks, exercise, and every sip of water by chatting
with **Commander Rex** — a washed-up 80s arcade champion turned AI guru. Every
cup of water routes between your astronaut's life support and a rocket's fuel
tank, pushing a mission from Earth toward the Moon, Mars, or beyond.

---

## Feature map (v1)

- **HQ Dashboard** — today's rings (hydro / steps / calories), XP bar, streak, rocket status tile, quick-log sips.
- **Commander Rex chat** — natural-language logging. Says "ate a burrito at 1pm" → parsed into a meal log + XP + reply.
- **🚀 Rocket Mission** — hydration powers a pixel-art rocket. Life-support floor (priority) + fuel ratio split + destination + duration are all tunable.
- **Captain's Log** — 14-day history grouped by day with per-day totals.
- **Settings** — tone dial (Hype / Chill / Drill), units, goals, Apple Shortcuts setup guide.

## Tech stack

| Layer       | Choice                                         |
|-------------|------------------------------------------------|
| UI          | Next.js 15 (App Router) · React 19 · TypeScript |
| Styling     | Tailwind v4 with a custom synthwave theme + CRT scanlines |
| Auth + DB   | Firebase Auth (Google) · Firestore              |
| AI          | Firebase AI Logic (`firebase/ai`) · Gemini 2.5 Flash |
| Hosting     | Firebase App Hosting                            |
| Health sync | Apple Shortcuts → `/api/health-sync` webhook    |

## Getting started

```bash
# 1. Install
npm install

# 2. Configure
cp .env.local.example .env.local   # fill in Firebase + Gemini keys

# 3. Run
npm run dev
```

Open http://localhost:3000, click **Insert Coin**, sign in with Google.

### Firebase setup

1. Create a Firebase project → enable **Authentication** (Google provider).
2. Enable **Firestore** in Native mode.
3. Copy the web app config into `.env.local` (`NEXT_PUBLIC_FIREBASE_*`).
4. From *Project Settings → Service accounts*, download a service-account JSON;
   paste the contents into `FIREBASE_SERVICE_ACCOUNT_JSON` (single line, or base64-encoded).
5. Deploy Firestore rules + indexes:
   ```bash
   npx firebase deploy --only firestore:rules,firestore:indexes
   ```

### Commander Rex (Firebase AI Logic)

1. In Firebase Console, open **Build → AI Logic** → enable the service (pick
   the **Gemini Developer API** backend — the free tier option).
2. That's it — no separate API key needed. The web SDK (`firebase/ai`) proxies
   requests through Firebase using your existing web config.

**Recommended**: enable [Firebase App Check](https://firebase.google.com/docs/app-check)
for production to prevent abuse of the AI endpoint from outside your app.

### Apple Health sync (iOS)

HealthKit is not reachable from the browser. LevelUP ships an **Apple Shortcuts**
path that requires no App Store review.

1. Set `HEALTH_SYNC_SECRET` to a long random string in your env.
2. On iOS, open **Shortcuts** → **Automation** → **+ → Time of Day** (e.g. 11:55 PM daily).
3. Inside the automation, add actions:
   - *Find Health Samples* → Steps (today's total)
   - *Find Health Samples* → Active Energy (today's total)
   - *Find Health Samples* → Basal Energy (today's total)
   - *Find Health Samples* → Walking+Running Distance (today's total)
   - *Get Contents of URL* → `POST https://<your-domain>/api/health-sync`
     with JSON body:
     ```json
     {
       "secret": "<HEALTH_SYNC_SECRET>",
       "userId": "<your Firebase UID>",
       "date": "<YYYY-MM-DD>",
       "steps": 8123,
       "activeCalories": 412,
       "basalCalories": 1500,
       "distanceMeters": 6200
     }
     ```
4. Your UID is shown on the **Settings** screen. Copy it into the Shortcut.

*(In v2 we may ship a thin companion iOS app for a one-tap setup.)*

## Rocket math

Every sip is allocated in two phases:

1. **Life support floor** — until today's tank hits
   `settings.lifeSupportFloorMlPerDay`, 100% of the sip goes to life support.
2. **Soft split** — after the floor is met, each sip splits by `ratioFuelPct`.
   Surplus life-support water just stays in the tank (it's good for you).

Fuel is cumulative over the mission; distance is `fuelMl / targetMl`. The tank
resets at each new day (a missed floor fails the mission — not yet enforced in v1).

See [`src/lib/mission.ts`](./src/lib/mission.ts) for the full allocator.

## Firestore schema (high level)

```
users/{uid}
  xp, level, streak, lastActiveDate, settings{...}
  logs/{id}          type: water|meal|snack|exercise, date, payload, xpAwarded
  missions/{id}      destination, targetMl, duration, lifeSupportMl, fuelMl, distanceTraveled, settings
  healthDays/{YYYY-MM-DD}   steps, activeCalories, basalCalories, distanceMeters   (server-written)
  conversation/{id}  role, content, createdAt
  achievements/{id}  title, unlockedAt
```

Rules live in [`firestore.rules`](./firestore.rules): users can only read/write
their own subtree; `healthDays` is server-write-only.

## Deployment

```bash
# First time only
npx firebase init apphosting    # pick your project
npx firebase apphosting:secrets:set FIREBASE_SERVICE_ACCOUNT_JSON
npx firebase apphosting:secrets:set HEALTH_SYNC_SECRET

# Deploy
git push origin main    # App Hosting builds from your connected repo
```

## Roadmap (post-v1)

- Achievements engine + retro unlock animation
- Daily life-support enforcement (scheduled Cloud Function tick)
- Chiptune SFX on log + level-up + launch
- Social: friend leaderboards + co-op missions
- Companion iOS app with native HealthKit read
- Offline log queue (service worker)

---

*© 20XX — Cadet, prepare for orbit.*
