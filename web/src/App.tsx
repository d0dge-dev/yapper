import {
  ArrowUpIcon,
  AudioLinesIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  KeyboardIcon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  PhoneForwardedIcon,
  PhoneIcon,
  PhoneOffIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  SparklesIcon,
  SquareIcon,
  VolumeXIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { AudioRouteButton } from "~/AudioRouteButton";
import { CallLog } from "~/CallLog";
import { ThreadConfigDialog, configLabel } from "~/ModelConfig";
import { NewThreadDialog } from "~/NewThreadDialog";
import { PermissionBanner } from "~/PermissionBanner";
import { SettingsDialog } from "~/SettingsDialog";
import { cn } from "~/lib/utils";
import {
  type Thread,
  type TimelineItem,
  endCall,
  hush,
  loadModels,
  openThread,
  requestCallback,
  send,
  setLive,
  showCalls,
  startCall,
  toggleMute,
  typeText,
  useUi,
} from "~/yap";

export function App() {
  const ui = useUi();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  useEffect(() => {
    loadModels().catch(() => {});
  }, []);

  return (
    <div className="flex h-full flex-col pb-safe">
      <header className="flex h-[calc(var(--workspace-topbar-height)+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b px-2 pt-safe">
        {(ui.current || ui.view === "calls") && (
          <Button size="icon" variant="ghost" aria-label="Zurück" onClick={() => history.back()}>
            <ChevronLeftIcon />
          </Button>
        )}
        <h1 className={cn("min-w-0 flex-1 truncate font-medium text-sm", !ui.current && ui.view !== "calls" && "ps-2")}>
          {!ui.current && ui.view === "calls" ? "Anrufe" : ui.title}
        </h1>
        {ui.current && <ModelChip onClick={() => setConfigOpen(true)} />}
        {!ui.current && ui.view === "threads" && (
          <Button size="icon" variant="ghost" aria-label="Anrufe" className="relative" onClick={() => showCalls(true)}>
            <PhoneIcon />
            {ui.missed > 0 && (
              <span className="absolute -end-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-medium text-[10px] text-white leading-4">
                {ui.missed}
              </span>
            )}
          </Button>
        )}
        <Button size="icon" variant="ghost" aria-label="Einstellungen" onClick={() => setSettingsOpen(true)}>
          <Settings2Icon />
        </Button>
      </header>

      {ui.current ? <ThreadView /> : ui.view === "calls" ? <CallLog /> : <Picker threads={ui.threads} />}
      {ui.current && ui.inCall && ui.live && <LiveView onConfig={() => setConfigOpen(true)} />}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ThreadConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
    </div>
  );
}

function ModelChip({ onClick, className }: { onClick: () => void; className?: string }) {
  const ui = useUi();
  return (
    <Button size="sm" variant="outline" className={cn("max-w-[48%] shrink-0 rounded-full", className)} onClick={onClick}>
      <SparklesIcon className="opacity-70" />
      <span className="truncate">{configLabel(ui.current?.config, ui.models)}</span>
    </Button>
  );
}

// ------------------------------------------------------------------ thread picker

function Picker({ threads }: { threads: Thread[] }) {
  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const query = q.trim().toLowerCase();
  const shown = threads.filter((t) => !query || `${t.title} ${t.projectTitle}`.toLowerCase().includes(query)).slice(0, 80);
  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-1 flex-col gap-2 px-(--workspace-gutter) pt-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            size="lg"
            placeholder="Thread suchen…"
            autoComplete="off"
            className="[&_input]:ps-9"
            value={q}
            onValueChange={setQ}
          />
        </div>
        <Button size="icon-lg" variant="outline" aria-label="Neuer Thread" onClick={() => setNewOpen(true)}>
          <PlusIcon />
        </Button>
      </div>
      <NewThreadDialog open={newOpen} onOpenChange={setNewOpen} />
      <PermissionBanner />
      <ul className="-mx-1 min-h-0 flex-1 overflow-y-auto pb-3">
        {shown.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => openThread(t)}
              className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                {t.pinned && <PinIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate">{t.title}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
                <span className="truncate">{t.projectTitle}</span>
                {t.running && (
                  <Badge variant="info" size="sm" className="gap-1">
                    <span className="size-1.5 animate-status-pulse rounded-full bg-info" />
                    arbeitet
                  </Badge>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

// ------------------------------------------------------------------ thread (chat) view

function ThreadView() {
  const ui = useUi();
  const draft = ui.current?.draft === true;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {ui.timeline.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-(--workspace-gutter) text-center">
          <p className="text-lg">{draft ? "Worum geht's?" : "Noch nichts hier."}</p>
          <p className="text-muted-foreground text-sm">{draft ? `Neuer Thread in ${ui.current?.projectTitle}. Ruf an oder tippe.` : ui.status}</p>
        </div>
      ) : (
        <Timeline items={ui.timeline} />
      )}

      {ui.inCall && !ui.live && (
        <div className="mx-auto mb-1 flex w-full max-w-(--chat-content-max-width) px-(--workspace-gutter)">
          <div className="flex w-full items-center gap-2 rounded-full border bg-card py-1 ps-3.5 pe-1 shadow-composer dark:shadow-composer-dark">
            <span className="live-dot" data-state={ui.orb} />
            <span className="min-w-0 flex-1 truncate text-sm">{ui.orbLabel}</span>
            <Button size="icon-sm" variant={ui.muted ? "secondary" : "ghost"} aria-label={ui.muted ? "Mikrofon an" : "Stummschalten"} onClick={toggleMute}>
              {ui.muted ? <MicOffIcon /> : <MicIcon />}
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Vollbild" onClick={() => setLive(true)}>
              <Maximize2Icon />
            </Button>
            <Button size="icon-sm" variant="destructive" className="rounded-full" aria-label="Auflegen" onClick={endCall}>
              <PhoneOffIcon />
            </Button>
          </div>
        </div>
      )}

      <Composer placeholder={draft ? "Worum geht's?" : ui.inCall ? "Tippen statt reden…" : "Nachricht…"} showCall={!ui.inCall} />
    </main>
  );
}

function Composer({ placeholder, showCall, autoFocus }: { placeholder: string; showCall: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    typeText(t);
    setText("");
  };
  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-2 px-(--workspace-gutter) pt-1 pb-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[22px] border bg-card py-1.5 ps-4 pe-1.5 shadow-composer transition-shadow focus-within:border-ring/50 dark:shadow-composer-dark">
        <input
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-(length:--font-size-prompt-touch,16px) outline-none placeholder:text-placeholder sm:text-sm"
        />
        {text.trim() && (
          <button
            type="submit"
            aria-label="Senden"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover"
          >
            <ArrowUpIcon className="size-4" />
          </button>
        )}
      </div>
      {showCall && (
        <button
          type="button"
          aria-label="Anrufen"
          onClick={() => startCall()}
          className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-primary ps-3.5 pe-4 font-medium text-primary-foreground text-sm shadow-composer outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AudioLinesIcon className="size-5" />
          Live
        </button>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ live (call) view

/** Full-screen call, Gemini Live style: big caption in the middle, light along the bottom edge, few controls. */
function LiveView({ onConfig }: { onConfig: () => void }) {
  const ui = useUi();
  const [typing, setTyping] = useState(false);
  const yours = !!ui.utterance;
  const caption = yours ? ui.utterance : ui.caption;

  return (
    <div className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background pt-safe pb-safe">
      <div className="live-glow" data-state={ui.orb} aria-hidden>
        <span />
        <span />
        <span />
      </div>

      <header className="relative flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-2">
        <Button size="icon" variant="ghost" aria-label="Zum Chat" onClick={() => setLive(false)}>
          <ChevronDownIcon />
        </Button>
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-sm">{ui.title}</p>
        <ModelChip onClick={onConfig} />
        <Button
          size="icon"
          variant={typing ? "secondary" : "ghost"}
          aria-label={typing ? "Tastatur schließen" : "Tippen"}
          onClick={() => setTyping((v) => !v)}
        >
          <KeyboardIcon />
        </Button>
      </header>

      <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
        <p className="text-muted-foreground text-sm">{ui.status}</p>
        <p
          className={cn(
            "line-clamp-6 max-w-xl text-balance font-medium text-[1.65rem] leading-snug transition-colors",
            yours ? "text-foreground/70" : "text-foreground",
          )}
        >
          {caption || (ui.orb === "connecting" ? "Verbinde…" : "")}
        </p>
        {yours && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="rounded-full" onClick={() => send({ type: "discard" })}>
              Verwerfen
            </Button>
            <Button size="sm" className="rounded-full" onClick={() => send({ type: "send_now" })}>
              Jetzt senden
            </Button>
          </div>
        )}
        {ui.approval.show && (
          <div className="w-full max-w-md rounded-2xl border border-warning/32 bg-warning-surface/90 p-4 text-sm backdrop-blur">
            <p className="mb-3 text-warning-foreground">{ui.approval.prompt}</p>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={() => send({ type: "approve", accept: true })}>
                Ja
              </Button>
              <Button className="flex-1" variant="destructive-outline" onClick={() => send({ type: "approve", accept: false })}>
                Nein
              </Button>
            </div>
          </div>
        )}
      </section>

      {typing && (
        <div className="relative">
          <Composer placeholder="Tippen statt reden…" showCall={false} autoFocus />
        </div>
      )}
      <div className="relative flex shrink-0 flex-wrap items-center justify-center gap-2.5 px-3 pt-2 pb-8">
        <LiveButton label={ui.muted ? "Mikrofon an" : "Stummschalten"} icon={ui.muted ? MicOffIcon : MicIcon} active={ui.muted} onClick={toggleMute} />
        <AudioRouteButton />
        <LiveButton label="Ruhe" icon={VolumeXIcon} onClick={hush} />
        <LiveButton label="Stopp" icon={SquareIcon} disabled={!ui.canInterrupt} onClick={() => send({ type: "interrupt" })} />
        {ui.canRing && <LiveButton label="Ruf mich zurück, wenn du fertig bist" icon={PhoneForwardedIcon} onClick={requestCallback} />}
        <button
          type="button"
          aria-label="Auflegen"
          onClick={endCall}
          className="flex size-16 cursor-pointer items-center justify-center rounded-full bg-destructive text-white shadow-lg outline-none transition-[scale] active:scale-95 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PhoneOffIcon className="size-6" />
        </button>
      </div>
    </div>
  );
}

function LiveButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  active,
}: {
  label: string;
  icon: typeof KeyboardIcon;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-14 cursor-pointer items-center justify-center rounded-full border bg-card/80 text-foreground shadow-composer outline-none backdrop-blur transition-[scale,opacity] active:scale-95 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 dark:shadow-composer-dark",
        active && "bg-accent",
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}

// ------------------------------------------------------------------ timeline

function renderMarkdown(text: string) {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return text
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part) =>
      part.startsWith("```")
        ? `<pre>${esc(part.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""))}</pre>`
        : esc(part).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"),
    )
    .join("");
}

function Timeline({ items }: { items: TimelineItem[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const last = items.at(-1);

  // Same rule as before: follow new items if already near the bottom, or always for live (non-history) items.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && last && (atBottom.current || !last.old)) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <ol
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-1 flex-col gap-3 overflow-y-auto px-(--workspace-gutter) py-4 text-sm leading-relaxed"
    >
      {items.map((m) => (
        <li
          key={m.id}
          className={cn(
            "whitespace-pre-wrap wrap-break-word",
            m.old && "opacity-55",
            m.role === "you" && "max-w-[80%] self-end rounded-2xl bg-message px-3 py-2 text-message-foreground",
            m.role === "agent" && "chat-markdown max-w-full self-start text-foreground",
            m.role === "activity" && "max-w-full truncate whitespace-nowrap px-0.5 font-mono text-2xs text-muted-foreground",
            m.role === "system" && "self-center text-center text-warning-foreground text-xs",
          )}
          {...(m.role === "agent" ? { dangerouslySetInnerHTML: { __html: renderMarkdown(m.text) } } : { children: m.text })}
        />
      ))}
    </ol>
  );
}
