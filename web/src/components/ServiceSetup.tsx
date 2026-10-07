// Add a service: where it is, what it offers, and its key
// (docs/design-decisions/services.md §6). Rendered inside the ordinary
// connection form, so the label, the per-workspace routes and the save are
// the ones every connection uses; only what a service needs of its own is
// here.
//
// 1. Where it is: an address, or an address on your own network reached
//    through your bridge (the same contract, relayed; nothing is opened on
//    your network).
// 2. Read it: the service's manifest says its name and what it can do, with
//    what each job may do in the world. A manifest that does not validate
//    stops here and says which field is wrong.
// 3. Key: the one string the service's mint-key showed. Test signs a health
//    check with it, so a wrong key reads as a wrong key and not as a service
//    that is down.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, api, type ServicePreview } from "../lib/api";
import { useMyEdgeBridge } from "../lib/useMyEdgeBridge";
import { AddressInput, SecretInput } from "@cobblr/platform-web";

/** What each effect means, in words a person reads before trusting it. */
export const EFFECT_WORDS: Record<ServicePreview["capabilities"][number]["effect"], { label: string; tone: string }> = {
  none: { label: "changes nothing elsewhere", tone: "text-faint dark:text-slate-400" },
  signal: { label: "briefly signals, then turns off", tone: "text-faint dark:text-slate-400" },
  stops: { label: "only stops or pauses a machine; never waits for a yes", tone: "text-faint dark:text-slate-400" },
  writes: { label: "changes things you own elsewhere; asks first", tone: "text-amber-700 dark:text-amber-400" },
  spends: { label: "costs money per use; asks first", tone: "text-amber-700 dark:text-amber-400" },
  physical: { label: "acts in the world; always asks first", tone: "text-ember-600 dark:text-ember-400" },
};

/** A few words for the job families the platform knows, so "slice.model"
 *  reads as slicing. An unknown family is shown by its id alone. */
function jobWords(capability: string): string | null {
  const family = capability.split(".")[0];
  return family === "slice" ? "slicing a model for a printer" : family === "design" ? "designing a part" : null;
}

const INPUT = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";

export function ServiceSetup({
  creds,
  onChange,
  keyIsSet,
  onRead,
  wantCapability = null,
}: {
  creds: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Editing a connection whose key is stored: blank keeps it. */
  keyIsSet: boolean;
  /** The manifest was read (or read again), for the label's default. */
  onRead?: (preview: ServicePreview) => void;
  /** The job the person came here to connect a service for (a Make's
   *  "Connect a slicer"). Said up front, and checked against what is read. */
  wantCapability?: string | null;
}) {
  const bridge = useMyEdgeBridge();
  const viaBridge = (creds.transit ?? "").startsWith("bridge");
  const [preview, setPreview] = useState<ServicePreview | null>(null);
  const [problem, setProblem] = useState<{ message: string; fields: Array<{ path: string; message: string }> } | null>(null);
  const [test, setTest] = useState<{ ok: boolean; warning?: string; message: string } | null>(null);

  const where = { base_url: creds.base_url ?? "", transit: creds.transit ?? "" };
  const read = useMutation({
    mutationFn: () => api.previewConnection({ provider_id: "service", credentials: where }),
    onSuccess: (r) => {
      setProblem(null);
      setPreview(r.preview);
      if (r.preview) onRead?.(r.preview);
    },
    onError: (e) => {
      setPreview(null);
      const fields = e instanceof ApiError && Array.isArray((e.details as unknown[] | undefined)) ? (e.details as Array<{ path: string; message: string }>) : [];
      setProblem({ message: e instanceof ApiError ? e.message : String(e), fields });
    },
  });
  const probe = useMutation({
    mutationFn: () => api.testConnection({ provider_id: "service", kind: "service", credentials: { ...where, secret: creds.secret ?? "" } }),
    onSuccess: (r) => setTest(r.ok ? { ok: true, warning: r.warning?.trim(), message: r.warning?.trim() || r.note || "It answered." } : { ok: false, message: r.error ?? "It did not answer." }),
    onError: (e) => setTest({ ok: false, message: e instanceof ApiError ? e.message : String(e) }),
  });

  const change = (key: string, value: string) => {
    onChange(key, value);
    if (key !== "secret") {
      setPreview(null);
      setProblem(null);
    }
    setTest(null);
  };

  return (
    <div className="space-y-3" data-testid="service-setup">
      {wantCapability && (
        <p className="text-sm text-content dark:text-mortar-200" data-testid="service-wanted">
          Connecting a service that does <span className="font-mono text-xs">{wantCapability}</span>
          {jobWords(wantCapability) ? ` (${jobWords(wantCapability)})` : ""}. You install the service yourself; Cobblr reads
          what it does from the service.
        </p>
      )}
      <fieldset className="space-y-1.5">
        <legend className="text-xs text-muted mb-1">Where it is</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Where it is">
          {[
            { value: "", label: "At an address" },
            { value: "bridge", label: "On my network, through my bridge" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={viaBridge === (o.value === "bridge")}
              onClick={() => change("transit", o.value)}
              className={
                "rounded-md border px-2.5 py-1 text-xs font-medium transition " +
                (viaBridge === (o.value === "bridge")
                  ? "border-accent bg-accent text-white"
                  : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
        <AddressInput
          value={creds.base_url ?? ""}
          onChange={(e) => change("base_url", e.target.value)}
          placeholder={viaBridge ? "http://192.168.1.20:8080" : "https://slicer.example.org"}
          aria-label={viaBridge ? "Its address on your network" : "Its address"}
          className={INPUT}
        />
        {viaBridge && (
          <div className="text-[11px] text-faint">
            {bridge.connected
              ? "Your bridge is connected. It reaches the service on your network; nothing on your network is opened to the outside."
              : "Your bridge is not connected right now. Start it on a computer on the same network, then read the service."}
          </div>
        )}
        <button
          type="button"
          onClick={() => read.mutate()}
          disabled={!where.base_url.trim() || read.isPending}
          className="rounded border border-line dark:border-slate-600 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-accent disabled:opacity-50"
        >
          {read.isPending ? "Reading…" : preview ? "Read it again" : "Read what it offers"}
        </button>
      </fieldset>

      {problem && (
        <div role="alert" className="rounded border border-ember-300 dark:border-ember-700 bg-ember-50/60 dark:bg-ember-900/20 px-3 py-2 text-sm text-content dark:text-mortar-100" data-testid="service-problem">
          <div>{problem.message}</div>
          {problem.fields.length > 1 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-muted dark:text-slate-400">
              {problem.fields.slice(0, 6).map((f) => (
                <li key={`${f.path}:${f.message}`}>
                  <span className="font-mono">{f.path}</span> {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {preview && (
        <div className="rounded border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-3 py-2 space-y-2" data-testid="service-preview">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-content dark:text-mortar-100">{preview.name}</span>
            <span className="text-[11px] font-mono text-faint">
              {preview.id} · v{preview.version}
              {preview.publisher ? ` · ${preview.publisher}` : ""}
            </span>
          </div>
          <ul className="space-y-1.5">
            {preview.capabilities.map((c) => (
              <li key={c.id} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-content dark:text-mortar-100">{c.title}</span>
                  <span className={`text-[11px] ${EFFECT_WORDS[c.effect].tone}`}>{EFFECT_WORDS[c.effect].label}</span>
                </div>
                <div className="text-xs text-muted dark:text-slate-400">{c.summary}</div>
              </li>
            ))}
          </ul>
          {wantCapability && !preview.capabilities.some((c) => c.id === wantCapability) && (
            <div className="text-xs text-amber-700 dark:text-amber-400" data-testid="service-lacks-wanted">
              This service does not do {wantCapability}. It can still be connected for what it does offer.
            </div>
          )}
          {preview.requires.includes("llm") && (
            <div className="text-[11px] text-faint">It runs its own AI model, configured on the service.</div>
          )}
        </div>
      )}

      <label className="block">
        <div className="text-xs text-muted mb-1">
          Key {keyIsSet && <span className="text-faint">· set (leave blank to keep)</span>}
        </div>
        <SecretInput
          secret
          what="key"
          value={creds.secret ?? ""}
          onChange={(e) => change("secret", e.target.value)}
          placeholder={keyIsSet ? "•••••• (unchanged)" : "the key id, a dot, and the secret"}
          aria-label="Key"
          className={INPUT + " font-mono"}
        />
        <div className="text-[11px] text-faint mt-1">The one string the service's mint-key command showed you. Each workspace or person can have their own.</div>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => probe.mutate()}
          disabled={!where.base_url.trim() || !(creds.secret ?? "").trim() || probe.isPending}
          className="rounded border border-line dark:border-slate-600 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-accent disabled:opacity-50"
        >
          {probe.isPending ? "Testing…" : "Test"}
        </button>
        {test && (
          <span className={"text-xs " + (test.ok ? test.warning ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400" : "text-ember-600 dark:text-ember-400")} data-testid="service-test-line">
            {test.ok ? test.warning ? "⚠ " : "✓ " : "✗ "}
            {test.message}
          </span>
        )}
      </div>
    </div>
  );
}
