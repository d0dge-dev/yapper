import { PauseIcon, PhoneCallIcon, PhoneIncomingIcon, PhoneMissedIcon, PhoneOutgoingIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { type CallEntry, callBack, openThread, useUi } from "~/yap";

const REASON: Record<string, string> = {
  done: "fertig",
  approval: "braucht Freigabe",
  question: "hat eine Frage",
  failed: "fehlgeschlagen",
};

function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000);
  if (days === 0) return time;
  if (days === 1) return `gestern ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "numeric" })} ${time}`;
}

function duration(e: CallEntry): string | null {
  if (!e.endedAt || e.status === "missed" || e.status === "ringing") return null;
  const s = Math.max(0, Math.round((e.endedAt - e.startedAt) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
}

function describe(e: CallEntry): string {
  if (e.direction === "outgoing") return e.status === "active" ? "läuft gerade" : "Du hast angerufen";
  const why = e.reason ? REASON[e.reason] ?? e.reason : "Rückruf";
  if (e.status === "missed") return `Verpasster Rückruf · ${why}`;
  if (e.status === "ringing") return `Klingelt · ${why}`;
  return `Rückruf · ${why}`;
}

/** Call log, phone-app style: missed callbacks in red, their result playable, one tap to call back. */
export function CallLog() {
  const ui = useUi();
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => () => audio.current?.pause(), []);

  const toggle = (e: CallEntry) => {
    if (playing === e.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(`api/calls/${e.id}/audio`);
    a.onended = () => setPlaying(null);
    a.onerror = () => setPlaying(null);
    audio.current = a;
    setPlaying(e.id);
    a.play().catch(() => setPlaying(null));
  };

  if (ui.calls.length === 0)
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-2 px-(--workspace-gutter) text-center">
        <PhoneCallIcon className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">Noch keine Anrufe.</p>
      </main>
    );

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-1 flex-col px-(--workspace-gutter) pt-2">
      <ul className="-mx-1 min-h-0 flex-1 overflow-y-auto pb-3">
        {ui.calls.map((e) => {
          const missed = e.status === "missed";
          const Icon = e.direction === "outgoing" ? PhoneOutgoingIcon : missed ? PhoneMissedIcon : PhoneIncomingIcon;
          const len = duration(e);
          return (
            <li key={e.id} className="flex items-start gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-accent">
              <Icon className={cn("mt-0.5 size-4 shrink-0", missed ? "text-destructive" : "text-muted-foreground")} />
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-start outline-none"
                onClick={() => openThread(ui.threads.find((t) => t.id === e.threadId) ?? { id: e.threadId, title: e.title || "Thread", projectTitle: "" })}
              >
                <span className={cn("truncate text-sm", missed ? "text-destructive" : "text-foreground")}>
                  {ui.threads.find((t) => t.id === e.threadId)?.title || e.title || "Thread"}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {describe(e)} · {when(e.startedAt)}
                  {len && ` · ${len}`}
                </span>
                {e.summary && e.direction === "incoming" && <span className="line-clamp-2 text-muted-foreground text-xs">{e.summary}</span>}
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {e.audio && (
                  <button
                    type="button"
                    aria-label={playing === e.id ? "Anhalten" : "Anhören"}
                    onClick={() => toggle(e)}
                    className="flex size-9 cursor-pointer items-center justify-center rounded-full border bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {playing === e.id ? <PauseIcon className="size-4" /> : <PlayIcon className="size-4" />}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Zurückrufen"
                  onClick={() => callBack(e)}
                  className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PhoneCallIcon className="size-4" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
