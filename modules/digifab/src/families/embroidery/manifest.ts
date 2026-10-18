// What the embroidery family declares in Digital Fabrication's manifest: its
// module part, its actions and its panels. Data only: src/module.ts spreads it
// in through families/manifests.ts. The part is on everywhere, as embroidery was
// before it had a folder of its own.
import type { ModuleActionInput, ModulePanelInput, ModulePartInput } from "@cobblr/platform-contract";

export const embroideryManifest: { part: ModulePartInput; panels: ModulePanelInput[]; actions: ModuleActionInput[] } = {
  part: {
    id: "embroidery",
    label: "Embroidery",
    description: "Embroidery machines: their hoops and formats, designs, and runs written to USB and recorded at the station.",
    default: "on",
    routes: ["/embroidery"],
  },
  panels: [
  ],
  actions: [
      {
        part: "embroidery",
        // UI-SCREEN: /digifab/embroidery
        id:"digifab:embroidery-job", changes: "records",label:"Prepare and record embroidery",scope:"workspace",group:"more",userInvokable:false,
        // ADMIN-ONLY: the page's own route POST /embroidery/actions gates on this action's own id, owner or admin
        runBy: "admin",
        description:"Create or update a machine (label, hoops with name/width_mm/height_mm, formats, stitches_per_minute, filename_prefix, asset_ref), import a design (file_id, name), prepare a USB run (machine_id, design_id, hoop, format, threads mapping colour-stop indices to native spool ids), start tracking at its authorized station (station_token and file_copied/file_confirmed/hoop_mounted/colours_loaded/origin_clear all true), record interruption, or record outcome (station_token, verdict good/scrap, finished, idle_confirmed and needle_up_confirmed true, usage array of index/metres for every colour stop). Requires admin. Never operates a physical machine. Unstarted discards require scrap and zero use. Read with read_laser_batch embroidery operations. Download the prepared machine file with /embroidery/runs/{job_id}/export.",
        invokeHandler:"digifab.embroidery-job",effect:"writes",undoable:false,
        argsSchema: {
          operation: {label:"Operation",type:"text",required:true,choices:["create_machine","update_machine","import_design","prepare","start","interrupt","outcome"].map(value=>({value,label:value.replaceAll("_"," ")}))},
          id: {label:"Machine or job id",type:"text"},
          fields: {label:"Fields",type:"json"},
        },
      },
  ],
};
