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
import { Markdown, stripMarkdown } from "./Markdown";
import { QrCode } from "./QrCode";
import { useUnits } from "./useUnits";

interface Props {
  fieldName: string;
  value: unknown;
  /** Optional renderer override. Unknown ids fall through to "text". */
  renderer?: FieldRendererId | null;
  /** The field's storage type. A `boolean` field with no explicit renderer
   *  displays via the boolean renderer (a labelled yes/no), not the raw
   *  "true"/"false" the text default would show. */
  type?: string | null;
  /** For a boolean field, custom state labels as `[falseLabel, trueLabel]`
   *  (the same `choices` array the field-def carries) — so "Needs drying" can
   *  read "Yes/No", "Dry/Wet", or whatever the author/user set. Defaults no/yes. */
  choices?: string[] | null;
  /** The field def's declared unit ("mm", "g") — a number value renders as a
   *  quantity ("12 mm") per the workspace's symbol/name display preference.
   *  Free text; a string the vocabulary doesn't know renders as typed. Callers
   *  passing this must be inside PlatformWebProvider (all field-def surfaces
   *  are). */
  unit?: string | null;
  /** Inline (single-line summary) vs block (large preview). The
   *  catalog list uses inline; the detail page can use block for
   *  the hero image / color swatch. */
  size?: "inline" | "block";
}

/** Whether a boolean field's stored value reads as TRUE. Beyond real booleans
 *  and "true"-ish strings, the field's own trueLabel (choices[1]) counts: a
 *  choice dropdown once wrote label strings into boolean keys, and reading
 *  those as false would show the OPPOSITE label. Recognizing the label heals
 *  that data at read time; the next toggle stores a real boolean. */
export function boolTruthy(value: unknown, choices?: string[] | null): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  if (/^(true|yes|y|1)$/i.test(value)) return true;
  const trueLabel = choices?.[1]?.trim();
  return !!trueLabel && value.trim() === trueLabel;
}

/** A boolean field's display labels, from its `choices` ([falseLabel,
 *  trueLabel]); falls back to no/yes. Exported so non-renderer surfaces (a
 *  template, an export) can express a boolean the same way. */
export function boolLabel(value: unknown, choices?: string[] | null): string {
  const t = choices?.[1]?.trim() || "Yes";
  const f = choices?.[0]?.trim() || "No";
  return boolTruthy(value, choices) ? t : f;
}

export function FieldRenderer({
  fieldName,
  value,
  renderer,
  type,
  choices,
  unit,
  size = "inline",
}: Props) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-faint dark:text-slate-600">—</span>;
  }
  // A number with a declared unit renders as a quantity ("12 mm"). Its own
  // component so the units hook mounts only when a consumer passed a unit.
  if (unit && Number.isFinite(Number(value))) {
    return <NumberWithUnit value={Number(value)} unit={unit} />;
  }
  // A boolean field renders as a labelled yes/no even without an explicit
  // renderer — the text default would show the raw "true"/"false". A richtext
  // field always renders as Markdown, even if no renderer was stamped.
  const r =
    renderer ?? (type === "boolean" ? "boolean" : type === "richtext" ? "markdown" : "text");

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
      return <BooleanTick value={value} choices={choices} />;
    case "code":
      return (
        <code className="font-mono text-[11px] bg-mortar-100 dark:bg-slate-800 rounded px-1.5 py-0.5">
          {String(value)}
        </code>
      );
    case "markdown":
      // Block context (detail hero) → full Markdown; inline (table/list cell) →
      // a one-line plain-text digest, since a rendered block wrecks a row.
      return size === "block" ? (
        <Markdown>{String(value)}</Markdown>
      ) : (
        <span className="line-clamp-1">{stripMarkdown(String(value))}</span>
      );
    case "qr":
      // A scannable QR of the value — larger in block context, thumbnail inline.
      return <QrCode value={String(value)} size={size === "block" ? 128 : 44} />;
    case "text":
    default:
      return <span>{String(value)}</span>;
  }
}

function NumberWithUnit({ value, unit }: { value: number; unit: string }) {
  const units = useUnits();
  return <span className="tabular-nums">{units.format(value, unit)}</span>;
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

function BooleanTick({ value, choices }: { value: unknown; choices?: string[] | null }) {
  const truthy =
    value === true ||
    value === 1 ||
    (typeof value === "string" && /^(true|yes|y|1)$/i.test(value));
  const label = boolLabel(value, choices);
  return truthy ? (
    <span className="inline-flex items-center gap-1 text-moss-600">
      <Check size={13} /> {label}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-faint">
      <X size={13} /> {label}
    </span>
  );
}
