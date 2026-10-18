// What a plan's firmware puts on the chip, pinned when the plan is saved.
//
// A program step that verifies by read-back is checked against image_sha256:
// the station hashes what it reads off the chip the same way, and the
// workspace refuses a passed step whose read-back is anything else. The value
// is computed here from the file itself, never taken from the request, so a
// plan cannot claim a hash its firmware does not have.
import { createHash } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { imageFormatOf, imageSegments, imageSha256 } from "@cobblr/platform-contract/firmware-image";

type RawStep = Record<string, unknown> & { kind?: unknown; name?: unknown; firmware?: unknown; verify?: unknown; load_address?: unknown; parameters?: unknown; unit_write?: unknown };

/** Fill in each read-back program step's firmware format and image hash from
 *  the file in Files. Returns the plan with those fields set; anything the
 *  request said about them is replaced. */
export async function pinProgramImages(orgId: string, raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { steps?: unknown }).steps)) return raw;
  const plan = raw as { steps: unknown[] };
  const steps = await Promise.all(plan.steps.map(async (value) => {
    const step = (value && typeof value === "object" ? value : {}) as RawStep;
    if (step.kind !== "program" || step.verify !== "readback") return value;
    const name = typeof step.name === "string" ? step.name : "the programming step";
    const firmware = (step.firmware && typeof step.firmware === "object" ? step.firmware : {}) as { file_id?: unknown; sha256?: unknown };
    if (typeof firmware.file_id !== "string") throw new Error(`Choose the firmware for ${name}.`);
    const file = await platform().files.read(orgId, firmware.file_id);
    if (!file) throw new Error(`Keep the firmware used by ${name} in Files.`);
    if (createHash("sha256").update(file.bytes).digest("hex") !== firmware.sha256) throw new Error(`The firmware for ${name} changed. Choose it again.`);
    const format = imageFormatOf(file.filename);
    if (!format) throw new Error(`Use a BIN, HEX, ELF or UF2 image for ${name}.`);
    const parameters = (step.parameters && typeof step.parameters === "object" ? step.parameters : {}) as { offset?: unknown };
    const start = typeof step.load_address === "number" ? step.load_address : typeof parameters.offset === "number" ? parameters.offset : undefined;
    if (format === "bin" && start === undefined) throw new Error(`Give ${name} the address its BIN image starts at.`);
    const segments = imageSegments(new Uint8Array(file.bytes), format, start ?? 0);
    const write = step.unit_write as { address?: unknown; length?: unknown; memory?: unknown } | undefined;
    if (write && write.memory !== "eeprom" && typeof write.address === "number" && typeof write.length === "number") {
      const from = write.address, to = write.address + write.length;
      if (segments.some((s) => from < s.address + s.bytes.length && to > s.address)) throw new Error(`${name} writes the serial inside its own firmware image. Choose an address outside it.`);
    }
    return { ...step, firmware: { ...firmware, format, image_sha256: imageSha256(segments) } };
  }));
  return { ...plan, steps };
}
