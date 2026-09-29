// platform().services: the one door to outside work (services.md §10).
//
// The seam is in place so every module, surface and the Connections half can
// build against it now. The kernel behind it (the job table, invoke, the
// poller, the transport, consent) lands with Services S1; until then every
// call that would do work throws ServicesNotReadyError, loudly, rather than
// return an empty answer that reads as "nothing connected".

import { ServicesNotReadyError, type BuiltInServiceDef, type PlatformServices } from "@cobblr/platform-contract/services";

const builtIns = new Map<string, BuiltInServiceDef>();

export function createServices(): PlatformServices {
  return {
    capabilities: async () => {
      throw new ServicesNotReadyError("listing capabilities");
    },
    chainFor: async () => {
      throw new ServicesNotReadyError("the order of who answers");
    },
    invoke: async () => {
      throw new ServicesNotReadyError("invoke");
    },
    job: async () => {
      throw new ServicesNotReadyError("reading a job");
    },
    answer: async () => {
      throw new ServicesNotReadyError("answering a job");
    },
    confirm: async () => {
      throw new ServicesNotReadyError("confirming a job");
    },
    cancel: async () => {
      throw new ServicesNotReadyError("cancelling a job");
    },
    registerBuiltIn: (def) => {
      if (builtIns.has(def.id)) throw new Error(`services: a built-in ${def.id} is already registered`);
      builtIns.set(def.id, def);
    },
  };
}
