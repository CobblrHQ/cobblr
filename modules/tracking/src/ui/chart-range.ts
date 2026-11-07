/** The span a chart draws. A loop, not Math.min(...values): spreading a long
 *  history runs out of call stack near 125,000 readings and blanks the page. */
export function chartRange(values: readonly number[], extra: number | null = null): { min: number; max: number } {
  let min = extra ?? Infinity;
  let max = extra ?? -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** A day a person picked, as an instant that reads back as that day where they
 *  are. Today means now, so a reading logged today keeps its order among today's. */
export function instantOfPickedDay(day: string, today: string): string | undefined {
  if (!day || day === today) return undefined;
  return new Date(`${day}T12:00:00`).toISOString();
}
