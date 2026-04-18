"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { ensureUserDoc } from "@/lib/data";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    if (user) ensureUserDoc(user).catch(console.error);
  }, [user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="blink font-mono uppercase tracking-widest text-[color:var(--color-cyan)]">
          Booting system…
        </span>
      </div>
    );
  }

  if (!user) return null;
  return <>{children}</>;
}
