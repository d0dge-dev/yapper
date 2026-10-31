import { FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { loadProjects, openDraft, useUi } from "~/yap";

// Pick the project; the thread itself is created by the first thing said or typed in it (see openDraft).
export function NewThreadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ui = useUi();
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) loadProjects().then(() => setError(""), (e) => setError((e as Error).message));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Neuer Thread</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {error && <p className="mb-2 text-destructive-foreground text-sm">{error}</p>}
          <ul className="-mx-1 max-h-[60vh] overflow-y-auto">
            {ui.projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    openDraft(p);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-start text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
