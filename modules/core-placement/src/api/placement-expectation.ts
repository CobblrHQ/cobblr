import { z } from "zod";

export const PlacementRef = z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(200) });
export const PlacementPosition = z.object({ x_mm: z.number().finite().min(-1_000_000).max(1_000_000), y_mm: z.number().finite().min(-1_000_000).max(1_000_000) });
export const ExpectedPlacement = z.object({
  container: PlacementRef.nullable(),
  slot: z.string().max(120).nullish(),
  position: PlacementPosition.nullish(),
});
