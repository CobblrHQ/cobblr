import type { ArmState } from "@cobblr/platform-contract/robot-arm";
export const armState = (patch: Partial<ArmState> = {}): ArmState => ({ connectivity: "online", mode: "remote", execution: "loaded", safety: "normal", power: "on", safety_detail: null, program: { name: "unload", revision: "r1" }, run_id: null, observed_at: "2026-10-16T12:00:00Z", ...patch });
