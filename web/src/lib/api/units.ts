import { request } from "./client";

// core-units vocabulary (shapes match @cobblr/platform-web's types).
export type UnitDisplayMode = "symbol" | "name" | "both";
export interface UnitDef {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
}
export interface UnitInputBody {
  code: string;
  symbol: string;
  name: string;
  plural?: string;
  category?: string;
}
export interface UnitVocabulary {
  builtins: UnitDef[];
  custom: UnitDef[];
  display_mode: UnitDisplayMode;
}

export const unitsApi = {

  // core-units vocabulary
  listUnits: (slug: string) =>
    request<UnitVocabulary>("GET", `/orgs/${slug}/modules/core-units/units`),
  addUnit: (slug: string, unit: UnitInputBody) =>
    request<UnitDef>("POST", `/orgs/${slug}/modules/core-units/units`, unit),
  deleteUnit: (slug: string, code: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-units/units/${encodeURIComponent(code)}`),
  setUnitDisplayMode: (slug: string, mode: UnitDisplayMode) =>
    request<{ display_mode: UnitDisplayMode }>(
      "PUT",
      `/orgs/${slug}/modules/core-units/units/settings`,
      { display_mode: mode },
    ),
};
