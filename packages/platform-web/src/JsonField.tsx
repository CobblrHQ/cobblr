// JsonField — the ONE primitive for pasting/editing a structured JSON value.
//
// Design rule (docs/design-decisions/json-config-inputs.md): any feature that
// accepts a freeform/nested JSON value — connector credentials/config, view
// configs, app/bundle schemas, channel configs, driver manifests — uses this,
// never a raw <textarea> + hand-rolled JSON.parse. Flat known config keeps
// per-field inputs; JsonField is the "paste JSON" affordance, optionally
// validated against a JSON Schema the feature supplies.

import { useEffect, useId, useState } from "react";
import Ajv from "ajv";

// One shared, lenient compiler. strict:false so a feature's schema can carry
// extra keywords without throwing; allErrors so we can list every violation.
const ajv = new Ajv({ allErrors: true, strict: false });

export interface JsonEval {
  /** Parsed value when valid (undefined when empty or invalid). */
  value: unknown;
  valid: boolean;
  errors: string[];
}

/** Pure parse + optional JSON-Schema validation — the testable core of
 *  JsonField, reusable anywhere you need to validate a JSON string. */
export function evaluateJson(
  text: string,
  opts: { schema?: object; required?: boolean } = {},
): JsonEval {
  const t = text.trim();
  if (t === "") {
    return { value: undefined, valid: !opts.required, errors: opts.required ? ["Required."] : [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch (e) {
    return { value: undefined, valid: false, errors: [`Invalid JSON — ${(e as Error).message}`] };
  }
  if (opts.schema) {
    let validate;
    try {
      validate = ajv.compile(opts.schema);
    } catch {
      validate = null; // a malformed schema shouldn't block the input
    }
    if (validate && !validate(parsed)) {
      const errors = (validate.errors ?? [])
        .map((er) => `${er.instancePath || "(root)"} ${er.message ?? "is invalid"}`)
        .slice(0, 6);
      return { value: undefined, valid: false, errors };
    }
  }
  return { value: parsed, valid: true, errors: [] };
}

export interface JsonFieldProps {
  label?: string;
  /** Current parsed value (object / array / primitive). */
  value: unknown;
  /** Fires on every edit. `value` is the parsed JSON when valid, else undefined. */
  onChange: (value: unknown, meta: { valid: boolean; errors: string[] }) => void;
  /** Optional JSON Schema to validate the parsed value against. */
  schema?: object;
  placeholder?: string;
  rows?: number;
  /** Shown under the field when there are no errors. */
  hint?: string;
  /** Treat empty as invalid. */
  required?: boolean;
  className?: string;
}

export function JsonField({
  label,
  value,
  onChange,
  schema,
  placeholder,
  rows = 8,
  hint,
  required,
  className,
}: JsonFieldProps) {
  const id = useId();
  const [text, setText] = useState(() => serialize(value));
  const [errors, setErrors] = useState<string[]>(() => evaluateJson(serialize(value), { schema, required }).errors);
  const [copied, setCopied] = useState(false);

  // Re-seed when the parent pushes a genuinely different value (reset / connector
  // switch), without clobbering an in-progress edit that parses to the same thing.
  useEffect(() => {
    const incoming = serialize(value);
    setText((cur) => (sameJson(cur, incoming) ? cur : incoming));
    setErrors(evaluateJson(incoming, { schema, required }).errors);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, schema]);

  const emit = (next: string) => {
    setText(next);
    const r = evaluateJson(next, { schema, required });
    setErrors(r.errors);
    onChange(r.value, { valid: r.valid, errors: r.errors });
  };

  const format = () => {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      setText(pretty);
      setErrors(evaluateJson(pretty, { schema, required }).errors);
    } catch {
      /* unparseable — the inline error already says so */
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        {label ? (
          <label htmlFor={id} className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
            {label}
          </label>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={copy} className="text-[10px] text-accent hover:underline">
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={format} className="text-[10px] text-accent hover:underline">
            Format
          </button>
        </div>
      </div>
      <textarea
        id={id}
        value={text}
        onChange={(e) => emit(e.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        className={
          "input font-mono text-xs " +
          (errors.length ? "border-ember-500 focus:border-ember-500 dark:border-ember-500" : "")
        }
      />
      {errors.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[11px] text-ember-600 dark:text-ember-400">
          {errors.map((e, i) => (
            <li key={i} className="font-mono break-words">
              {e}
            </li>
          ))}
        </ul>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-muted dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

function serialize(v: unknown): string {
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return "";
  }
}

function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a || "null")) === JSON.stringify(JSON.parse(b || "null"));
  } catch {
    return a === b;
  }
}
