import { viaBridge } from "./edge-transit.js";
import { ipFamily, isPrivateIp } from "@cobblr/platform-contract/private-ip";
export function assertLocalModelName(model: string): void {
  if (/(?:cloud|claude|sonnet|opus|haiku|gemini|gpt-[45])/i.test(model)) throw new Error("Local AI requires a locally installed model.");
}
export function assertLocalAiEndpoint(base: string, credentials: Record<string, unknown>, model?: string): void {
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = ipFamily(host) ? isPrivateIp(host) : ["localhost", "ollama", "llama-cpp", "llamacpp", "vllm", "localai", "lmstudio", "host.docker.internal"].includes(host) || host.endsWith(".local");
  if (!local || credentials.mcp_relay === "bridge") throw new Error("Local AI requires a private endpoint without cloud tool forwarding.");
  if (viaBridge(credentials) && !ipFamily(host) && host !== "localhost") throw new Error("Use localhost or a private IP for local AI through your bridge.");
  if (model) assertLocalModelName(model);
}
export function assertLocalAiPin(pin: string | null): void {
  if (pin && !isPrivateIp(pin)) throw new Error("Local AI requires a private endpoint.");
}
