// WebAssembly is a global in Node 22+ but TypeScript's default
// "ES2022" lib doesn't ship its types — those live in lib.dom.d.ts.
// Pulling DOM in for the whole api workspace is heavy + introduces
// browser globals we don't want. Instead, declare just what the
// sandbox runtime needs.
//
// Keep this in sync with the actual Node WebAssembly API; the
// surface area is tiny.

declare namespace WebAssembly {
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  const Memory: {
    new (descriptor: { initial: number; maximum?: number }): Memory;
  };
  interface Module {}
  const Module: { new (bytes: BufferSource): Module };
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  const Instance: { new (module: Module, imports?: Imports): Instance };
  type ImportValue = ((...args: number[]) => number | void) | Memory | unknown;
  type Imports = Record<string, Record<string, ImportValue>>;
  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(
    moduleOrBytes: Module | BufferSource,
    imports?: Imports,
  ): Promise<Instance | { module: Module; instance: Instance }>;
  type ExportValue = Function | Memory | unknown;
}
