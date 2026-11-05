/** How long the operator's View as log and console deletes are kept (#9234). */
export const OPERATOR_LOG_DAYS = 365;

/** The moment before which a row is past its year. */
export function operatorLogCutoff(now: Date, days = OPERATOR_LOG_DAYS): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
