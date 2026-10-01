// Thin web-app adapter for the shared platform-web ContentsPanel. The real,
// generic implementation now lives in @cobblr/platform-web so module UIs (e.g.
// inventory's part detail) can use the exact same panel — a module can't import
// from web/src. This adapter supplies the web app's auth token, and for a thing
// built from parts the place picker "Take out to…" offers (the shared panel
// cannot know the places).

import { ContentsPanel as SharedContentsPanel, useHoldsContents as useSharedHoldsContents } from "@cobblr/platform-web";
import { getToken } from "../lib/api";
import { LOCATION_KIND } from "../lib/placeItems";
import { LocationTreePicker } from "./LocationTreePicker";

export function ContentsPanel(props: {
  slug: string;
  container: { kind: string; id: string };
  title?: string;
  scanIntoHref?: string;
  /** A thing built from parts (a computer, a machine): install, values, take out. */
  builtFrom?: boolean;
  /** The kind whose word names the panel (a collection's own kind). */
  wordKind?: string;
}) {
  return (
    <SharedContentsPanel
      {...props}
      getToken={getToken}
      {...(props.builtFrom
        ? {
            takeOutPicker: (onPick: (to: { kind: string; id: string }) => void) => (
              <LocationTreePicker
                value={null}
                onChange={(id) => id && onPick({ kind: LOCATION_KIND, id })}
                onPickHolder={(h) => onPick({ kind: h.kind, id: h.id })}
                placeholder="Take it out to…"
                size="sm"
              />
            ),
          }
        : {})}
    />
  );
}

/** Does anything sit inside this record? For a container face that is off:
 *  the section stays while it holds something. */
export function useHoldsContents(slug: string, container: { kind: string; id: string }): boolean {
  return useSharedHoldsContents(slug, getToken, container);
}
