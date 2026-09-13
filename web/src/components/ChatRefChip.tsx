// How a link in Cobb's reply is drawn. A link to a record's page is a chip
// (icon, name, opens the record); any other in-app path navigates; anything
// else opens in a new tab. See web/src/lib/entity-chips.ts.
//
// The chip is an ordinary anchor, so the keyboard reaches it and Enter opens
// it; its accessible name is the record's name and then its kind ("The
// Hobbit, book"), so a screen reader hears what will open. Before it goes it
// checks the record is still there: the reply may be minutes old, and a chip
// for a record deleted since says so rather than landing on an error page.

import { useQuery } from "@tanstack/react-query";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { moduleIcon } from "../lib/module-icon";
import { recordOfHref } from "../lib/entity-chips";
import { useKindLabels } from "../lib/useKindLabels";

const CHIP =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[0.92em] font-medium not-italic no-underline align-[1px] " +
  "bg-cobble-50 dark:bg-cobble-900/60 text-cobble-800 dark:text-cobble-100 border border-cobble-200 dark:border-cobble-800";

export function ChatRefChip({
  slug,
  href,
  children,
  onGo,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { slug: string; onGo: (to: string) => void; children?: ReactNode }) {
  // The same query useDetailRoute holds, so this costs no extra request.
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
  const toast = useToast();
  // The word for ONE of them ("book"), from the collection's own declaration.
  // An instance kind's display_name is the collection ("Books"), and a screen
  // reader was hearing "Dune, books" (the rig, 2026-09-13).
  const labels = useKindLabels(slug);
  const record = recordOfHref(href, kinds.data?.items);
  if (record) {
    const kind = kinds.data?.items.find((k) => k.id === record.kind);
    const Icon = moduleIcon(kind?.icon);
    const noun = labels.noun(record.kind).toLowerCase();
    const name = textOf(children);
    const open = async () => {
      try {
        await api.lookupEntity(slug, record.kind, record.id);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
          toast.info(`${name || `That ${noun}`} is gone: it was deleted after this was written.`);
          return;
        }
        // Any other failure is not the record's absence; the page will say
        // what it can.
      }
      onGo(record.path);
    };
    return (
      <a
        href={record.path}
        className={`${CHIP} hover:border-cobble-400 dark:hover:border-cobble-500 hover:bg-cobble-100 dark:hover:bg-cobble-900 transition cursor-pointer`}
        title={`Open this ${noun}`}
        onClick={(e) => {
          e.preventDefault();
          void open();
        }}
      >
        <Icon size={12} className="shrink-0 opacity-70" aria-hidden="true" />
        {children}
        <span className="sr-only">, {noun}</span>
      </a>
    );
  }
  if (href?.startsWith("/")) {
    return (
      <a
        href={href}
        {...rest}
        onClick={(e) => {
          e.preventDefault();
          onGo(href);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

/** The words inside the chip, for the sentence that says the record is gone. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props ? textOf(props.children) : "";
}

/** A record named on a card that has no page to open: still a chip, no link. */
export function ChatRefName({ slug, kind, children }: { slug: string; kind: string; children: ReactNode }) {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
  const Icon = moduleIcon(kinds.data?.items.find((k) => k.id === kind)?.icon);
  return (
    <span className={CHIP}>
      <Icon size={12} className="shrink-0 opacity-70" />
      {children}
    </span>
  );
}

/** The word a delete card sets apart: it cannot be undone from the ledger the
 *  way a create or update can. */
export function PermanentTag() {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide bg-ember-50 dark:bg-ember-950/40 text-ember-700 dark:text-ember-300 border border-ember-200 dark:border-ember-900 align-[1px]">
      permanent
    </span>
  );
}
