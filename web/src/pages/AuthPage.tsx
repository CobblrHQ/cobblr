// Combined signup / login screen. Toggle at the bottom flips mode —
// keeps the splash → auth → dashboard journey one screen.

import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { CobblestoneMark } from "../CobblestoneMark";
import { ApiError } from "../lib/api";

type Mode = "login" | "signup";

export function AuthPage() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgName, setOrgName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Defensive: strip any whitespace from the email (autofill /
    // copy-paste can sneak in tabs or trailing newlines that .trim()
    // alone won't catch if they're between chars). Trim the password
    // too — passwords *could* contain internal whitespace, but
    // leading/trailing whitespace is always a paste accident.
    const cleanEmail = email.replace(/\s+/g, "");
    const cleanPassword = password.trim();
    try {
      if (mode === "login") {
        await login(cleanEmail, cleanPassword);
      } else {
        await signup({
          email: cleanEmail,
          password: cleanPassword,
          display_name: displayName.trim(),
          org_name: orgName.trim(),
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 mb-6 text-center">
          <CobblestoneMark size={64} />
          <div>
            <h1 className="font-display text-3xl font-extrabold text-slate-700 dark:text-mortar-100 lowercase tracking-tight">
              cobblr
            </h1>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">Cobble together what works.</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="bg-white dark:bg-slate-900/70 backdrop-blur border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm space-y-3"
        >
          <div className="text-[10px] font-mono uppercase tracking-widest text-cobble-500 mb-1">
            // {mode === "login" ? "sign in" : "create account"}
          </div>

          {mode === "signup" && (
            <>
              <Field label="Your name">
                <input
                  required
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Workspace name">
                <input
                  required
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. my workshop"
                  className="input"
                />
              </Field>
            </>
          )}

          <Field label="Email">
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              // Strip whitespace whenever the field value changes,
              // however it changed:
              //   onChange — keyboard input + paste
              //   onInput  — programmatic value writes (Chrome
              //              autofill, password manager) that
              //              bypass React's synthetic onChange
              //   onBlur   — last line of defense in case the value
              //              landed via some other path (form-restore,
              //              extension)
              // Emails can't legally contain whitespace, so the strip
              // is safe to run unconditionally.
              onChange={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              onInput={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              onBlur={(e) =>
                setEmail(e.currentTarget.value.replace(/\s+/g, ""))
              }
              className="input"
            />
          </Field>
          <Field label="Password">
            <input
              required
              type="password"
              minLength={mode === "signup" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
            />
          </Field>

          {error && (
            <div className="text-xs text-ember-500 bg-ember-50 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium px-3 py-2 transition disabled:opacity-50"
          >
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
            className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-cobble-500 transition"
          >
            {mode === "login"
              ? "no account yet? create one"
              : "already have an account? sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-[11px] font-mono text-slate-400 dark:text-slate-500">
          phase 0 · milestone 2 · auth
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
