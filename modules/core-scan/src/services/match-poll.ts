// When the intake's detached match looks at a row for its name (#6555).
//
// A barcode is usually named before the intake request even answers, and a
// photo's identify lands within seconds, so the first look is at once and the
// next ones are close together; only a slow identify (a cold provider, the
// photo wire) is waited for at the old 3 s pace, for about two minutes in all.
// The schedule used to be a 3 s sleep before every look, the first included:
// every scan's table arrived at least 3 s after its name, with or without a
// model (the owner's "under the 1s benchmark", measured at 3.3 s on a
// workspace with no AI).
export function enrichmentPollDelays(): number[] {
  const quick = [0, 100, 150, 200, 250, 300, 500, 750, 1_000, 1_500, 2_000];
  const spent = quick.reduce((a, b) => a + b, 0);
  const slow = Math.ceil((120_000 - spent) / 3_000);
  return [...quick, ...Array.from({ length: slow }, () => 3_000)];
}
