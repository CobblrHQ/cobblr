// Mounted once in the shell: every door opens the one spreadsheet-import
// sheet. The host is a listener and nothing else; the sheet's code loads the
// first time it opens, not with every page (#4945).
import { useEffect, useState } from "react";
import { lazyOverlay } from "@cobblr/platform-web";
import { OPEN_SHEET_IMPORT_EVENT } from "../lib/sheet-import";

const SheetImportSheet = lazyOverlay(() => import("./SheetImportSheet").then((m) => ({ default: m.SheetImportSheet })));

export function SheetImportHost() {
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setRunId((e as CustomEvent<{ runId?: string }>).detail?.runId ?? null);
      setOpen(true);
    };
    window.addEventListener(OPEN_SHEET_IMPORT_EVENT, on);
    return () => window.removeEventListener(OPEN_SHEET_IMPORT_EVENT, on);
  }, []);
  return <SheetImportSheet open={open} runId={runId} onClose={() => setOpen(false)} />;
}
