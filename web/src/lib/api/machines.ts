import { walkPages } from "../list-pages";
import { primaryBase, request } from "./client";

export interface Machine {
  id: string;
  name: string;
  short_name: string | null;
  family: string | null;
  type: string | null;
  manufacturer: string | null;
  serial_number: string | null;
  state: string;
  excitement: number;
  image_path: string | null;
  notes: string | null;
  quantity: number;
  location_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** The machines named under this record, one of its `quantity` each (the
   *  list and the detail carry them; a unit never shows on its own). */
  units?: MachineUnit[];
  /** How many of `quantity` have no name of their own yet (detail only). */
  units_not_named?: number;
  /** On a unit: the record it is one of. */
  unit_of?: { id: string; name: string } | null;
  /** What it runs: reported by its driver or typed, and when last seen (#6887). */
  firmware_version?: string | null;
  firmware_source?: "reported" | "typed" | null;
  firmware_seen_at?: string | null;
  software_version?: string | null;
  software_source?: "reported" | "typed" | null;
  software_seen_at?: string | null;
  controller?: string | null;
}

/** One version as the versions view reads it: `fresh` is false when it is
 *  missing or nobody has seen it lately, and then it never counts current. */
export interface MachineVersionReading {
  version: string | null;
  source: "reported" | "typed" | null;
  seen_at: string | null;
  fresh: boolean;
}

export type MachineVersionStatus = "current" | "behind" | "unknown";

export interface MachineVersionCohort {
  cohort: string;
  label: string;
  target: { firmware_target: string | null; software_target: string | null } | null;
  machines: number;
  current: number;
  behind: number;
  unknown: number;
  down_for_repair: number;
  summary: string;
  versions: Array<{ field: "firmware" | "software"; version: string; machines: number }>;
  items: Array<{
    id: string;
    name: string;
    state: string | null;
    serial_number: string | null;
    where: string | null;
    count: number;
    status: MachineVersionStatus | null;
    down_for_repair: boolean;
    firmware: MachineVersionReading;
    software: MachineVersionReading;
  }>;
}

export interface MachineVersionFleet {
  as_of: string;
  location_id: string | null;
  totals: { machines: number; current: number; behind: number; unknown: number; down_for_repair: number };
  cohorts: MachineVersionCohort[];
  places: Array<{ id: string; name: string }>;
}

export interface MachineUnit {
  id: string;
  name: string;
  state: string;
  location_id: string | null;
  serial_number: string | null;
  image_path: string | null;
}

export type MachineUnitMove = { id: string; parent_id: string; parent_quantity: number };

export const machinesApi = {

  // machines module (instance? scopes to /instances/:name/items)
  /** The machines you have; `gone` lists the ones sold, given away or
   *  scrapped instead. `gone_count` is how many have left either way. */
  listMachines: async (slug: string, instance?: string, opts: { gone?: boolean } = {}) => {
    let gone_count = 0;
    const walked = await walkPages<Machine>(async (offset, limit) => {
      const page = await request<{ items: Machine[]; total?: number | null; complete?: boolean; gone_count?: number }>(
        "GET",
        `${primaryBase(slug, "machines/machines", instance)}?${opts.gone ? "gone=1&" : ""}offset=${offset}&limit=${limit}`,
      );
      gone_count = page.gone_count ?? gone_count;
      return page;
    });
    return { ...walked, gone_count };
  },
  /** The versions view: this collection's machines by cohort, against each target. */
  getMachineVersions: (slug: string, instance?: string, locationId?: string | null) =>
    request<MachineVersionFleet>("GET", `${primaryBase(slug, "machines/machines", instance)}/versions${locationId ? `?location_id=${encodeURIComponent(locationId)}` : ""}`),
  /** Set (or, with empty values, clear) the version one cohort should run. Admins only. */
  setMachineVersionTarget: (slug: string, body: { cohort: string; firmware_target?: string | null; software_target?: string | null }, instance?: string) =>
    request<{ ok: true; summary: string }>("POST", `${primaryBase(slug, "machines/machines", instance)}/version-targets`, body),
  getMachine: (slug: string, id: string, instance?: string) =>
    request<Machine>("GET", `${primaryBase(slug, "machines/machines", instance)}/${id}`),
  createMachine: (slug: string, body: Partial<Machine>, instance?: string) =>
    request<Machine>("POST", primaryBase(slug, "machines/machines", instance), body),
  updateMachine: (slug: string, id: string, body: Partial<Machine>, instance?: string) =>
    request<Machine>("PATCH", `${primaryBase(slug, "machines/machines", instance)}/${id}`, body),
  nameMachineUnit: (slug: string, id: string, body: { name?: string | null; serial_number?: string | null }, instance?: string) =>
    request<{ id: string; parent_id: string }>("POST", `${primaryBase(slug, "machines/machines", instance)}/${id}/units`, body),
  splitMachineUnit: (slug: string, id: string, instance?: string) =>
    request<MachineUnitMove>("POST", `${primaryBase(slug, "machines/machines", instance)}/${id}/split`, {}),
  splitOneMachine: (slug: string, id: string, instance?: string) =>
    request<MachineUnitMove>("POST", `${primaryBase(slug, "machines/machines", instance)}/${id}/split-one`, {}),
  makeMachineUnitOf: (slug: string, id: string, parentId: string, instance?: string) =>
    request<MachineUnitMove>("POST", `${primaryBase(slug, "machines/machines", instance)}/${id}/unit-of`, { parent_id: parentId }),
  deleteMachine: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "machines/machines", instance)}/${id}`),
};
