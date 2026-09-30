// The record a module page's own address names: /<base>/<id>, or
// /<base>/<sub>/<id> for a second kind the same page opens. Search, tags, the
// activity feed and every link Cobb gives hand out a kind's detailRoute, and a
// module UI mounted under a splat (/sales/*) is reached by all of them, so a
// page that keeps "which record is open" in local state shows its list with
// nothing opened (#4315). Opening a record here writes the address instead, so
// it can be shared, and Back closes it.
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export interface RecordInPathOptions {
  /** A second segment naming another kind: "customers" in /sales/customers/<id>. */
  sub?: string;
  /** First segments that name a page of the module, never a record (the
   *  other kinds' `sub`s, "settings"). Only read when `sub` is not set. */
  reserved?: readonly string[];
}

export function useRecordInPath(base: string, opts: RecordInPathOptions = {}): [string | null, (id: string | null) => void] {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // The first whole segment equal to base, wherever the module is mounted
  // (/sales, or an instance's /instances/<name>/sales).
  const m = new RegExp(`^(.*?/${base})(?=/|$)(.*)$`).exec(pathname);
  const home = m ? m[1]! : `/${base}`;
  const rest = (m ? m[2]! : "").split("/").filter(Boolean);
  const { sub, reserved } = opts;
  const raw = sub ? (rest[0] === sub ? rest[1] : undefined) : rest[0] && !(reserved ?? []).includes(rest[0]) ? rest[0] : undefined;
  const id = raw ? decodeURIComponent(raw) : null;
  const open = useCallback(
    (next: string | null) => navigate(next ? `${home}/${sub ? `${sub}/` : ""}${encodeURIComponent(next)}` : home),
    [navigate, home, sub],
  );
  return [id, open];
}
