import { z } from "zod";
import { instantOnDay } from "@cobblr/platform-contract/day";

export const AssetDate = z.string()
  .refine((value) => instantOnDay(value) !== null, "Choose a real date (YYYY-MM-DD).")
  .nullable();
