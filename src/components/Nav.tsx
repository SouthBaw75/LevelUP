"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/hq", label: "HQ" },
  { href: "/chat", label: "REX" },
  { href: "/rocket", label: "ROCKET" },
  { href: "/history", label: "LOG" },
  { href: "/settings", label: "SYS" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-[color:var(--color-cyan)]/40 bg-[color:var(--color-void)]/90 backdrop-blur">
      <ul className="mx-auto flex max-w-xl items-stretch">
        {TABS.map((t) => {
          const active = pathname?.startsWith(t.href);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  active
                    ? "text-[color:var(--color-magenta)]"
                    : "text-[color:var(--color-electric)]/70 hover:text-[color:var(--color-cyan)]",
                )}
              >
                <span
                  style={{ fontFamily: "var(--font-display)", fontSize: 22 }}
                  className={active ? "neon-text-magenta" : ""}
                >
                  {t.label}
                </span>
                <span className={cn("h-0.5 w-6 rounded", active ? "bg-[color:var(--color-magenta)]" : "bg-transparent")} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
