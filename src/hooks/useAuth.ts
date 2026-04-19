"use client";

import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  type User,
} from "firebase/auth";
import { getClientAuth, isFirebaseConfigured } from "@/lib/firebase";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const configured = isFirebaseConfigured();

  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    const auth = getClientAuth();
    // Handle redirect result on page load
    getRedirectResult(auth).catch(() => {});
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, [configured]);

  async function signIn() {
    if (!configured) {
      alert(
        "Firebase isn't configured yet. Copy .env.local.example to .env.local, fill in your Firebase + Gemini keys, then restart `npm run dev`.",
      );
      return;
    }
    const auth = getClientAuth();
    await signInWithRedirect(auth, new GoogleAuthProvider());
  }

  async function signOutUser() {
    if (!configured) return;
    await signOut(getClientAuth());
  }

  return { user, loading, signIn, signOut: signOutUser, configured };
}
