// Worker-thread entry for a sandboxed wasm module.
//
// One worker per (workspace, module). The worker owns the wasm
// Instance for its lifetime; the main thread sends "invoke"
// messages, the worker runs the wasm export, the worker posts
// "result" back. If a hostile module spins forever in a wasm loop,
// the main thread calls worker.terminate() and a fresh worker is
// spun up for the next request.
//
// Communication shape:
//   main → worker: { type: "invoke", id, exportName }
//   worker → main:
//     { type: "log",        id, level, message }    // fire-and-forget
//     { type: "kernel",     id, op, args }          // fire-and-forget (write ops)
//     { type: "kernel-sync",id, op, args }          // read ops; worker blocks on SAB
//     { type: "result",     id, logs, kernelCalls, ok, error? }
//
// Read-bearing ops use a SharedArrayBuffer the worker + main thread
// both view. Worker posts "kernel-sync" + Atomics.wait on the
// signal slot; main thread performs the call, writes the JSON
// response into the SAB, Atomics.notify. The worker resumes, copies
// the bytes into wasm memory via the wasm's __alloc export, returns
// a response_id to the wasm. The wasm reads ptr/len via
// host_call_response_ptr/len, then frees via host_call_response_free.

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import {
  SAB_DATA_OFFSET_BYTES,
  SAB_LENGTH_OFFSET,
  SAB_SIGNAL_OFFSET,
  SAB_STATUS_PENDING,
  SAB_STATUS_READY,
  SAB_STATUS_TOO_BIG,
} from "./abi.js";

if (!parentPort) {
  throw new Error("worker-entry must be loaded as a worker_thread");
}
const port = parentPort;

interface WorkerInit {
  wasmPath: string;
  moduleName: string;
  maxMemoryPages: number;
  /** SAB shared with the main thread for read-bearing kernel calls. */
  sab: SharedArrayBuffer;
  /** Set of op codes that return data (read-bearing). Anything not
   *  in this set is fire-and-forget. Allows the worker to pick the
   *  right wire shape without re-encoding the ABI here. */
  readBearingOps: number[];
}

const init = workerData as WorkerInit;
const readBearing = new Set(init.readBearingOps);
const sigView = new Int32Array(init.sab);
const dataView = new Uint8Array(init.sab, SAB_DATA_OFFSET_BYTES);

let currentId: string | null = null;
let currentLogs: Array<{ level: number; message: string }> = [];
let currentKernelCalls = 0;
let memory: WebAssembly.Memory | null = null;
let alloc: ((size: number) => number) | null = null;

const decoder = new TextDecoder();

function readString(ptr: number, len: number): string {
  if (!memory) throw new Error("memory accessed before instantiate");
  const view = new Uint8Array(memory.buffer);
  if (ptr < 0 || len < 0 || ptr + len > view.length) {
    throw new Error(`out-of-bounds read ptr=${ptr} len=${len}`);
  }
  return decoder.decode(view.subarray(ptr, ptr + len));
}

/** AssemblyScript's runtime stores strings as UTF-16LE with a 4-byte
 *  little-endian length prefix immediately before the data pointer.
 *  env.abort gets the data pointer; we read length back from -4 then
 *  decode the UTF-16 region. Used by the env.abort stub only. */
function safeReadStringWithLength(lengthSlot: number): string {
  if (!memory) return "(memory unavailable)";
  const view = new DataView(memory.buffer);
  if (lengthSlot < 0 || lengthSlot + 4 > view.byteLength) return "(out-of-bounds length slot)";
  const byteLen = view.getUint32(lengthSlot, true);
  if (byteLen === 0) return "";
  const dataStart = lengthSlot + 4;
  if (dataStart + byteLen > view.byteLength) return "(out-of-bounds data)";
  return new TextDecoder("utf-16le").decode(
    new Uint8Array(memory.buffer, dataStart, byteLen),
  );
}

/** Response-id table for host_platform_call read ops. The wasm
 *  receives an id; the host stores { ptr, len } for that id and the
 *  wasm later reads via host_call_response_ptr/len, then frees. */
const responses = new Map<number, { ptr: number; len: number }>();
let nextResponseId = 1;

const imports = {
  env: {
    abort: (msgPtr: number, _filePtr: number, line: number, col: number) => {
      const msg = msgPtr > 0 ? safeReadStringWithLength(msgPtr - 4) : "(no message)";
      const summary = `wasm abort at ${line}:${col}: ${msg}`;
      currentLogs.push({ level: 3, message: summary });
      port.postMessage({ type: "log", id: currentId, level: 3, message: summary });
      throw new Error(summary);
    },
    seed: () => Date.now() * Math.random(),
    trace: (_msgPtr: number, _n: number) => {},
  },
  host: {
    host_log: (level: number, ptr: number, len: number) => {
      const message = readString(ptr, len);
      currentLogs.push({ level, message });
      port.postMessage({ type: "log", id: currentId, level, message });
    },
    host_platform_call: (op: number, argsPtr: number, argsLen: number): number => {
      currentKernelCalls++;
      let args: unknown = null;
      if (argsLen > 0) {
        try {
          args = JSON.parse(readString(argsPtr, argsLen));
        } catch (err) {
          port.postMessage({
            type: "log",
            id: currentId,
            level: 3,
            message: `op ${op}: bad JSON args (${(err as Error).message})`,
          });
          return 0;
        }
      }
      if (!readBearing.has(op)) {
        // Fire-and-forget: post + return.
        port.postMessage({ type: "kernel", id: currentId, op, args });
        return 0;
      }
      // Read-bearing path: block synchronously on SAB.
      Atomics.store(sigView, SAB_SIGNAL_OFFSET, SAB_STATUS_PENDING);
      port.postMessage({ type: "kernel-sync", id: currentId, op, args });
      // Atomics.wait blocks the worker thread until the main thread
      // writes a non-pending status. Returns "ok" (woken), "not-equal"
      // (status already changed), or "timed-out". No timeout = block
      // forever; the main thread's deadline timer is the upper bound.
      Atomics.wait(sigView, SAB_SIGNAL_OFFSET, SAB_STATUS_PENDING);
      const status = Atomics.load(sigView, SAB_SIGNAL_OFFSET);
      if (status !== SAB_STATUS_READY) {
        if (status === SAB_STATUS_TOO_BIG) {
          port.postMessage({
            type: "log",
            id: currentId,
            level: 2,
            message: `op ${op}: response too large for SAB`,
          });
        }
        return 0;
      }
      const len = Atomics.load(sigView, SAB_LENGTH_OFFSET);
      if (len === 0) return 0; // success with empty payload
      if (!alloc) {
        port.postMessage({
          type: "log",
          id: currentId,
          level: 3,
          message: `op ${op}: module lacks __alloc export — required for read ops`,
        });
        return 0;
      }
      const wasmPtr = alloc(len);
      // __new / cobblr_alloc may grow wasm linear memory; the OLD
      // memory.buffer reference detaches when growth happens.
      // Re-acquire memory.buffer here through the getter (which
      // returns the current backing store) instead of caching.
      const dst = new Uint8Array(memory!.buffer, wasmPtr, len);
      dst.set(dataView.subarray(0, len));
      const id = nextResponseId++;
      responses.set(id, { ptr: wasmPtr, len });
      return id;
    },
    host_call_response_ptr: (id: number) => responses.get(id)?.ptr ?? 0,
    host_call_response_len: (id: number) => responses.get(id)?.len ?? 0,
    host_call_response_free: (id: number) => {
      responses.delete(id);
    },
  },
};

const wasmBytes = readFileSync(init.wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
const instance = new WebAssembly.Instance(wasmModule, imports);
const exports = instance.exports as Record<string, unknown>;
if (!exports.memory) {
  throw new Error(`sandboxed module ${init.moduleName} must export 'memory'`);
}
memory = exports.memory as WebAssembly.Memory;
// Allocator probe. Preference order:
//   1. cobblr_alloc — exported by @cobblr/sandbox-sdk-as; allocates
//      an ArrayBuffer + __pin's it so AS's GC doesn't reclaim it
//      between the host writing + the SDK reading.
//   2. __alloc — convention for hand-rolled WAT modules.
//   3. __new(size, id=0) — fall back to AS's default; works for
//      small responses where GC pressure is low.
const cobblrAllocFn = exports.cobblr_alloc;
const cobblrAlloc = exports.__alloc;
const asNew = exports.__new;
if (typeof cobblrAllocFn === "function") {
  alloc = cobblrAllocFn as (s: number) => number;
} else if (typeof cobblrAlloc === "function") {
  alloc = cobblrAlloc as (s: number) => number;
} else if (typeof asNew === "function") {
  alloc = (size: number) => (asNew as (s: number, id: number) => number)(size, 0);
} else {
  alloc = null;
}

const memoryAny = memory as unknown as { buffer: ArrayBuffer };
const declaredCeilingBytes = init.maxMemoryPages * 65536;
if (memoryAny.buffer.byteLength > declaredCeilingBytes) {
  throw new Error(
    `${init.moduleName}: initial memory ${memoryAny.buffer.byteLength}B exceeds manifest ceiling ${declaredCeilingBytes}B`,
  );
}

port.on("message", (msg: unknown) => {
  const m = msg as { type: string; id: string; exportName: string };
  if (m.type !== "invoke") return;
  currentId = m.id;
  currentLogs = [];
  currentKernelCalls = 0;
  responses.clear();
  try {
    const fn = exports[m.exportName];
    if (typeof fn !== "function") {
      port.postMessage({
        type: "result",
        id: m.id,
        logs: currentLogs,
        kernelCalls: currentKernelCalls,
        ok: false,
        error: `export ${m.exportName} not a function`,
      });
      return;
    }
    (fn as () => void)();
    port.postMessage({
      type: "result",
      id: m.id,
      logs: currentLogs,
      kernelCalls: currentKernelCalls,
      ok: true,
    });
  } catch (err) {
    port.postMessage({
      type: "result",
      id: m.id,
      logs: currentLogs,
      kernelCalls: currentKernelCalls,
      ok: false,
      error: (err as Error).message ?? String(err),
    });
  }
});

port.postMessage({ type: "ready" });
