// How long a driver waits on a manager before giving up. A request with no
// timeout waits forever on a manager that has stopped answering, and the poll
// worker waits with it (#4031: FDM Monster). Every driver fetch carries one
// of these; lint:driver-fetch-has-timeout holds it.

/** A status read, a command, a login. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Sending a file, which can be tens of megabytes over a slow LAN. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export const requestSignal = (): AbortSignal => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
export const uploadSignal = (): AbortSignal => AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
