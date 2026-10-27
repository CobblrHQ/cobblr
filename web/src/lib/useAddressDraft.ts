import { useEffect, useRef, useState } from "react";

// A text box whose words also live in the address (?q=…): the box is the
// person's own while they type, the address follows a moment after, and a
// change that comes from elsewhere (Back, the header's search) replaces the box.
//
// The address arriving late is NOT a change from elsewhere. On a phone a key
// can come just after the box wrote "LED b" and before the address caught up
// with it; taking that "LED b" back into the box dropped the "l", "LED blue"
// became "LED bue" and Search found nothing (#8658). So the box remembers what
// it wrote, and an address it wrote itself never replaces what was typed since.
export function useAddressDraft(address: string, write: (value: string | null) => void, waitMs = 200): [string, (value: string) => void] {
  const [draft, setDraft] = useState(address);
  const written = useRef<string[]>([]);
  useEffect(() => {
    const mine = written.current.indexOf(address);
    if (mine >= 0) {
      written.current = written.current.slice(mine + 1);
      return;
    }
    written.current = [];
    if (draft.trim() !== address) setDraft(address);
    // Only when the address changes: the draft is read, not followed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);
  useEffect(() => {
    const value = draft.trim();
    if (value === address) return;
    const t = setTimeout(() => {
      written.current = [...written.current, value];
      write(value || null);
    }, waitMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  return [draft, setDraft];
}
