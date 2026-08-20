import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cleanPastedSecret, pastedSecretHint } from "../lib/pastedSecret";

/** One credential field, for both AI connection forms.
 *
 *  VISIBLE BY DEFAULT, even for a secret. A masked field hides the one thing worth
 *  seeing while you are entering it: a real user pasted a whole curl command in, and
 *  behind dots there was nothing to tell her that had happened, or that Cobblr had
 *  pulled the key back out of it. You can watch the trim happen instead.
 *
 *  That is a deliberate trade against shoulder-surfing, and a narrow one: this is a
 *  key being entered once, on a settings page, by the person who just copied it. The
 *  toggle is there for anyone sharing a screen, and the value is masked everywhere it
 *  is shown back later.
 *
 *  Extracted because the same field is rendered by the add form and the replace-
 *  credentials form, and the last three fixes here had to be applied twice. */
export function CredentialInput({
  fieldKey,
  label,
  secret,
  value,
  onChange,
  note,
  placeholder,
}: {
  fieldKey: string;
  label: string;
  secret: boolean;
  value: string;
  onChange: (v: string) => void;
  /** Shown greyed after the label. The personal page uses it for "set (leave blank to
   *  keep)" when editing a connection whose secret is already stored. */
  note?: string;
  placeholder?: string;
}) {
  const [hidden, setHidden] = useState(false);
  const [hint, setHint] = useState<string>("");

  return (
    <div>
      <label className="block text-sm font-medium mb-1" htmlFor={`cred-${fieldKey}`}>
        {label}
        {note && <span className="text-faint font-normal"> {note}</span>}
      </label>
      <div className="relative">
        <input
          id={`cred-${fieldKey}`}
          // A name that is not "password"/"email" so a browser has less to guess from.
          name={`cobblr-cred-${fieldKey}`}
          type={secret && hidden ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          onChange={(e) => {
            // Clean on CHANGE rather than onPaste: this catches a paste, a drag and an
            // autofill through one path, and onPaste alone misses the last two.
            const c = cleanPastedSecret(e.target.value);
            onChange(c.value);
            setHint(pastedSecretHint(c) ?? "");
          }}
          // Browsers autofill saved logins into anything resembling a sign-in form, which
          // put an email address into "Ollama base URL" once. These hints are honoured by
          // Chrome, 1Password and LastPass respectively.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          className={
            "w-full px-2 py-1.5 text-sm rounded border dark:border-slate-700 bg-surface dark:bg-slate-900 font-mono " +
            (secret ? "pr-9" : "")
          }
        />
        {secret && (
          <button
            type="button"
            onClick={() => setHidden((h) => !h)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-content dark:hover:text-slate-200 rounded"
            title={hidden ? "Show" : "Hide"}
            aria-label={hidden ? "Show the value" : "Hide the value"}
          >
            {hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
    </div>
  );
}
