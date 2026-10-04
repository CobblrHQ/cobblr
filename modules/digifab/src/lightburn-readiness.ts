import { z } from "zod";
const check = z.object({ ready: z.boolean(), fix: z.string().max(300) });
export const lightBurnReadiness = z.object({ api: check, paired: check, udp: check });
export type LightBurnReadiness = z.infer<typeof lightBurnReadiness>;
export function readLightBurnReadiness(raw: unknown): LightBurnReadiness | null {
  const parsed = lightBurnReadiness.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
