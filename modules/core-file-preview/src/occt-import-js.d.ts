// occt-import-js ships no TypeScript types. Declare the slice we use: the
// Emscripten module factory and the Step/Brep/Iges readers, plus the Vite
// `?url` import for its WASM binary (loaded at runtime by the renderer).
declare module "occt-import-js" {
  export interface OcctMesh {
    name?: string;
    color?: number[];
    attributes: {
      position: { array: number[] };
      normal?: { array: number[] };
    };
    index: { array: number[] };
  }
  export interface OcctResult {
    success: boolean;
    root: unknown;
    meshes: OcctMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
    ReadBrepFile(content: Uint8Array, params: unknown): OcctResult;
    ReadIgesFile(content: Uint8Array, params: unknown): OcctResult;
  }
  export type OcctFactory = (opts?: {
    locateFile?: (path: string) => string;
  }) => Promise<OcctModule>;
  const factory: OcctFactory;
  export default factory;
}

declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  const url: string;
  export default url;
}
