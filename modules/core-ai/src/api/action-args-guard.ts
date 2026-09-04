// An action invoked with none of the arguments it declares.
//
// The model picks the right action and drops what it takes: record-usage with
// no hours, remove-field with no field, place with no container. It got more
// common once the rail stopped listing argument names, and the answer is not a
// longer prompt - it is to hand the call back with the names in it.
//
// Pure, and shared: the app's chat loop uses it through validateWrite, and the
// bench's own loop uses it too. Without that sharing the bench measures a path
// the app no longer has, and reports as a model miss something the app would
// have corrected (which is exactly what the 2026-09-04 nightly did).

export interface ArgSpec {
  label?: string;
  type?: string;
}

/** The message to hand back, or null when the call is fine as written. */
export function missingActionArgs(
  actionId: string,
  schema: Record<string, ArgSpec> | null | undefined,
  given: unknown,
): string | null {
  const names = Object.keys(schema ?? {});
  if (names.length === 0) return null;
  const passed = given && typeof given === "object" ? Object.keys(given as Record<string, unknown>) : [];
  if (passed.length > 0) return null;
  const described = names.map((n) => `${n}${schema?.[n]?.label ? ` (${schema[n]!.label})` : ""}`).join(", ");
  return `${actionId} takes arguments and none were given: ${described}. Call invoke_action again with args filled from what the user said, or ask the user for the value you are missing.`;
}
