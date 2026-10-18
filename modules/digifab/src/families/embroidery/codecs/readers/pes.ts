/** Port of pyembroidery's PesReader. Threads are read from v5/v6 headers; other versions use PEC colors. */
import {
  ByteReader,
  readInt8,
  readInt16le,
  readInt24be,
  readInt32le,
  readString8,
} from "../binary.js";
import { EmbPattern } from "../pattern.js";
import { EmbThread } from "../thread.js";
import { readPec } from "./pec.js";

/** Parses a Brother .pes file. Coordinates are in 0.1 mm. */
export function readPes(bytes: Uint8Array): EmbPattern {
  const pattern = new EmbPattern();
  readPesInto(new ByteReader(bytes), pattern);
  return pattern;
}

export function readPesInto(f: ByteReader, out: EmbPattern): void {
  const loadedThreadValues: EmbThread[] = [];

  const pesString = readString8(f, 8);

  if (pesString === "#PEC0001") {
    readPec(f, out, loadedThreadValues);
    out.convertDuplicateColorChangeToStop();
    return;
  }

  const pecBlockPosition = readInt32le(f);
  if (pecBlockPosition === null) {
    throw new Error("readPes: unexpected end of file reading PEC block offset");
  }

  if (pesString === "#PES0060") {
    readPesHeaderVersion6(f, out, loadedThreadValues);
  } else if (pesString === "#PES0050" || pesString === "#PES0055" || pesString === "#PES0056") {
    readPesHeaderVersion5(f, out, loadedThreadValues);
  } else if (pesString === "#PES0040") {
    readPesHeaderVersion4(f, out);
  }

  f.seek(pecBlockPosition, 0);
  readPec(f, out, loadedThreadValues);
  out.convertDuplicateColorChangeToStop();
}

function readPesString(f: ByteReader): string | null {
  const length = readInt8(f);
  if (length === null || length === 0) return null;
  return readString8(f, length);
}

function readPesMetadata(f: ByteReader, out: EmbPattern): void {
  for (const key of ["name", "category", "author", "keywords", "comments"]) {
    const value = readPesString(f);
    if (value) out.metadata(key, value);
  }
}

function readPesThread(f: ByteReader, threadlist: EmbThread[]): void {
  const thread = new EmbThread();
  thread.catalog_number = readPesString(f);
  const color = readInt24be(f);
  if (color === null) {
    throw new Error("readPes: unexpected end of file reading thread color");
  }
  thread.color = (0xff000000 | color) >>> 0;
  f.seek(5, 1);
  thread.description = readPesString(f);
  thread.brand = readPesString(f);
  thread.chart = readPesString(f);
  threadlist.push(thread);
}

function readPesHeaderVersion4(f: ByteReader, out: EmbPattern): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
}

function readPesHeaderThreads(
  f: ByteReader,
  out: EmbPattern,
  threadlist: EmbThread[],
  imageKey: string
): void {
  const v = readPesString(f);
  if (v !== null && v.length > 0) out.metadata(imageKey, v);
  f.seek(24, 1);
  const countProgrammableFills = readInt16le(f);
  if (countProgrammableFills !== 0) return;
  const countMotifs = readInt16le(f);
  if (countMotifs !== 0) return;
  const countFeatherPatterns = readInt16le(f);
  if (countFeatherPatterns !== 0) return;
  const countThreads = readInt16le(f);
  if (countThreads === null) return;
  for (let i = 0; i < countThreads; i++) {
    readPesThread(f, threadlist);
  }
}

function readPesHeaderVersion5(
  f: ByteReader,
  out: EmbPattern,
  threadlist: EmbThread[]
): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(24, 1);
  readPesHeaderThreads(f, out, threadlist, "image");
}

function readPesHeaderVersion6(
  f: ByteReader,
  out: EmbPattern,
  threadlist: EmbThread[]
): void {
  f.seek(4, 1);
  readPesMetadata(f, out);
  f.seek(36, 1);
  readPesHeaderThreads(f, out, threadlist, "image_file");
}
