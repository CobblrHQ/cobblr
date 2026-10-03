import { api } from "./api";
import type { ScanStation, StationMode, StationSession } from "@cobblr/platform-contract/scan-station";

export const stationKeys = {
  all: (slug: string) => ["scan-stations", slug] as const,
  devices: (slug: string) => [...stationKeys.all(slug), "devices"] as const,
  device: (slug: string, id: string) => [...stationKeys.all(slug), "device", id] as const,
  sessions: (slug: string, id: string) => [...stationKeys.all(slug), "sessions", id] as const,
  session: (slug: string, id: string, session: string) => [...stationKeys.all(slug), "session", id, session] as const,
};
export function stationApi(slug: string) {
  const base = `/orgs/${encodeURIComponent(slug)}/scan-stations`;
  return {
    list: () => api.request<{ items: ScanStation[] }>("GET", base),
    create: (name: string, mode: StationMode) => api.request<ScanStation>("POST", base, { name, mode }),
    get: (id: string) => api.request<ScanStation>("GET", `${base}/${id}`),
    update: (id: string, values: { name?: string; mode?: StationMode }) => api.request<ScanStation>("PATCH", `${base}/${id}`, values),
    end: (id: string) => api.request<ScanStation>("POST", `${base}/${id}/end`, {}),
    controlTag: (id: string, code: string) => api.request("POST", `${base}/${id}/commands`, { type: "write", url: code }),
    sessions: (id: string, before?: string) => api.request<{ items: Array<Omit<StationSession, "actions"> & { count: number }>; next_before: string | null }>("GET", `${base}/${id}/sessions${before ? `?before=${encodeURIComponent(before)}` : ""}`),
    session: (id: string, session: string) => api.request<StationSession>("GET", `${base}/${id}/sessions/${session}`),
    undo: (id: string, session: string, action?: string) => api.request<StationSession>("POST", `${base}/${id}/sessions/${session}/undo`, { action_id: action }),
  };
}
