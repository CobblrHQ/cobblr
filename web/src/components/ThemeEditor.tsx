// Reusable "Look & feel" token editor — colors, font, corners, an
// uploaded logo + custom font. Tokens only (no raw CSS); unset = Cobblr
// default. Used by the App editor (per-app theme) AND the portal config
// (the workspace launcher's override theme). See web/src/lib/appTheme.ts
// for how the tokens become CSS variables.

import { useToast } from "@cobblr/platform-web";
import type { AppTheme } from "../lib/api";

const COLOR_FIELDS = [
  ["bg", "Background", "#f4f2ee"],
  ["surface", "Cards", "#ffffff"],
  ["text", "Text", "#334155"],
  ["muted", "Labels", "#8a94a6"],
  ["accent", "Accent", "#3b82f6"],
  ["accent_text", "On accent", "#ffffff"],
  ["border", "Borders", "#e2e8f0"],
] as const;

export function ThemeEditor({
  theme,
  onChange,
  helpText,
}: {
  theme: AppTheme | null | undefined;
  /** Merge a token patch, or `null` to clear the whole theme. */
  onChange: (patch: Partial<AppTheme> | null) => void;
  helpText?: string;
}) {
  const toast = useToast();

  // Read an uploaded logo/font as an inline data: URL (self-hosted, no
  // auth-gated file fetch). Reject oversize so the save doesn't 400 on
  // the server's length cap.
  const uploadAsset = (file: File | undefined, key: "logo" | "font_url", maxBytes: number) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      if (url.length > maxBytes) {
        toast.error(`That file is too large (${Math.round(url.length / 1024)}KB encoded; max ${Math.round(maxBytes / 1024)}KB).`);
        return;
      }
      onChange({ [key]: url });
    };
    r.readAsDataURL(file);
  };

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-faint">Look &amp; feel</span>
        {theme && (
          <button type="button" onClick={() => onChange(null)} className="text-[11px] text-faint hover:text-ember-500">
            Reset to default
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {COLOR_FIELDS.map(([key, label, def]) => (
          <label key={key} className="flex items-center gap-2 text-xs text-content dark:text-mortar-200">
            <input
              type="color"
              value={theme?.[key] ?? def}
              onChange={(e) => onChange({ [key]: e.target.value })}
              className="w-7 h-7 rounded border border-line dark:border-slate-600 bg-transparent cursor-pointer p-0"
            />
            {label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 items-end">
        <label className="text-xs text-content dark:text-mortar-200">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Font</span>
          <select
            value={theme?.font ?? "sans"}
            onChange={(e) => onChange({ font: e.target.value as AppTheme["font"] })}
            className="px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          >
            <option value="sans">Sans</option>
            <option value="serif">Serif</option>
            <option value="mono">Mono</option>
            <option value="rounded">Rounded</option>
            <option value="slab">Slab</option>
          </select>
        </label>
        <label className="text-xs text-content dark:text-mortar-200">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Corners (px)</span>
          <input
            type="number"
            min={0}
            max={36}
            value={theme?.radius ?? 12}
            onChange={(e) => onChange({ radius: Number(e.target.value) })}
            className="w-20 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
          />
        </label>
        {helpText && <p className="text-[11px] text-faint flex-1 min-w-[12rem]">{helpText}</p>}
      </div>
      {/* Logo + custom font — uploaded inline (stored as data: URLs, so
          they work standalone with no auth / no CDN). */}
      <div className="flex flex-wrap gap-6 items-start pt-1 border-t border-line dark:border-slate-800">
        <div className="flex items-center gap-3">
          {theme?.logo ? (
            <img src={theme.logo} alt="" className="w-9 h-9 rounded object-contain border border-line dark:border-slate-700" />
          ) : (
            <div className="w-9 h-9 rounded border border-dashed border-line dark:border-slate-600" />
          )}
          <div className="text-xs">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Logo</span>
            <label className="text-accent hover:underline cursor-pointer">
              upload
              <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadAsset(e.target.files?.[0], "logo", 500_000)} />
            </label>
            {theme?.logo && (
              <button type="button" onClick={() => onChange({ logo: undefined })} className="ml-2 text-faint hover:text-ember-500">clear</button>
            )}
          </div>
        </div>
        <div className="text-xs">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Custom font</span>
          <div className="flex items-center gap-2">
            <label className="text-accent hover:underline cursor-pointer">
              {theme?.font_url ? "replace" : "upload"}
              <input type="file" accept=".woff,.woff2,.ttf,.otf,font/*" className="hidden" onChange={(e) => uploadAsset(e.target.files?.[0], "font_url", 1_200_000)} />
            </label>
            {theme?.font_url && (
              <>
                <input
                  value={theme.font_name ?? ""}
                  onChange={(e) => onChange({ font_name: e.target.value })}
                  placeholder="font label"
                  className="w-28 px-2 py-0.5 text-xs border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
                />
                <button type="button" onClick={() => onChange({ font_url: undefined, font_name: undefined })} className="text-faint hover:text-ember-500">clear</button>
              </>
            )}
          </div>
          <span className="block text-[10px] text-faint mt-1">woff2/ttf/otf — overrides the keyword font above.</span>
        </div>
      </div>
    </div>
  );
}
