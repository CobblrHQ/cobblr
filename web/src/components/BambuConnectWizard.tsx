// Bambu cloud-login connect wizard — embeddable (no Modal wrapper; the parent
// provides the container). Modeled on the Home Assistant Bambu integration:
// start with a cloud login, then we discover EVERY printer on the account (each
// one's LAN access code rides along server-side). A connection = the whole
// account; on success we hand the caller the created connection + the discovered
// printers so it can link the right one (e.g. the New-3D-printer modal pre-fills
// + links). The Bambu token never reaches the browser.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { BambuPrinterPicker } from "./BambuPrinterPicker";
import { useToast } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { ApiError, api, type BambuDiscoveredDevice, type DigifabConnection, type BambuLoginResponse } from "../lib/api";

const REGIONS = ["North America", "Europe", "Asia Pacific", "China", "Other"];

export function BambuConnectWizard({
  onConnected,
  onCancel,
}: {
  onConnected: (connection: DigifabConnection, devices: BambuDiscoveredDevice[]) => void;
  onCancel: () => void;
}) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [step, setStep] = useState<"login" | "code" | "review">("login");
  const [region, setRegion] = useState("North America");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState("");
  const [codeKind, setCodeKind] = useState<"need_email_code" | "need_tfa">("need_email_code");
  const [code, setCode] = useState("");
  const [devices, setDevices] = useState<BambuDiscoveredDevice[]>([]);
  const [label, setLabel] = useState("");

  const field = "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const lbl = "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";
  const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e));
  const arrive = (r: Extract<BambuLoginResponse, { status: "ready" }>) => { setDevices(r.devices); setStep("review"); };

  const login = useMutation({
    mutationFn: () => api.bambuLogin(activeSlug, { region, email: email.trim(), password }),
    onSuccess: (r) => { setSession(r.session); if (r.status === "ready") arrive(r); else { setCodeKind(r.status); setStep("code"); } },
    onError: err,
  });
  const submitCode = useMutation({
    mutationFn: () => api.bambuCode(activeSlug, { session, code: code.trim() }),
    onSuccess: (r) => { if (r.status === "ready") arrive(r); },
    onError: err,
  });
  const connect = useMutation({
    mutationFn: () => api.bambuCreate(activeSlug, { session, mode: "cloud", label: label.trim() || undefined }),
    onSuccess: (r) => { toast.success("Bambu account connected"); onConnected(r.connection, r.devices); },
    onError: err,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Printer size={14} className="text-accent" />
        <span>Sign in with your <strong>Bambu account</strong>  - we'll find every printer on it automatically.</span>
      </div>

      {step === "login" && (
        <form onSubmit={(e) => { e.preventDefault(); login.mutate(); }} className="space-y-3">
          <label className="block">
            <span className={lbl}>Region</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)} className={field}>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={lbl}>Bambu account email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={field} autoFocus />
          </label>
          <label className="block">
            <span className={lbl}>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
          </label>
          <p className="text-[11px] text-faint">Used once to get a token, then discarded. The token is stored encrypted and never reaches this browser.</p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Cancel</button>
            <button type="submit" disabled={login.isPending || !email.trim() || !password} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
              {login.isPending ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={(e) => { e.preventDefault(); submitCode.mutate(); }} className="space-y-3">
          <p className="text-sm text-content">
            {codeKind === "need_email_code" ? "Bambu emailed you a verification code — enter it below." : "Enter your two-factor authentication code."}
          </p>
          <label className="block">
            <span className={lbl}>Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" className={field} autoFocus />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setStep("login")} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Back</button>
            <button type="submit" disabled={submitCode.isPending || !code.trim()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
              {submitCode.isPending ? "Verifying…" : "Verify"}
            </button>
          </div>
        </form>
      )}

      {step === "review" && (
        <form onSubmit={(e) => { e.preventDefault(); connect.mutate(); }} className="space-y-3">
          <div>
            <span className={lbl}>Printers on this account</span>
            {devices.length === 0 ? (
              <p className="text-sm text-muted">No printers found on this account.</p>
            ) : (
              <BambuPrinterPicker devices={devices} />
            )}
          </div>
          <p className="text-[11px] text-faint">Cloud mode gives live status & temps. Remote start/pause isn't possible over the cloud - Bambu blocks third-party control there; it requires a LAN connection with Developer Mode.</p>
          <label className="block">
            <span className={lbl}>Label (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Bambu (${email || "account"})`} className={field} />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setStep("login")} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">Back</button>
            <button type="submit" disabled={connect.isPending} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
              {connect.isPending ? "Connecting…" : "Connect account"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
