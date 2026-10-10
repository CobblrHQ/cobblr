export interface FileCost { ms: number; setup: number; collect: number; prepare: number; tests: number; file: string }
export function parseCosts(text: string): FileCost[];
export const REACHES_THE_API: RegExp;
export function reachesTheApi(src: string): boolean;
