import { BluetoothIcon, EarIcon, HeadphonesIcon, Volume2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { AUDIO_ROUTE_LABELS, type AudioRoute, type AudioRoutes, isNative, nextAudioRoute, onAudioRoutes, setAudioRoute } from "./native";

const ICONS: Record<AudioRoute, typeof Volume2Icon> = {
  speaker: Volume2Icon,
  earpiece: EarIcon,
  bluetooth: BluetoothIcon,
  wired: HeadphonesIcon,
};

/**
 * Speaker / earpiece / Bluetooth / wired toggle for the live view, in the style of App.tsx's LiveButton.
 * Only renders inside the Android app, once the native call reports its routes. A tap cycles to the next
 * available route; with a single route the button is shown but disabled.
 */
export function AudioRouteButton({ className }: { className?: string }) {
  const [routes, setRoutes] = useState<AudioRoutes | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => (isNative ? onAudioRoutes(setRoutes) : undefined), []);

  if (!isNative || !routes?.current) return null;
  const current = routes.current;
  const next = nextAudioRoute(routes);
  const Icon = ICONS[current];
  const name = (r: AudioRoute) => routes.names[r] ?? AUDIO_ROUTE_LABELS[r];
  const label = next && next !== current ? `Audio: ${name(current)} (tippen für ${name(next)})` : `Audio: ${name(current)}`;

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy || !next || next === current}
      onClick={async () => {
        if (!next) return;
        setBusy(true);
        await setAudioRoute(next);
        setBusy(false);
      }}
      className={cn(
        "flex size-14 cursor-pointer items-center justify-center rounded-full border bg-card/80 text-foreground shadow-composer outline-none backdrop-blur transition-[scale,opacity] active:scale-95 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 dark:shadow-composer-dark",
        current !== "speaker" && "bg-accent",
        className,
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}
