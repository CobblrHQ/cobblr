import { pairingResultPresentation, type PairingResultPresentation } from "@cobblr/platform-contract/pairing-presentation";

export interface LinkedItemPresentationSource {
  title: string;
  open_url?: string | null;
  open_label?: string | null;
}

/** The one shape both a new library link and the old-link heal publish. */
export function libraryPairingPresentation(item: LinkedItemPresentationSource): PairingResultPresentation | null {
  return pairingResultPresentation({ label: item.title, href: item.open_url, open_label: item.open_label });
}
