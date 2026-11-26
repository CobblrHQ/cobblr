// What a station may write to a tag (#9763): a web link to a record, or one of
// the station's own control codes, named one by one (cobblr:station:file and
// the rest, stationControl). Never any other scheme: webLink stays as strict as
// it is, and the controls are let through by name, not by loosening it.
import { z } from "zod";
import { webLink, WEB_LINK_REFUSED } from "@cobblr/platform-contract/web-link";
import { stationControl } from "@cobblr/platform-contract/scan-station";

const link = webLink().max(500);

export const stationTagPayload = z
  .string()
  .max(500)
  .refine((s) => stationControl(s) !== null || link.safeParse(s).success, { message: WEB_LINK_REFUSED });
