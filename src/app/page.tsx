"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

export default function LandingPage() {
  const { user, loading, signIn, configured } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/hq");
  }, [loading, user, router]);

  return (
    <main className="relative min-h-screen overflow-hidden">
      <div className="grid-floor" />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-10 px-6 text-center">
        <div>
          <div
            className="neon-text-magenta flicker"
            style={{ fontFamily: "var(--font-display)", fontSize: 64, lineHeight: 1 }}
          >
            LEVEL<span className="neon-text-cyan">UP</span>
          </div>
          <div className="mt-2 font-mono text-xs uppercase tracking-[0.3em] opacity-80">
            ◄ Fitness — loaded ►
          </div>
        </div>

        <p className="max-w-md font-mono text-sm leading-relaxed opacity-90">
          A gamified, synthwave fitness quest. Log meals, moves, and every sip of water with
          Commander Rex — and power a rocket to the stars along the way.
        </p>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button onClick={signIn} className="btn-retro">
            ▶ Insert Coin (Sign in)
          </button>
          <div className="font-mono text-[10px] uppercase tracking-widest opacity-60">
            Google sign-in · no ads · no calories counted without consent
          </div>
          {!configured && (
            <div className="panel panel-magenta p-3 mt-2 text-left">
              <div className="font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-magenta)] mb-1">
                ⚠ System offline
              </div>
              <div className="font-mono text-[11px] leading-relaxed opacity-90">
                Firebase keys not detected. Edit{" "}
                <code className="text-[color:var(--color-lemon)]">.env.local</code>
                {" "}and restart the dev server to enable sign-in.
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-6 font-mono text-[10px] uppercase tracking-widest opacity-50">
          © 20XX · Cadet, prepare for orbit.
        </div>
      </div>
    </main>
  );
}
