import { platform } from "@cobblr/platform-contract";
import { buildCompatProvider, baseOf } from "./openai-compat.js";
import { TRANSIT_FIELD } from "./edge-transit.js";
export function register(): void {
  platform().ai.registerProvider(buildCompatProvider({
    id: "local-openai", label: "Local OpenAI server (llama.cpp, LM Studio)", localOnly: true, liveModels: true, rank: 21,
    resolveBase: baseOf,
    describeCredentials: () => ({
      base_url: { label: "Private server URL (e.g. http://192.168.1.50:8080/v1)", secret: false },
      api_key: { label: "API key (optional)", secret: true },
      model: { label: "Locally installed model (optional)", secret: false },
      ...TRANSIT_FIELD,
      transit: { ...TRANSIT_FIELD.transit!, choices: [
        { value: "", label: "Direct: on the same private network" },
        { value: "bridge", label: "Via my edge bridge: on my own device" },
      ] },
    }),
    setup: {
      summary: "Use a model on your own device or network. Personal documents stay on that network.",
      steps: [
        { text: "Start the local server in llama.cpp, LM Studio or another app that serves the OpenAI API." },
        { text: "Enter its private network address. Use your edge bridge when the server runs on your device and Cobblr cannot reach it directly." },
        { text: "For photos, load a model that can read images. Choose it for Personal documents in Configuration, AI." },
      ],
    },
  }));
}
