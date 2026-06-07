// Detail modal for non-bundle marketplace items — drivers, sandboxed
// modules, and file-preview renderers. These cards used to only have an
// Install button with no way to read what they are; this gives them the
// same "open for details" affordance bundles have (description + details +
// install), even when there's nothing extra to configure.

import type {
  RegistryDriverEntry,
  RegistryModuleEntry,
  RegistryRendererEntry,
} from "../lib/api";
import { Modal } from "@cobblr/platform-web";

export type RegistryItem =
  | { kind: "driver"; entry: RegistryDriverEntry }
  | { kind: "module"; entry: RegistryModuleEntry }
  | { kind: "renderer"; entry: RegistryRendererEntry };

interface Props {
  open: boolean;
  onClose: () => void;
  item: RegistryItem | null;
  installed?: boolean;
  /** False → render the install button disabled (e.g. modules need super-admin). */
  canInstall?: boolean;
  /** Shown in place of the install button when canInstall is false. */
  cannotInstallNote?: string;
  busy?: boolean;
  onInstall?: () => void;
}

const KIND_LABEL: Record<RegistryItem["kind"], string> = {
  driver: "Machine driver",
  module: "Sandboxed module",
  renderer: "File-preview renderer",
};
const DEFAULT_GLYPH: Record<RegistryItem["kind"], string> = {
  driver: "🔌",
  module: "🧩",
  renderer: "🖼️",
};

export function RegistryItemModal({
  open,
  onClose,
  item,
  installed,
  canInstall = true,
  cannotInstallNote,
  busy,
  onInstall,
}: Props) {
  if (!item || !open) return null;
  const { kind, entry } = item;

  const glyph = ("glyph" in entry && entry.glyph) || DEFAULT_GLYPH[kind];
  const name = entry.name;
  const trust = "trust" in entry ? entry.trust : undefined;
  const description = "description" in entry ? entry.description : undefined;
  const blurb = "blurb" in entry ? entry.blurb : undefined;
  const caveat = "caveat" in entry ? entry.caveat : undefined;
  const body = description || blurb;

  // Per-kind detail rows.
  const details: Array<{ label: string; value: string }> = [
    { label: "Type", value: KIND_LABEL[kind] },
  ];
  if (kind === "driver") details.push({ label: "Id", value: entry.id });
  if ("version" in entry && entry.version) details.push({ label: "Version", value: entry.version });
  if (kind === "renderer") details.push({ label: "File types", value: entry.exts.map((e) => `.${e}`).join(" ") });
  if ("source" in entry && entry.source) details.push({ label: "Source", value: entry.source });

  const subtitle = kind === "driver" ? entry.id : KIND_LABEL[kind];

  return (
    <Modal open={open} onClose={onClose} title={`${glyph} ${name}`} subtitle={subtitle} size="md">
      <div className="space-y-5">
        {trust && (
          <div>
            {trust === "official" ? (
              <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600 bg-moss-50 dark:bg-moss-950/30 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
                verified — signed by a Cobblr-vouched key
              </span>
            ) : (
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5">
                unverified — Cobblr hasn't reviewed this
              </span>
            )}
          </div>
        )}

        {body && <p className="text-sm text-content dark:text-mortar-200">{body}</p>}

        {caveat && (
          <p className="text-xs text-faint dark:text-slate-400 italic border-l-2 border-amber-300 dark:border-amber-700 pl-3">
            ⚠ {caveat}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-2 text-xs">
          {details.map((d) => (
            <div key={d.label}>
              <dt className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-0.5">
                {d.label}
              </dt>
              <dd className="text-content dark:text-mortar-100 font-mono break-all">{d.value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex items-center justify-between pt-3 border-t border-line dark:border-slate-700">
          {installed ? (
            <span className="text-[10px] font-mono uppercase tracking-widest text-moss-600">installed</span>
          ) : canInstall ? (
            <button
              type="button"
              onClick={onInstall}
              disabled={busy}
              className="text-xs font-medium px-3 py-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Installing…" : "Install"}
            </button>
          ) : (
            <span className="text-[10px] font-mono uppercase tracking-widest text-faint">
              {cannotInstallNote ?? "not installable here"}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
