// One way to read a machine payload anywhere in the app.
//
// AI prompts, AI responses, webhook bodies and wire args were all rendered as a
// single <pre> of raw JSON: one unbroken wall of escaped quotes and \n where the
// interesting part (a system prompt, a chosen answer, an error) was buried.
// The same wall appeared in the workspace AI page AND in the operator console,
// which is why this is a component and not a fix in one modal.
//
// PRETTY (default) turns the payload into labelled sections a person can read:
// a chat `messages` array becomes its own turns, escaped newlines become real
// ones, and nested objects become key/value rows. RAW is one click away and is
// still the truth, so nobody has to trust the formatter to debug.
//
// Images: a payload that carried one shows it. The stored prompt has the bytes
// stripped (api/src/platform/ai.ts redacts image_b64/images/image so a vision
// call can't balloon the log), so what renders is whichever the payload still
// carries — a data: URI, an http(s) image URL — and otherwise an explicit
// "image sent, not stored" marker rather than the bare word "[image]".

import { useMemo, useState, type ReactNode } from "react";
import { Braces, Image as ImageIcon, Text } from "lucide-react";

const IMAGE_URL = /^(https?:\/\/[^\s"']+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s"']*)?|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)$/i;
/** What the server leaves behind when it strips image bytes from the log. */
const REDACTED_IMAGE = "[image]";

/** Parse if it is JSON; otherwise treat it as plain text. */
function parse(raw: string): { json: unknown; isJson: boolean } {
  const t = raw.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return { json: null, isJson: false };
  try {
    return { json: JSON.parse(t), isJson: true };
  } catch {
    return { json: null, isJson: false };
  }
}

/** A model's reply is often JSON *inside* a JSON string ({"text":"{\"a\":1}"}).
 *  Unwrap one level so the pretty view shows the answer, not the envelope. */
function maybeInner(v: string): unknown | null {
  const t = v.trim();
  if (t.length < 2 || (t[0] !== "{" && t[0] !== "[")) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 px-1.5 py-0.5 text-[11px] text-muted">
      {children}
    </span>
  );
}

function ImageValue({ src }: { src: string }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block mt-1">
      <img
        src={src}
        alt="Image sent with this call"
        className="max-h-56 rounded border border-line dark:border-slate-700"
      />
    </a>
  );
}

/** One value, rendered for reading rather than for parsing. */
function Value({ value }: { value: unknown }) {
  if (value === null) return <span className="text-faint">null</span>;
  if (typeof value === "boolean" || typeof value === "number")
    return <span className="font-mono text-xs">{String(value)}</span>;

  if (typeof value === "string") {
    if (value === REDACTED_IMAGE)
      return (
        <Chip>
          <ImageIcon size={11} /> image sent, not stored
        </Chip>
      );
    if (IMAGE_URL.test(value.trim())) return <ImageValue src={value.trim()} />;
    const inner = maybeInner(value);
    if (inner !== null)
      return (
        <div className="mt-1 border-l-2 border-line dark:border-slate-700 pl-2">
          <Tree value={inner} />
        </div>
      );
    // Escaped newlines are the main reason these blobs are unreadable.
    return (
      <span className="whitespace-pre-wrap break-words text-content dark:text-mortar-200">
        {value}
      </span>
    );
  }

  return <Tree value={value} />;
}

/** A chat `messages` array is the single most common shape here, and the one
 *  worst served by raw JSON. Render the turns. */
function Messages({ turns }: { turns: Array<Record<string, unknown>> }) {
  return (
    <div className="space-y-2">
      {turns.map((m, i) => (
        <div key={i} className="rounded border border-line dark:border-slate-700 overflow-hidden">
          <div className="px-2 py-1 bg-subtle dark:bg-slate-800 text-[10px] font-mono uppercase tracking-widest text-accent">
            {String(m.role ?? "message")}
          </div>
          <div className="px-2 py-1.5 text-xs">
            <Value value={m.content} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Tree({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const turns = value.filter(
      (v): v is Record<string, unknown> =>
        !!v && typeof v === "object" && "role" in (v as object),
    );
    if (turns.length === value.length && turns.length > 0) return <Messages turns={turns} />;
    return (
      <ol className="space-y-1.5">
        {value.map((v, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-[10px] font-mono text-faint pt-0.5 shrink-0">{i}</span>
            <div className="min-w-0 flex-1">
              <Value value={v} />
            </div>
          </li>
        ))}
      </ol>
    );
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-faint">(empty)</span>;
    return (
      <dl className="space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-0.5 items-start">
            <dt className="text-[11px] font-mono text-accent pt-0.5 break-words">{k}</dt>
            <dd className="min-w-0 text-xs">
              <Value value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <Value value={value} />;
}

export function PayloadView({
  raw,
  label,
  emptyText = "(none)",
}: {
  raw: string | null | undefined;
  /** Section heading, e.g. "Prompt". */
  label?: string;
  emptyText?: string;
}) {
  const [pretty, setPretty] = useState(true);
  const parsed = useMemo(() => parse(raw ?? ""), [raw]);

  const body = !raw ? (
    <p className="text-xs text-faint">{emptyText}</p>
  ) : pretty && parsed.isJson ? (
    <div className="text-xs bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-80 overflow-auto">
      <Tree value={parsed.json} />
    </div>
  ) : (
    <pre className="text-xs whitespace-pre-wrap break-words bg-subtle dark:bg-slate-800 border border-line dark:border-slate-700 rounded p-3 max-h-80 overflow-auto text-content dark:text-mortar-200">
      {raw}
    </pre>
  );

  const btn = (on: boolean) =>
    "inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition " +
    (on
      ? "bg-accent/10 text-accent font-medium"
      : "text-muted hover:text-content dark:hover:text-mortar-100");

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        {label && (
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent">{label}</div>
        )}
        {/* Only offer the toggle when there are two ways to see it. Plain text
            has no pretty form, and pretending otherwise is a dead control. */}
        {parsed.isJson && (
          <div className="ml-auto flex items-center gap-0.5">
            <button type="button" onClick={() => setPretty(true)} className={btn(pretty)}>
              <Text size={11} /> Pretty
            </button>
            <button type="button" onClick={() => setPretty(false)} className={btn(!pretty)}>
              <Braces size={11} /> Raw
            </button>
          </div>
        )}
      </div>
      {body}
    </div>
  );
}

/** The one-line "what did this cost" summary.
 *
 *  It used to read "0/0 tokens" whenever a provider reported no usage, which
 *  looks like a measured zero rather than "nobody told us". Local bridges are
 *  the common case there: the Ollama-shaped path reads prompt_eval_count /
 *  eval_count, and a bridge that shells out to another CLI sends neither.
 *  One number is enough for the header; the in/out split rides along in the
 *  title, since the split only matters when you are pricing a call. */
export function usageLine(x: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_cents?: number | null;
  cached?: boolean;
}): { text: string; title?: string } {
  const i = x.input_tokens ?? 0;
  const o = x.output_tokens ?? 0;
  const total = i + o;
  const bits: string[] = [];
  let title: string | undefined;
  if (total > 0) {
    bits.push(`${total.toLocaleString()} tokens`);
    title = `${i.toLocaleString()} in · ${o.toLocaleString()} out`;
  } else {
    bits.push("tokens not reported");
    title = "This provider did not return a usage count.";
  }
  if (x.cost_cents != null) bits.push(`$${(x.cost_cents / 100).toFixed(2)}`);
  if (x.cached) bits.push("cached");
  return { text: bits.join(" · "), title };
}
