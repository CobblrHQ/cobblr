// The sheet a workspace tapes to its wall: scan to join (#3801, #6738). One
// sheet for every app on the engine, so the warning on it cannot drift: the
// code is a password for the workspace, and the sheet says what it lets a
// stranger do. Its own window, so the browser prints the sheet and nothing of
// the app around it.
import { ORG_ROLE_BLURB, ORG_ROLES, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { withArticle } from "@cobblr/platform-contract/plural";

/** A role in a person's words: its name, and what it lets someone do. A bare
 *  string is a role id the engine knows (worded from its blurb) or a name an
 *  app already put in its own words. */
export type JoinSheetRole = string | { name: string; says?: string | null };

export type JoinSheetPace = { limit: number; period: "day" | "week" | "month" | "year" };

export interface JoinSheetOptions {
  url: string;
  workspace: string;
  role?: JoinSheetRole | null;
  pace?: JoinSheetPace | null;
  /** How a manager stops the code, in that app's words: "revoke it or make a new code on the Members page". */
  stopHow?: string;
  /** One line on what to do once in, for an app that has one. */
  then?: string | null;
  paper?: "letter" | "a4";
}

export interface JoinSheetText {
  title: string;
  joinAs: string | null;
  roleSays: string | null;
  password: string;
  whoCan: string;
  ifOut: string;
  pace: string | null;
  then: string | null;
}

const isOrgRole = (r: string): r is OrgRoleName => (ORG_ROLES as readonly string[]).includes(r);

/** A role in words, never its id. */
export function joinSheetRole(role: JoinSheetRole | null | undefined): { name: string; says: string | null } | null {
  if (!role) return null;
  if (typeof role !== "string") return { name: role.name, says: role.says ?? null };
  if (isOrgRole(role)) return { name: role[0]!.toUpperCase() + role.slice(1), says: ORG_ROLE_BLURB[role] };
  return { name: role, says: null };
}

/** The words on the sheet, apart from the page, so they can be read in a test. */
export function joinSheetText(o: Omit<JoinSheetOptions, "url" | "paper">): JoinSheetText {
  const role = joinSheetRole(o.role);
  const n = o.pace && o.pace.limit > 0 ? Math.floor(o.pace.limit) : 0;
  return {
    title: `Scan to join ${o.workspace}`,
    joinAs: role ? `You'll join as ${role.name}.` : null,
    roleSays: role?.says ?? null,
    password: "Treat this QR code and link like a password.",
    whoCan: `Anyone who has it can join ${o.workspace}${role ? ` as ${role.name}, with the permissions above` : ""}.`,
    ifOut: `If it gets out, ${o.stopHow ?? "revoke it or make a new code on the Members page"}. This printed code then stops working.`,
    pace: n && o.pace ? `Up to ${n} ${n === 1 ? "person" : "people"} ${withArticle(o.pace.period)} can join with this code.` : null,
    then: o.then ?? null,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The whole printed page, one sheet of `paper`, with the QR as a data URL. */
export function joinSheetHtml(o: JoinSheetOptions, qrDataUrl: string): string {
  const t = joinSheetText(o);
  const line = (cls: string, s: string | null) => (s ? `<p class="${cls}">${esc(s)}</p>` : "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
  @page { size: ${o.paper === "a4" ? "A4" : "letter"} portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: system-ui, sans-serif; text-align: center; color: #1c1917; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 180mm; margin: 0 auto; break-inside: avoid; }
  h1 { font-size: 30px; line-height: 1.15; margin: 0 0 4mm; overflow-wrap: anywhere; }
  .as { font-size: 20px; font-weight: 600; margin: 0; }
  .says { font-size: 15px; color: #44403c; margin: 1.5mm auto 0; max-width: 150mm; }
  img { display: block; width: 120mm; height: 120mm; margin: 6mm auto; image-rendering: pixelated; }
  .password { font-size: 20px; font-weight: 700; margin: 0; }
  .who { font-size: 15px; margin: 1.5mm auto 0; max-width: 150mm; }
  .out, .pace { font-size: 13px; color: #44403c; margin: 3mm auto 0; max-width: 150mm; }
  .then { font-size: 15px; margin: 4mm auto 0; max-width: 150mm; }
  .url { font-size: 10px; color: #57534e; word-break: break-all; margin: 5mm auto 0; max-width: 150mm; }
</style></head><body><main class="sheet">
  <h1>${esc(t.title)}</h1>
  ${line("as", t.joinAs)}
  ${line("says", t.roleSays)}
  <img src="${qrDataUrl}" alt="QR code to join ${esc(o.workspace)}" />
  ${line("password", t.password)}
  ${line("who", t.whoCan)}
  ${line("out", t.ifOut)}
  ${line("pace", t.pace)}
  ${line("then", t.then)}
  <p class="url">${esc(o.url)}</p>
</main>
<script>window.onload = () => { window.focus(); window.print(); };</script>
</body></html>`;
}

/** Open the sheet in its own window and print it. False when the browser blocked the window. */
export async function printJoinSheet(o: JoinSheetOptions): Promise<boolean> {
  const { default: QRCode } = await import("qrcode");
  const qr = await QRCode.toDataURL(o.url, { margin: 1, errorCorrectionLevel: "M", width: 640 });
  const w = window.open("", "_blank", "noopener=no");
  if (!w) return false;
  w.document.write(joinSheetHtml(o, qr));
  w.document.close();
  return true;
}
