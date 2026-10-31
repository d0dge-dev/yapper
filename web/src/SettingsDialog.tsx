import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import { type Settings, applySettings, settings } from "~/yap";

const LANGS = { de: "Deutsch", en: "English" };
const WHILE_RUNNING = { steer: "Lenken (steer)", queue: "Hinten anstellen (queue)" };

// Values are loaded when the dialog opens and committed (saved + sent to an active call) when it closes, as before.
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft({ ...settings });
        else applySettings(draft);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Einstellungen</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <Field label="Sprache für Ansagen">
            <Select items={LANGS} value={draft.lang} onValueChange={(v) => v && set("lang", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(LANGS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Wenn der Agent arbeitet">
            <Select items={WHILE_RUNNING} value={draft.whileRunning} onValueChange={(v) => v && set("whileRunning", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(WHILE_RUNNING).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Pause bis Senden" value={`${(draft.sendAfterMs / 1000).toFixed(1)} s`}>
            <Slider min={700} max={4000} step={100} value={draft.sendAfterMs} onValueChange={(v) => set("sendAfterMs", v as number)} />
          </Field>
          <Field label="Statusansage nach Stille" value={`${Math.round(draft.progressAfterMs / 1000)} s`}>
            <Slider min={10000} max={90000} step={5000} value={draft.progressAfterMs} onValueChange={(v) => set("progressAfterMs", v as number)} />
          </Field>
          <Label className="flex items-center justify-between gap-4 font-normal">
            Agent auf kurze, gesprochene Antworten hinweisen
            <Switch checked={draft.voiceHint} onCheckedChange={(v) => set("voiceHint", v)} />
          </Label>
          <Label className="flex items-center justify-between gap-4 font-normal">
            Gedanken des Agents kurz erwähnen (meist Englisch)
            <Switch checked={draft.speakThoughts} onCheckedChange={(v) => set("speakThoughts", v)} />
          </Label>
          <Label className="flex items-center justify-between gap-4 font-normal">
            Echo-Unterdrückung (Mikrofon)
            <Switch checked={draft.echoCancellation} onCheckedChange={(v) => set("echoCancellation", v)} />
          </Label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>Fertig</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        {value && <span className="text-muted-foreground tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  );
}
