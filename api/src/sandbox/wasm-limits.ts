// Enforce a sandboxed module's linear-memory ceiling.
//
// The manifest declares `max_memory_pages`, but the host does NOT own
// the wasm memory — the module *exports* its own `memory` and the host
// only ever checked the INITIAL size. So a module could declare
// `(memory 1 65536)` (max 4 GiB), pass the initial-size check, then
// `memory.grow()` to gigabytes at runtime and OOM the box. The worker's
// V8 `resourceLimits` don't bound wasm linear memory (it's an off-heap
// ArrayBuffer). (Audit 2026-06-19 finding #2.)
//
// The robust, non-breaking fix: before instantiation, rewrite the
// module's memory section so its declared maximum is clamped to the
// ceiling (and a maximum is INJECTED when the module declares none — the
// common AssemblyScript case). The WebAssembly engine then traps any
// `memory.grow` past the clamped max. Existing exported-memory modules
// keep working unchanged; they just gain a ceiling they never reach.
//
// (The cleaner long-term shape is host-PROVIDED imported memory, but
// that's an ABI break that would brick already-installed modules, so we
// don't take it here.)

/** Decode an unsigned LEB128 starting at `pos`. Uses float arithmetic
 *  (not `<<`) so values wider than 31 bits decode correctly. */
function readVarUint(buf: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let p = pos;
  let bytes = 0;
  for (;;) {
    if (p >= buf.length) throw new Error("unexpected end of input in LEB128");
    const byte = buf[p++]!;
    bytes++;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (bytes > 5) throw new Error("LEB128 value too long");
  }
  return { value: result, next: p };
}

/** Encode an unsigned integer as LEB128. */
function writeVarUint(value: number): number[] {
  if (value < 0 || !Number.isInteger(value)) throw new Error(`cannot encode ${value} as varuint`);
  const out: number[] = [];
  let v = value;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MEMORY_SECTION_ID = 5;

/** Rewrite (or pass through) a wasm binary so its single linear memory's
 *  maximum is at most `ceilingPages`. Throws if:
 *   - the input isn't a wasm module,
 *   - the module's *initial* memory already exceeds the ceiling,
 *   - it uses multi-memory or memory64 (unsupported here — reject rather
 *     than let an un-clampable memory through).
 *  Returns the original bytes untouched when there's nothing to clamp
 *  (no memory section). */
export function clampWasmMemoryMax(wasm: Uint8Array, ceilingPages: number): Uint8Array {
  if (ceilingPages <= 0 || !Number.isInteger(ceilingPages)) {
    throw new Error(`invalid ceilingPages ${ceilingPages}`);
  }
  if (wasm.length < 8 || !WASM_MAGIC.every((b, i) => wasm[i] === b)) {
    throw new Error("not a WebAssembly module (bad magic)");
  }

  let p = 8; // skip magic(4) + version(4)
  while (p < wasm.length) {
    const sectionIdIndex = p;
    const sectionId = wasm[p]!;
    const sizeRes = readVarUint(wasm, p + 1);
    const contentStart = sizeRes.next;
    const contentEnd = contentStart + sizeRes.value;
    if (contentEnd > wasm.length) throw new Error("truncated wasm section");

    if (sectionId === MEMORY_SECTION_ID) {
      return rewriteMemorySection(wasm, sectionIdIndex, contentStart, contentEnd, ceilingPages);
    }
    p = contentEnd;
  }
  // No memory section. Either the module imports its memory (unsupported
  // — the host provides none, so it fails to instantiate) or declares
  // none (worker-entry's `exports.memory` check rejects it). Nothing to
  // clamp here.
  return wasm;
}

function rewriteMemorySection(
  wasm: Uint8Array,
  sectionIdIndex: number,
  contentStart: number,
  contentEnd: number,
  ceilingPages: number,
): Uint8Array {
  let p = contentStart;
  const countRes = readVarUint(wasm, p);
  p = countRes.next;
  if (countRes.value === 0) return wasm; // no memory defined
  if (countRes.value !== 1) {
    throw new Error(`unsupported: module declares ${countRes.value} memories (multi-memory)`);
  }

  const flags = wasm[p]!;
  p++;
  const minRes = readVarUint(wasm, p);
  const min = minRes.value;
  p = minRes.next;

  let hasMax = false;
  let max = 0;
  // flags: 0x00 = min only, 0x01 = min+max, 0x03 = shared + min+max.
  // Anything else (memory64 0x04+, or a bare shared 0x02) we don't
  // support — reject so an un-clampable memory can't slip through.
  if (flags === 0x00) {
    hasMax = false;
  } else if (flags === 0x01 || flags === 0x03) {
    const maxRes = readVarUint(wasm, p);
    max = maxRes.value;
    p = maxRes.next;
    hasMax = true;
  } else {
    throw new Error(`unsupported wasm memory limit flags 0x${flags.toString(16)}`);
  }

  if (min > ceilingPages) {
    throw new Error(`module initial memory ${min} pages exceeds ceiling ${ceilingPages} pages`);
  }

  const newMax = hasMax ? Math.min(max, ceilingPages) : ceilingPages;
  // Already bounded at or below the ceiling → nothing to change.
  if (hasMax && max <= ceilingPages) return wasm;

  const newFlags = flags === 0x03 ? 0x03 : 0x01; // always has-max now; keep shared bit
  const tail = wasm.subarray(p, contentEnd); // anything after the single memtype
  const newContent = [
    ...writeVarUint(1), // memory count
    newFlags,
    ...writeVarUint(min),
    ...writeVarUint(newMax),
    ...tail,
  ];
  const newSizeBytes = writeVarUint(newContent.length);

  const head = wasm.subarray(0, sectionIdIndex);
  const rest = wasm.subarray(contentEnd);
  const out = new Uint8Array(
    head.length + 1 + newSizeBytes.length + newContent.length + rest.length,
  );
  let o = 0;
  out.set(head, o); o += head.length;
  out[o++] = MEMORY_SECTION_ID;
  out.set(newSizeBytes, o); o += newSizeBytes.length;
  out.set(newContent, o); o += newContent.length;
  out.set(rest, o);
  return out;
}
