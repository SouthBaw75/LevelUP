import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function RetroPanel({
  title,
  children,
  variant = "cyan",
  className,
}: {
  title?: string;
  children: ReactNode;
  variant?: "cyan" | "magenta";
  className?: string;
}) {
  return (
    <div className={cn("panel p-4", variant === "magenta" && "panel-magenta", className)}>
      {title && (
        <div
          className={cn(
            "mb-3 flex items-center justify-between text-xs uppercase tracking-widest font-mono",
            variant === "magenta" ? "text-[color:var(--color-magenta)]" : "text-[color:var(--color-cyan)]",
          )}
        >
          <span>{title}</span>
          <span className="blink">▌</span>
        </div>
      )}
      {children}
    </div>
  );
}
