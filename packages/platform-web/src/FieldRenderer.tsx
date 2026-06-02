// FieldRenderer — renders an arbitrary field value using one of a
// fixed set of built-in renderers, selected by the consumer (a
// catalog schema, a custom field def, an entity-kind presentation
// override). Lives in platform-web so module UIs (inventory, etc.)
// + the host app share one implementation.
//
// Why a fixed set: bundles intentionally don't ship rendering code
// (sandboxing, security, contract clarity). The platform owns the
// renderer library; bundles + catalogs + field defs do the
// declarative mapping of `field → renderer id`. To add a new
// renderer, edit this file (one switch arm) + the FieldRendererId
// union in ./types.ts + the zod enum on the server side
// (modules/core-catalogs + api/src/routes/platform.ts + the
// platform-contract manifest schema) — same renderer id everywhere.

import { useState } from "react";
import { Check, ExternalLink, ImageOff, X } from "lucide-react";
import type { FieldRendererId } from "./types";

interface Props {
  fieldName: string;
  value: unknown;
  /** Optional renderer override. Unknown ids fall through to "text". */
  renderer?: FieldRendererId | null;
  /** Inline (single-line summary) vs block (large preview). The
   *  catalog list uses inline; the detail page can use block for
   *  the hero image / color swatch. */
  size?: "inline" | "block";
}

export function FieldRenderer({
  fieldName,
  value,
  renderer,
  size = "inline",
}: Props) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-faint dark:text-slate-600">—</span>;
  }
  const r = renderer ?? "text";

  switch (r) {
    case "color-hex":
      return <ColorSwatch value={value} size={size} />;
    case "image-url":
      return <ImageThumb value={value} alt={fieldName} size={size} />;
    case "url-link":
      return <UrlLink value={value} />;
    case "year":
      return (
        <span className="font-mono tabular-nums">
          {String(parseInt(String(value), 10) || value)}
        </span>
      );
    case "boolean":
      return <BooleanTick value={value} />;
    case "code":
      return (
        <code className="font-mono text-[11px] bg-mortar-100 dark:bg-slate-800 rounded px-1.5 py-0.5">
          {String(value)}
        </code>
      );
    case "text":
    default:
      return <span>{String(value)}</span>;
  }
}

function ColorSwatch({ value, size }: { value: unknown; size: "inline" | "block" }) {
  // Accept hex with or without leading #, RGB tuples, etc. The
  // Rebrickable colors dump is uppercase 6-digit hex without #.
  const raw = String(value).trim().replace(/^#/, "");
  const isHex = /^[0-9a-fA-F]{6}$/.test(raw) || /^[0-9a-fA-F]{3}$/.test(raw);
  if (!isHex) return <span>{String(value)}</span>;
  const css = `#${raw}`;
  if (size === "block") {
    // Stack swatch over hex code so it fills the card's image slot
    // the same way a thumbnail would (~ 128×128 grid cell).
    return (
      <div className="flex flex-col items-center gap-1">
        <span
          className="block w-28 h-24 rounded-md border border-line dark:border-slate-700"
          style={{ background: css }}
          aria-label={`Color ${css}`}
        />
        <code className="font-mono text-[10px] text-muted dark:text-slate-400">
          {css.toUpperCase()}
        </code>
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-4 h-4 rounded-sm border border-line dark:border-slate-700"
        style={{ background: css }}
        aria-label={`Color ${css}`}
      />
      <code className="font-mono text-[11px]">{css.toUpperCase()}</code>
    </span>
  );
}

function ImageThumb({
  value,
  alt,
  size,
}: {
  value: unknown;
  alt: string;
  size: "inline" | "block";
}) {
  const [failed, setFailed] = useState(false);
  const dim = size === "block" ? "w-32 h-32" : "w-8 h-8";
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    return <NoImage size={size} />;
  }
  if (failed) {
    return <NoImage size={size} title="image failed to load" />;
  }
  return (
    <img
      src={value}
      alt={alt}
      className={`${dim} rounded object-cover border border-line dark:border-slate-700 inline-block bg-subtle dark:bg-slate-800`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/** Used by ImageThumb and by the catalog card directly when an
 *  entry has no image to show. Keeps the visual rhythm of the
 *  list — every card has a slot in the same place, populated or
 *  not. */
export function NoImage({
  size,
  title,
}: {
  size: "inline" | "block";
  title?: string;
}) {
  const dim = size === "block" ? "w-32 h-32" : "w-8 h-8";
  return (
    <div
      className={`${dim} rounded border border-dashed border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center text-faint dark:text-slate-600 shrink-0`}
      title={title ?? "No image"}
      aria-label={title ?? "No image"}
    >
      <ImageOff size={size === "block" ? 32 : 14} />
    </div>
  );
}

function UrlLink({ value }: { value: unknown }) {
  const raw = String(value);
  if (!/^https?:\/\//i.test(raw)) return <span>{raw}</span>;
  return (
    <a
      href={raw}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:text-accent inline-flex items-center gap-1 text-xs"
    >
      {raw.length > 40 ? raw.slice(0, 38) + "…" : raw}
      <ExternalLink size={11} />
    </a>
  );
}

function BooleanTick({ value }: { value: unknown }) {
  const truthy =
    value === true ||
    value === 1 ||
    (typeof value === "string" && /^(true|yes|y|1)$/i.test(value));
  return truthy ? (
    <span className="inline-flex items-center gap-1 text-moss-600">
      <Check size={13} /> yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-faint">
      <X size={13} /> no
    </span>
  );
}
