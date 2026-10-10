// What a firmware image puts on a chip, and where: the bytes a read-back must
// find there.
//
// A programmer's own "verify" compares what it just wrote with what it meant
// to write, through its own parser of the file. A read-back is the station's
// own check: it reads the chip's memory back over the same probe and compares
// it, byte for byte, with what this file says belongs at each address. The
// plan pins the result (image_sha256) when it is saved, so the station and the
// workspace check the chip against the same bytes.
//
// Four formats, each read to the same shape, a list of address ranges with
// their bytes: a raw BIN at an offset, Intel HEX, the loadable segments of an
// ELF, and a UF2's blocks.
import { createHash } from "node:crypto";
import { countOf } from "@cobblr/platform-contract/plural";

export interface ImageSegment {
  address: number;
  bytes: Uint8Array;
}

export type ImageFormat = "bin" | "hex" | "elf" | "uf2";

const MAX_ADDRESS = 0xffff_ffff;

export function imageFormatOf(filename: string): ImageFormat | null {
  const ext = /\.(bin|hex|elf|uf2)$/i.exec(filename)?.[1]?.toLowerCase();
  return (ext as ImageFormat | undefined) ?? null;
}

/** Adjacent ranges as one, in address order; an overlap is refused, since two
 *  claims on one byte cannot both be checked. */
function coalesce(parts: ImageSegment[]): ImageSegment[] {
  const sorted = parts.filter((p) => p.bytes.length > 0).sort((a, b) => a.address - b.address);
  const out: ImageSegment[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.address < last.address + last.bytes.length) throw new Error("This firmware image writes the same address twice.");
    if (last && p.address === last.address + last.bytes.length) {
      const merged = new Uint8Array(last.bytes.length + p.bytes.length);
      merged.set(last.bytes);
      merged.set(p.bytes, last.bytes.length);
      out[out.length - 1] = { address: last.address, bytes: merged };
    } else out.push({ address: p.address, bytes: p.bytes });
  }
  if (!out.length) throw new Error("This firmware image holds no bytes to program.");
  const end = out[out.length - 1]!;
  if (end.address + end.bytes.length - 1 > MAX_ADDRESS) throw new Error("This firmware image reaches past a 32-bit address.");
  return out;
}

function fromHex(text: string): ImageSegment[] {
  const parts: ImageSegment[] = [];
  let upper = 0;
  let ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (ended) throw new Error("This HEX file has records after its end.");
    if (!/^:([0-9a-fA-F]{2})+$/.test(line)) throw new Error("This HEX file has a line that is not a record.");
    const bytes = Uint8Array.from(line.slice(1).match(/../g)!.map((h) => parseInt(h, 16)));
    const length = bytes[0]!;
    if (bytes.length !== length + 5) throw new Error("This HEX file has a record of the wrong length.");
    if (bytes.reduce((sum, b) => (sum + b) & 0xff, 0) !== 0) throw new Error("This HEX file has a record whose checksum is wrong.");
    const offset = (bytes[1]! << 8) | bytes[2]!;
    const type = bytes[3]!;
    const data = bytes.slice(4, 4 + length);
    if (type === 0) parts.push({ address: upper + offset, bytes: data });
    else if (type === 1) ended = true;
    else if (type === 2) upper = ((data[0]! << 8) | data[1]!) * 16;
    else if (type === 4) upper = ((data[0]! << 8) | data[1]!) * 0x10000;
    else if (type !== 3 && type !== 5) throw new Error("This HEX file has a record type it cannot program.");
  }
  if (!ended) throw new Error("This HEX file has no end record.");
  return parts;
}

function fromElf(bytes: Uint8Array): ImageSegment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || view.getUint32(0, false) !== 0x7f454c46) throw new Error("This ELF file is not an ELF image.");
  const wide = bytes[4] === 2;
  const little = bytes[5] === 1;
  if (!little) throw new Error("Use a little-endian ELF image.");
  const u16 = (o: number) => view.getUint16(o, true);
  const u32 = (o: number) => view.getUint32(o, true);
  const addr = (o: number) => (wide ? Number(view.getBigUint64(o, true)) : u32(o));
  const phoff = wide ? addr(0x20) : u32(0x1c);
  const phentsize = u16(wide ? 0x36 : 0x2a);
  const phnum = u16(wide ? 0x38 : 0x2c);
  const parts: ImageSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (at + phentsize > bytes.length) throw new Error("This ELF file is cut short.");
    if (u32(at) !== 1) continue; // PT_LOAD only: the rest never reaches the chip
    const offset = wide ? addr(at + 8) : u32(at + 4);
    const paddr = wide ? addr(at + 0x18) : u32(at + 0x0c);
    const filesz = wide ? addr(at + 0x20) : u32(at + 0x10);
    if (!filesz) continue;
    if (offset + filesz > bytes.length) throw new Error("This ELF file is cut short.");
    parts.push({ address: paddr, bytes: bytes.slice(offset, offset + filesz) });
  }
  return parts;
}

function fromUf2(bytes: Uint8Array): ImageSegment[] {
  if (bytes.length % 512 !== 0) throw new Error("This UF2 file is not whole 512-byte blocks.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: ImageSegment[] = [];
  for (let at = 0; at < bytes.length; at += 512) {
    if (view.getUint32(at, true) !== 0x0a324655 || view.getUint32(at + 4, true) !== 0x9e5d5157 || view.getUint32(at + 508, true) !== 0x0ab16f30) {
      throw new Error("This UF2 file has a block that is not UF2.");
    }
    const flags = view.getUint32(at + 8, true);
    if (flags & 0x1) continue; // "not main flash": a comment block
    const target = view.getUint32(at + 12, true);
    const size = view.getUint32(at + 16, true);
    if (size > 476) throw new Error("This UF2 file has a block larger than it can hold.");
    parts.push({ address: target, bytes: bytes.slice(at + 32, at + 32 + size) });
  }
  return parts;
}

/** Where each byte of this image goes. `offset` is where a raw BIN starts;
 *  the other formats carry their own addresses. */
export function imageSegments(bytes: Uint8Array, format: ImageFormat, offset = 0): ImageSegment[] {
  if (format === "bin") {
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_ADDRESS) throw new Error("Give a BIN image a start address.");
    return coalesce([{ address: offset, bytes }]);
  }
  if (format === "hex") return coalesce(fromHex(new TextDecoder().decode(bytes)));
  if (format === "elf") return coalesce(fromElf(bytes));
  return coalesce(fromUf2(bytes));
}

/** One fingerprint for what an image puts on a chip: every range's address,
 *  length and bytes, in address order. The same bytes at the same addresses
 *  give the same hash whatever file format carried them. */
export function imageSha256(segments: readonly ImageSegment[]): string {
  const h = createHash("sha256");
  for (const s of segments) {
    const head = Buffer.alloc(12);
    head.writeBigUInt64BE(BigInt(s.address), 0);
    head.writeUInt32BE(s.bytes.length, 8);
    h.update(head);
    h.update(s.bytes);
  }
  return h.digest("hex");
}

/** The first address where what was read back differs from the image, or null
 *  when every byte matches. */
export function firstMismatch(expected: ImageSegment, read: Uint8Array): number | null {
  if (read.length < expected.bytes.length) return expected.address + read.length;
  for (let i = 0; i < expected.bytes.length; i++) if (read[i] !== expected.bytes[i]) return expected.address + i;
  return null;
}

/** The bytes a per-unit write puts on the chip for this serial: ASCII, padded
 *  with zeros to the declared width. A serial longer than the width is
 *  refused, never cut. */
export function unitWriteBytes(serial: string, length: number): Uint8Array {
  if (!/^[\x20-\x7e]+$/.test(serial)) throw new Error("Write only a plain-text serial to the board.");
  if (serial.length > length) throw new Error(`The serial ${serial} is longer than the ${countOf(length, "byte")} reserved for it on the board.`);
  const out = new Uint8Array(length);
  out.set(new TextEncoder().encode(serial));
  return out;
}
