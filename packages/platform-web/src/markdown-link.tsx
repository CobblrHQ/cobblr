import type { AnchorHTMLAttributes, ReactNode } from "react";
import { safeHref } from "@cobblr/platform-contract/safe-href";

/** Whether a link in Markdown leaves this app: any address with its own
 *  origin that is not this one (https://elsewhere, //elsewhere, mailto:).
 *  A path ("/w/home/…"), an anchor ("#notes") or this app's own origin stays. */
export function isOutsideLink(href: string | undefined): boolean {
  if (!href) return false;
  if (href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//"))) return false;
  if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return false;
  try {
    return typeof window === "undefined" || new URL(href, window.location.href).origin !== window.location.origin;
  } catch {
    return true;
  }
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props ? textOf(props.children) : "";
}

/** A link in Markdown that leaves this app, drawn the one way every surface
 *  draws it (#4115, security). Words in a record can carry a link whose
 *  address holds data ("[kit page](https://elsewhere/?d=…)"); drawn as plain
 *  words it looks like any in-app link and opens in the same tab. So where it
 *  goes is said in full beside its words, it opens in a new tab, and it tells
 *  the other site neither this page nor a way back to it. */
export function MarkdownOutsideLink({ href, children, className, title }: AnchorHTMLAttributes<HTMLAnchorElement> & { children?: ReactNode }) {
  const shown = textOf(children).trim();
  // An address that could run script when followed (javascript:, data:) is said, never linked (#9709).
  const safe = safeHref(href);
  if (href && !safe) {
    return (
      <span className={className} title={title} data-outside-link="" data-link-refused="">
        {children}
        {shown !== href ? <span className="ml-1 break-all text-xs opacity-70">({href})</span> : null}
      </span>
    );
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className={className} title={title} data-outside-link="">
      {children}
      {href && shown !== href ? <span className="ml-1 break-all text-xs opacity-70">({href})</span> : null}
    </a>
  );
}
