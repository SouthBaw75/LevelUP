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

    // Subscribe to auth state — fires immediately with null, then again after redirect
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });

    // Process any pending redirect result — this will trigger onAuthStateChanged
    getRedirectResult(auth).catch(() => {});

    return unsub;
  }, [configured]);

  async function signIn() {
    if (!configured) {
      alert("Firebase isn't configured. Fill in .env.local and restart.");
      return;
    }
    try {
      const auth = getClientAuth();
      await signInWithRedirect(auth, new GoogleAuthProvider());
    } catch (e) {
      console.error("signIn error:", e);
    }
  }

  async function signOutUser() {
    if (!configured) return;
    await signOut(getClientAuth());
  }

  return { user, loading, signIn, signOut: signOutUser, configured };
}
