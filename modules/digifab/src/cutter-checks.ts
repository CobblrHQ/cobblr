import { z } from "zod";

export const CutterChecksSchema=z.object({media_loaded:z.literal(true),blade_depth_set:z.literal(true),native_offset_zero:z.literal(true),test_cut_checked:z.literal(true),origin_checked:z.literal(true)});
