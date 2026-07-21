// DriveContext — the single owner of the browser-drive SSE stream (Feature 3:
// Claude/scans drive the app you have open). Lifted out of the old DriveBanner so
// BOTH the presence-cursor overlay AND the Live box can read the same drive state
// without opening a second stream. The stream must be always-mounted (independent
// of the Live box's visibility) so an incoming drive-offer can surface the box in
// the first place. Navigation + presence stay here (the transport); the visible
// pill/prompt moved into the Live box.

import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import {
  useBrowserDrive,
  type DriveState,
  type DriveMode,
  type DrivePresence,
} from "../hooks/useBrowserDrive";
import { DrivePresenceOverlay } from "./DrivePresenceOverlay";

export interface DriveCtx {
  /** idle | offer | active | elsewhere — the live drive state for this tab. */
  state: DriveState;
  /** true when the driver is scans (not Claude). */
  byScans: boolean;
  accept: () => void;
  release: () => void;
  presence: DrivePresence | null;
}

const Ctx = createContext<DriveCtx | null>(null);

export function useDrive(): DriveCtx {
  return (
    useContext(Ctx) ?? { state: "idle", byScans: false, accept: () => {}, release: () => {}, presence: null }
  );
}

export function DriveProvider({ children }: { children: ReactNode }) {
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  // The grant is the only thing that turns driving on; default off → the hook idles.
  const grantQ = useQuery({
    queryKey: ["drive-grant", slug],
    queryFn: () => api.driveGrant(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  const mode: DriveMode = grantQ.data?.mode ?? "off";
  const { state, accept, release, presence } = useBrowserDrive(slug || undefined, mode);

  // Distinguish scans-driving from Claude-driving (cheap poll, only while driving).
  const statusQ = useQuery({
    queryKey: ["drive-status", slug],
    queryFn: () => api.driveStatus(slug),
    enabled: !!slug && mode !== "off" && state !== "idle",
    refetchInterval: 4000,
  });
  const byScans = !statusQ.data?.driver;

  return (
    <Ctx.Provider value={{ state, byScans, accept, release, presence }}>
      {children}
      <DrivePresenceOverlay presence={presence} />
    </Ctx.Provider>
  );
}
