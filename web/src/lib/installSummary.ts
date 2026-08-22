// Turning what an install did into what a person reads.
//
// The fact that matters most is the one nothing on screen can show: a bundle
// that skins a module's default table creates no table and no nav entry, so a
// complete install of it changes nothing visible. Saying so, and naming where
// the parts DID land, is the whole job here.

import type { BundleInstallSummary } from "./api";

/** One thing the install changed, and where to go and look at it. */
export interface InstallChange {
  /** What changed, in a person's words. */
  text: string;
  /** Where it lives, when there is somewhere to go. */
  href?: string;
  /** The label for that link. */
  linkLabel?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A module or instance name as a person sees it in the nav. */
export function prettyModule(name: string): string {
  return name
    .replace(/^core-/, "")
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The headline: what this install means in one sentence.
 *
 * An instance bundle gets a place of its own, so it can simply be pointed at.
 * A skin bundle needs the opposite said out loud, because a person who goes
 * looking for a nav entry will not find one and will reasonably conclude the
 * install failed.
 */
export function installHeadline(s: BundleInstallSummary): string {
  if (s.kind === "instance" && s.instance) {
    return `${s.bundle} is set up, with its own ${prettyModule(s.instance)} table.`;
  }
  const where = s.module ? prettyModule(s.module) : "what you already have";
  return `${s.bundle} is set up. It adds to ${where} rather than making a table of its own, so there is no new entry in the nav.`;
}

/**
 * Every change worth listing, in the order a person would look for them.
 *
 * Deliberately silent about a count of zero: "0 automations" is noise, and a
 * list of nothings reads as a failed install.
 */
export function installChanges(s: BundleInstallSummary): InstallChange[] {
  const out: InstallChange[] = [];
  if (s.kind === "instance" && s.instance) {
    out.push({
      text: `A ${prettyModule(s.instance)} table`,
      href: `/instances/${s.instance}`,
      linkLabel: `Open ${prettyModule(s.instance)}`,
    });
  }
  if (s.fields > 0) {
    const where = s.module ? ` on ${prettyModule(s.module)}` : "";
    out.push({
      text: `${plural(s.fields, "field")}${where}`,
      ...(s.module ? { href: `/${s.module}`, linkLabel: `Open ${prettyModule(s.module)}` } : {}),
    });
  }
  if (s.wires > 0) {
    out.push({
      // Named for what they do, since nothing on screen shows them until one
      // fires - which is exactly why they get a link.
      text: `${plural(s.wires, "automation")}, which run on their own`,
      href: "/wires",
      linkLabel: "See the wires",
    });
  }
  if (s.catalogs > 0) {
    out.push({ text: plural(s.catalogs, "catalog") });
  }
  if (s.modules_enabled.length > 0) {
    out.push({
      text: `Turned on ${s.modules_enabled.map(prettyModule).join(", ")}`,
    });
  }
  return out;
}

/**
 * The same thing in one line, for a toast - where a list would not fit and the
 * user is in the middle of doing something else.
 *
 * Returns null when there is genuinely nothing to report, so a caller can stay
 * quiet rather than say "changed nothing".
 */
export function installToastLine(s: BundleInstallSummary): string | null {
  const bits: string[] = [];
  if (s.kind === "instance" && s.instance) bits.push(`a ${prettyModule(s.instance)} table`);
  if (s.fields > 0) bits.push(plural(s.fields, "field"));
  if (s.wires > 0) bits.push(plural(s.wires, "automation"));
  if (!bits.length) return null;
  const where = s.kind === "skin" && s.module ? ` to ${prettyModule(s.module)}` : "";
  const last = bits.pop()!;
  const list = bits.length ? `${bits.join(", ")} and ${last}` : last;
  return `${s.bundle} added ${list}${where}.`;
}
