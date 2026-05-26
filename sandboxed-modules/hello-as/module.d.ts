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
   * assembly/index/handle
   */
  export function handle(): void;
  /**
   * assembly/index/emit
   */
  export function emit(): void;
  /**
   * assembly/index/notify_self
   */
  export function notify_self(): void;
  /**
   * assembly/index/query_self
   */
  export function query_self(): void;
  /**
   * assembly/index/query_other
   */
  export function query_other(): void;
  /**
   * assembly/index/query_mutate
   */
  export function query_mutate(): void;
  /**
   * assembly/index/pairings_probe
   */
  export function pairings_probe(): void;
  /**
   * assembly/index/catalogs_probe
   */
  export function catalogs_probe(): void;
  /**
   * assembly/index/fetch_blocked
   */
  export function fetch_blocked(): void;
  /**
   * assembly/index/fetch_allowed
   */
  export function fetch_allowed(): void;
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
