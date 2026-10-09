// The words a machine's surfaces use for what it does, derived from its kind.
//
// Digital Fabrication's job model is machine-agnostic: it sends a file to the
// software that runs a machine and tracks the job. Only the words differ. A
// laser cutter cuts or engraves, a CNC machine machines, a 3D printer prints,
// and anything else runs a job. Every machine-facing string that names the
// work, the job, the manager or the device comes from here, so a laser
// cutter's page never says "print" (`lint:machine-words` holds the surfaces
// that must stay kind-neutral; `machine-words.test.ts` holds the words).

export type MachineKind = "3d-printer" | "laser" | "cnc" | "assembly" | "pick-and-place" | "reflow" | "generic";

/** The machine collections the stock bundles provision, by instance id. The
 *  instance id is the stable key a bundle owns (its display name and noun are
 *  the workspace's to rename). A new machine bundle adds its row here, and
 *  `machine-words.test.ts` fails until it does. */
export const MACHINE_KIND_BY_INSTANCE: Readonly<Record<string, MachineKind>> = {
  "3d-printers": "3d-printer",
  "laser-cutters": "laser",
  "cnc-machines": "cnc",
  "assembly-machines": "assembly",
};

export function machineKindOf(instance: string | null | undefined): MachineKind {
  return (instance && MACHINE_KIND_BY_INSTANCE[instance]) || "generic";
}

export interface MachineWords {
  kind: MachineKind;
  /** The device, singular: "3D printer", "laser cutter". */
  device: string;
  /** What the machine does to a file: "print", "cut or engrave". */
  verb: string;
  /** One unit of work: "print job", "job". */
  job: string;
  jobs: string;
  /** The capability that sends files and tracks jobs, in a sentence. */
  manager: string;
  /** The same, as a title: "Print Manager", "Job Manager". */
  Manager: string;
  /** The software people already run for this kind, for "connect to …". */
  managerExamples: string;
  /** An example for the Family field, or "" when none reads well. */
  familyExample: string;
}

const WORDS: Record<MachineKind, MachineWords> = {
  "3d-printer": {
    kind: "3d-printer",
    device: "3D printer",
    verb: "print",
    job: "print job",
    jobs: "print jobs",
    manager: "print manager",
    Manager: "Print Manager",
    managerExamples: "Bambu, FDM Monster, OctoPrint, Klipper, Duet or Prusa",
    familyExample: `e.g. "Voron", "Railcore"`,
  },
  laser: {
    kind: "laser",
    device: "laser cutter",
    verb: "cut or engrave",
    job: "job",
    jobs: "jobs",
    manager: "job manager",
    Manager: "Job Manager",
    managerExamples: "LightBurn, through your bridge",
    familyExample: `e.g. "CO2 60W", "diode 10W"`,
  },
  cnc: {
    kind: "cnc",
    device: "CNC machine",
    verb: "machine",
    job: "job",
    jobs: "jobs",
    manager: "job manager",
    Manager: "Job Manager",
    managerExamples: "the software that runs it, through your bridge",
    familyExample: `e.g. "desktop router", "mill"`,
  },
  "pick-and-place": {
    kind: "pick-and-place", device: "pick-and-place machine", verb: "place", job: "placement job", jobs: "placement jobs", manager: "placement manager", Manager: "Placement Manager", managerExamples: "OpenPnP or the machine controller, through your bridge", familyExample: "",
  },
  reflow: {
    kind: "reflow", device: "reflow oven", verb: "reflow", job: "reflow run", jobs: "reflow runs", manager: "reflow manager", Manager: "Reflow Manager", managerExamples: "the oven controller, through your bridge", familyExample: "",
  },
  assembly: {
    kind: "assembly",
    device: "assembly machine",
    verb: "run",
    job: "job",
    jobs: "jobs",
    manager: "job manager",
    Manager: "Job Manager",
    managerExamples: "OpenPnP or the controller, through your bridge",
    familyExample: "",
  },
  generic: {
    kind: "generic",
    device: "machine",
    verb: "run",
    job: "job",
    jobs: "jobs",
    manager: "job manager",
    Manager: "Job Manager",
    managerExamples: "the software that runs it",
    familyExample: "",
  },
};

/** A kind that arrives as a free-form host hint may be anything; an unknown
 *  one reads as generic rather than as nothing. */
export function machineWords(kind: MachineKind | string | null | undefined): MachineWords {
  return WORDS[kind as MachineKind] ?? WORDS.generic;
}

/** The words for a machine in `instance` (a collection id, or none). */
export function machineWordsFor(instance: string | null | undefined): MachineWords {
  return WORDS[machineKindOf(instance)];
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function machineKindForRecord(instance: string | null | undefined, record: { type?: string | null; metadata?: Record<string, unknown> | null } | null | undefined): MachineKind {
  if (record?.metadata?.assembly_placement || /^(?:pick[- ]and[- ]place)(?: machine)?$/i.test(record?.type ?? "")) return "pick-and-place";
  if (record?.metadata?.assembly_reflow || /^reflow(?: oven)?$/i.test(record?.type ?? "")) return "reflow";
  return machineKindOf(instance);
}
