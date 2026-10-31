import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { type NativeStatus, getNativeStatus, isNative, openNativeSettings } from "./native";

type Missing = { what: "notifications" | "fullScreenIntent" | "distributor"; text: string };

function missing(s: NativeStatus): Missing | null {
  if (!s.notifications) return { what: "notifications", text: "Benachrichtigungen sind aus: Anrufe und Rückrufe zeigen nichts an." };
  if (!s.fullScreenIntent) return { what: "fullScreenIntent", text: "Vollbild ist aus: Rückrufe klingeln nur als Banner, auch bei gesperrtem Handy." };
  if (!s.distributor) return { what: "distributor", text: "Kein UnifiedPush (ntfy): Rückrufe können dein Handy nicht erreichen." };
  return null;
}

/**
 * In the Android app only: a banner when a permission callbacks need is off. Android can revoke them (an app update
 * resets "full screen notifications"), so it's checked whenever the app comes back to the foreground.
 */
export function PermissionBanner() {
  const [problem, setProblem] = useState<Missing | null>(null);
  useEffect(() => {
    if (!isNative) return;
    const check = () => getNativeStatus().then((s) => setProblem(s ? missing(s) : null));
    check();
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  if (!problem) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-warning/32 bg-warning-surface p-3 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
      <p className="min-w-0 flex-1 text-warning-foreground">{problem.text}</p>
      <button
        type="button"
        onClick={() => openNativeSettings(problem.what)}
        className="shrink-0 cursor-pointer rounded-full bg-warning px-3 py-1 font-medium text-white text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Erlauben
      </button>
    </div>
  );
}
