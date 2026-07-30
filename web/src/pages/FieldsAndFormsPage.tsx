// /fields — define your custom fields, then lay them out on the form.
//
// These were two registry destinations ("Custom fields" and "Form builder") on
// two routes, so defining a field and then placing it on the form meant
// finishing on one page and going hunting for the other. Same act, one page,
// two tabs. See docs/design-decisions/configuration-revamp.md.
//
// /configuration/form-builder redirects here with ?tab=layout.

import { useSearchParams } from "react-router-dom";

import { usePageTitle } from "@cobblr/platform-web";
import { FieldsPage } from "./FieldsPage";
import { FormBuilderPage } from "./FormBuilderPage";

export function FieldsAndFormsPage() {
  usePageTitle("Fields & forms");
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "layout" ? "layout" : "fields";
  const go = (t: "fields" | "layout") =>
    setParams(t === "layout" ? { tab: "layout" } : {}, { replace: true });

  const tabCls = (on: boolean) =>
    "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition " +
    (on
      ? "border-cobble-600 text-content dark:text-mortar-100"
      : "border-transparent text-muted hover:text-content dark:hover:text-mortar-100");

  return (
    <div className="space-y-4">
      
      <div className="flex gap-1 border-b border-line dark:border-slate-700">
        <button type="button" onClick={() => go("fields")} className={tabCls(tab === "fields")}>
          Fields
        </button>
        <button type="button" onClick={() => go("layout")} className={tabCls(tab === "layout")}>
          Form layout
        </button>
      </div>
      {tab === "fields" ? <FieldsPage embedded /> : <FormBuilderPage embedded />}
    </div>
  );
}
