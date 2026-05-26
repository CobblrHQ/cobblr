declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  // Exported runtime interface
  export function __new(size: number, id: number): number;
  export function __pin(ptr: number): number;
  export function __unpin(ptr: number): void;
  export function __collect(): void;
  export const __rtti_base: number;
  /**
   * assembly/index/add
   */
  export function add(): void;
  /**
   * assembly/index/list
   */
  export function list(): void;
  /**
   * assembly/index/refresh_all
   */
  export function refresh_all(): void;
  /**
   * assembly/index/clear
   */
  export function clear(): void;
  /**
   * assembly/sdk/cobblr_alloc
   * @param size `i32`
   * @returns `i32`
   */
  export function cobblr_alloc(size: number): number;
  /**
   * assembly/sdk/cobblr_dealloc
   * @param ptr `i32`
   */
  export function cobblr_dealloc(ptr: number): void;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
  host: unknown,
}): Promise<typeof __AdaptedExports>;
