import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { type ModelCatalog, type ModelOption, type ThreadConfig, loadModels, setThreadConfig, useUi } from "~/yap";

const RUNTIME_LABELS: Record<string, string> = {
  "approval-required": "Fragt vor Änderungen",
  "auto-accept-edits": "Edits automatisch",
  auto: "Auto",
  "full-access": "Voller Zugriff",
};

const key = (instanceId: string, slug: string) => `${instanceId}::${slug}`;

function findModel(catalog: ModelCatalog, config: ThreadConfig) {
  const provider = catalog.providers.find((p) => p.instanceId === config.modelSelection.instanceId);
  return { provider, model: provider?.models.find((m) => m.slug === config.modelSelection.model) };
}

function defaultValue(o: ModelOption): string | boolean | undefined {
  if (o.type === "boolean") return typeof o.currentValue === "boolean" ? o.currentValue : false;
  return o.options?.find((x) => x.isDefault)?.id ?? o.options?.[0]?.id;
}

/** The value an option has in `config`, else the model's default for it. */
function optionValue(config: ThreadConfig, o: ModelOption) {
  return config.modelSelection.options?.find((x) => x.id === o.id)?.value ?? defaultValue(o);
}

/** Short summary for the header chip, e.g. "Opus 5.5 · High". */
export function configLabel(config: ThreadConfig | null | undefined, catalog: ModelCatalog | null): string {
  if (!config) return "Modell";
  const { model } = catalog ? findModel(catalog, config) : { model: undefined };
  const name = (model?.name ?? config.modelSelection.model).replace(/^Claude /, "");
  const effort = model?.options.find((o) => o.id === "effort");
  const value = effort ? optionValue(config, effort) : undefined;
  const effortLabel = effort?.options?.find((x) => x.id === value)?.label;
  return [name, effortLabel, config.interactionMode === "plan" ? "Plan" : null].filter(Boolean).join(" · ");
}

export function ThreadConfigDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ui = useUi();
  const catalog = ui.models;
  const initial = ui.current?.config ?? catalog?.defaults ?? null;
  const [draft, setDraft] = useState<ThreadConfig | null>(initial);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(ui.current?.config ?? ui.models?.defaults ?? null);
    loadModels().catch((e) => setError((e as Error).message));
  }, [open]);
  useEffect(() => {
    if (open && !draft && catalog) setDraft(ui.current?.config ?? catalog.defaults);
  }, [catalog]);

  const close = (next: boolean) => {
    if (!next && draft && JSON.stringify(draft) !== JSON.stringify(ui.current?.config ?? null)) setThreadConfig(draft);
    onOpenChange(next);
  };

  const { model } = catalog && draft ? findModel(catalog, draft) : { model: undefined };
  // ACP-registry providers duplicate the native Claude models; show them only when the thread already uses one.
  const providers = (catalog?.providers ?? []).filter((p) => !p.instanceId.startsWith("acpRegistry") || p.instanceId === draft?.modelSelection.instanceId);
  const multiProvider = providers.length > 1;
  const modelItems: Record<string, string> = {};
  for (const p of providers)
    for (const m of p.models)
      if (!m.legacy || (draft && key(p.instanceId, m.slug) === key(draft.modelSelection.instanceId, draft.modelSelection.model)))
        modelItems[key(p.instanceId, m.slug)] = multiProvider ? `${m.name} (${p.displayName})` : m.name;

  const pickModel = (k: string) => {
    if (!catalog || !draft) return;
    const [instanceId, slug] = k.split("::");
    const next = catalog.providers.find((p) => p.instanceId === instanceId)?.models.find((m) => m.slug === slug);
    if (!next) return;
    // Keep option values the new model also accepts, so switching Opus → Sonnet keeps "High".
    const options = next.options
      .map((o) => {
        const kept = draft.modelSelection.options?.find((x) => x.id === o.id)?.value;
        const valid = o.type === "boolean" ? typeof kept === "boolean" : o.options?.some((x) => x.id === kept);
        return { id: o.id, value: (valid ? kept : defaultValue(o)) as string | boolean };
      })
      .filter((o) => o.value !== undefined);
    setDraft({ ...draft, modelSelection: { instanceId, model: slug, options } });
  };

  const setOption = (id: string, value: string | boolean) => {
    if (!draft) return;
    const rest = (draft.modelSelection.options ?? []).filter((o) => o.id !== id);
    setDraft({ ...draft, modelSelection: { ...draft.modelSelection, options: [...rest, { id, value }] } });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ui.current?.draft ? "Neuer Thread: Modell" : "Modell & Modus"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {error && <p className="text-destructive-foreground text-sm">{error}</p>}
          {!draft || !catalog ? (
            <p className="text-muted-foreground text-sm">Lädt…</p>
          ) : (
            <>
              <Field label="Modell">
                <SelectField
                  items={modelItems}
                  value={key(draft.modelSelection.instanceId, draft.modelSelection.model)}
                  onChange={pickModel}
                />
              </Field>
              {model?.options.map((o) =>
                o.type === "boolean" ? (
                  <Label key={o.id} className="flex items-center justify-between gap-4 font-normal">
                    {o.label}
                    <Switch checked={optionValue(draft, o) === true} onCheckedChange={(v) => setOption(o.id, v)} />
                  </Label>
                ) : o.options?.length ? (
                  <Field key={o.id} label={o.label}>
                    <SelectField
                      items={Object.fromEntries(o.options.map((x) => [x.id, x.label]))}
                      value={String(optionValue(draft, o) ?? "")}
                      onChange={(v) => setOption(o.id, v)}
                    />
                  </Field>
                ) : null,
              )}
              <Field label="Berechtigungen">
                <SelectField
                  items={Object.fromEntries(catalog.runtimeModes.map((m) => [m, RUNTIME_LABELS[m] ?? m]))}
                  value={draft.runtimeMode}
                  onChange={(v) => setDraft({ ...draft, runtimeMode: v })}
                />
              </Field>
              <Label className="flex items-center justify-between gap-4 font-normal">
                Plan-Modus (erst planen, dann umsetzen)
                <Switch
                  checked={draft.interactionMode === "plan"}
                  onCheckedChange={(v) => setDraft({ ...draft, interactionMode: v ? "plan" : "default" })}
                />
              </Label>
              {!ui.current?.draft && <p className="text-muted-foreground text-xs">Gilt ab der nächsten Antwort des Agents.</p>}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button />}>Fertig</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SelectField({ items, value, onChange }: { items: Record<string, string>; value: string; onChange: (v: string) => void }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v && onChange(v as string)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {Object.entries(items).map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium text-sm">{label}</span>
      {children}
    </div>
  );
}
