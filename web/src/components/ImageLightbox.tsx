// ImageLightbox: the shared Lightbox (@cobblr/platform-web) for pictures in
// this workspace's file store. An item names a file ({ slug, fileId }) or a
// plain URL; this turns each into the viewer's per-size URLs, and everything
// else (stepping, swipe, "2 of 5", Esc, focus) is the one viewer's.
import { useMemo } from "react";
import { Lightbox, type LightboxItem as ViewerItem, type LightboxProps } from "@cobblr/platform-web";
import { api } from "../lib/api";

export interface LightboxItem {
  key: string;
  caption?: string;
  href?: string;
  /** A picture in the workspace's file store (preferred for attachments). */
  file?: { slug: string; fileId: string };
  /** A plain full-size URL (a resolved blob, or a web candidate). */
  url?: string;
  /** A plain thumbnail URL; defaults to `url`. */
  thumbUrl?: string;
  dividerBefore?: boolean;
}

type Verb = { label: string | ((item: LightboxItem) => string | null); busy?: boolean; onAction: (item: LightboxItem) => void };

export function toViewerItem(it: LightboxItem): ViewerItem & { from: LightboxItem } {
  const f = it.file;
  return {
    key: it.key,
    caption: it.caption,
    href: it.href,
    dividerBefore: it.dividerBefore,
    src: f ? api.fileRawUrl(f.slug, f.fileId, "medium") : it.url ?? null,
    original: f ? api.fileRawUrl(f.slug, f.fileId, "original") : it.url ?? null,
    thumb: f ? api.fileRawUrl(f.slug, f.fileId, "thumb") : it.thumbUrl ?? it.url ?? null,
    from: it,
  };
}

export function ImageLightbox({
  items,
  action,
  tools,
  onItemError,
  ...rest
}: Omit<LightboxProps, "items" | "action" | "tools" | "onItemError"> & {
  items: LightboxItem[];
  action?: Verb;
  tools?: Verb[];
  onItemError?: (item: LightboxItem) => void;
}) {
  const viewerItems = useMemo(() => items.map(toViewerItem), [items]);
  const back = (v: ViewerItem) => (v as ViewerItem & { from: LightboxItem }).from;
  const wrap = (verb: Verb) => ({
    busy: verb.busy,
    label: typeof verb.label === "function" ? (v: ViewerItem) => (verb.label as (i: LightboxItem) => string | null)(back(v)) : verb.label,
    onAction: (v: ViewerItem) => verb.onAction(back(v)),
  });
  return (
    <Lightbox
      {...rest}
      items={viewerItems}
      action={action && wrap(action)}
      tools={tools?.map(wrap)}
      onItemError={onItemError && ((v) => onItemError(back(v)))}
    />
  );
}
