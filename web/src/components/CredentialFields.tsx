import { useId, type ReactNode } from "react";
import { CredentialInput } from "./CredentialInput";
import { useCredentialCheck, type CredentialScope } from "./useCredentialCheck";
import { groupModels, displayModel } from "../lib/modelGroups";

export interface CredentialFieldDef {
  label: string;
  secret?: boolean;
  choices?: { value: string; label: string }[];
}

/** Every credential field for one provider, checked as you type.
 *
 *  WHY ONE COMPONENT: there are three of these forms (add a workspace provider, replace
 *  a workspace provider's credentials, add a personal connection). Each capability that
 *  shipped as a copy-paste — the paste recovery, the visible-while-typing key — landed
 *  on some of them and was missed on the rest, every time, and /me/connections is the
 *  one that got missed. One implementation is the only version of that fix that holds. */
export function CredentialFields({
  fields,
  creds,
  onChange,
  scope,
  providerId,
  selectClassName = "w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900",
  hintFor,
  noteFor,
  placeholderFor,
}: {
  fields: Record<string, CredentialFieldDef>;
  creds: Record<string, string>;
  onChange: (key: string, value: string) => void;
  scope: CredentialScope;
  providerId: string;
  selectClassName?: string;
  /** e.g. the bridge-transit hint, which differs between workspace and personal. */
  hintFor?: (key: string, value: string) => ReactNode;
  noteFor?: (key: string, def: CredentialFieldDef) => string | undefined;
  placeholderFor?: (key: string, def: CredentialFieldDef) => string | undefined;
}) {
  const { check, run, reset } = useCredentialCheck(scope, providerId);
  // A bare <label> next to a <select> is not attached to it: clicking it focuses
  // nothing and a screen reader announces an unlabelled control.
  const uid = useId();

  return (
    <>
      {Object.entries(fields).map(([key, d]) => (
        <div key={key}>
          {d.choices ? (
            <>
              <label htmlFor={`${uid}-${key}`} className="block text-sm font-medium mb-1">
                {d.label}
              </label>
              <select
                id={`${uid}-${key}`}
                value={creds[key] ?? ""}
                onChange={(e) => onChange(key, e.target.value)}
                className={selectClassName}
              >
                {d.choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {hintFor?.(key, creds[key] ?? "")}
            </>
          ) : key === "model" && check.models.length > 0 ? (
            // Typing an exact model id is a thing nobody can do from memory, and the
            // check already fetched the list. Blank stays available because the
            // preset's default is the right answer for most people.
            <>
              <label htmlFor={`${uid}-${key}`} className="block text-sm font-medium mb-1">
                {d.label}
              </label>
              <select
                id={`${uid}-${key}`}
                value={creds[key] ?? ""}
                onChange={(e) => onChange(key, e.target.value)}
                className={selectClassName}
              >
                <option value="">Use the default</option>
                {(() => {
                  const { suggested, others } = groupModels(check.models);
                  const opts = (ids: string[]) =>
                    ids.map((m) => (
                      <option key={m} value={m}>
                        {displayModel(m)}
                      </option>
                    ));
                  // Both groups render. `others` means "we could not tell what this
                  // is", never "not for you" - see modelGroups.
                  return others.length === 0 ? (
                    opts(suggested)
                  ) : (
                    <>
                      <optgroup label="Chat models">{opts(suggested)}</optgroup>
                      <optgroup label="Everything else this key can reach">{opts(others)}</optgroup>
                    </>
                  );
                })()}
              </select>
            </>
          ) : (
            <CredentialInput
              fieldKey={key}
              label={d.label}
              secret={!!d.secret}
              value={creds[key] ?? ""}
              note={noteFor?.(key, d)}
              placeholder={placeholderFor?.(key, d)}
              onChange={(v) => {
                onChange(key, v);
                // The model is not a credential: changing it cannot change whether the
                // key works, so re-testing on it would just be noise.
                if (key === "model") return;
                const next = { ...creds, [key]: v };
                // A blank secret is not a wrong secret. "Replace credentials" lets you
                // leave the key blank to keep the stored one, so editing the base URL
                // there leaves the form holding no key: testing it would report a
                // confident failure about a connection that works fine.
                const haveEverySecret = Object.entries(fields)
                  .filter(([, def]) => def.secret)
                  .every(([k]) => (next[k] ?? "").trim() !== "");
                // Clear, not just skip: a verdict and a model list from the key you
                // just deleted are about a key that is no longer in the form.
                if (!haveEverySecret) {
                  reset();
                  return;
                }
                const { model: _m, ...secrets } = next;
                run(secrets);
              }}
            />
          )}
        </div>
      ))}
      {/* One verdict for the whole form: the check covers every credential together,
          so printing it under each field would repeat the same sentence. */}
      {check.state !== "idle" && (
        <p
          className={
            "text-xs " +
            (check.state === "ok"
              ? "text-moss-600 dark:text-moss-400"
              : check.state === "bad"
                ? "text-ember-600 dark:text-ember-400"
                : "text-muted")
          }
        >
          {check.state === "ok" ? "✓ " : check.state === "bad" ? "✗ " : ""}
          {check.message}
        </p>
      )}
    </>
  );
}
