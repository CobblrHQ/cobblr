const permits = new WeakMap<object, string>();
declare const batchStart: unique symbol;
export type BatchStartPermit = { readonly [batchStart]: true };

export function permitBatchStart(jobId: string): BatchStartPermit {
  const permit = {} as BatchStartPermit;
  permits.set(permit, jobId);
  return permit;
}

export function takeBatchStartPermit(permit: BatchStartPermit | undefined, jobId: string): boolean {
  if (!permit || permits.get(permit) !== jobId) return false;
  permits.delete(permit);
  return true;
}
