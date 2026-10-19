export interface TidyRecord { kind: string; id: string; name: string; url?: string }
export interface TidyCandidate {
  id: string;
  kind: string;
  records: TidyRecord[];
  action: { route: string; bundle_id?: string; action_id?: string; args?: Record<string, unknown>; steps?: Array<{ action_id: string; args: Record<string, unknown> }> };
  why: string;
  priority: number;
}
export interface TidyFinderContext {
  orgId: string;
  now: Date;
  lastRun: Date | null;
  shapeChanged: boolean;
  as: { userId: string; orgSlug: string };
  memo<T>(key: string, fingerprint: string, compute: () => Promise<T>): Promise<T>;
  classify(item: Record<string, unknown>, collections: Array<{ name: string; label: string; noun: string }>): Promise<string | null>;
}
export interface PlatformTidy {
  registerFinder(finder: { id: string; module?: string; find(ctx: TidyFinderContext): Promise<TidyCandidate[]> }): void;
}
