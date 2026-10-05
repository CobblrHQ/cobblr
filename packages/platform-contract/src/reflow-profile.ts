export interface ReflowPhase { name: "preheat" | "soak" | "reflow" | "cool"; seconds: number; target_c: number }
export interface ReflowProfile {
  name: string;
  phases: ReflowPhase[];
  limits: { ambient_c: number; liquidus_c: number; min_peak_c: number; max_peak_c: number; min_above_liquidus_s: number; max_above_liquidus_s: number; max_ramp_c_per_s: number; max_cool_c_per_s: number; tolerance_c: number; max_gap_s: number };
}
export interface ReflowSample { seconds: number; celsius: number }
const phases = ["preheat", "soak", "reflow", "cool"] as const;
const number = (value: unknown, low: number, high: number, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) throw new Error(`Give a valid ${label} between ${low} and ${high}.`);
  return value;
};
export function parseReflowProfile(value: unknown): ReflowProfile {
  const raw = value as Partial<ReflowProfile> | null;
  if (!raw || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80 || /[\r\n"\\]/.test(raw.name)) throw new Error("Give a profile name without control characters or quotes.");
  if (!Array.isArray(raw.phases) || raw.phases.length !== 4) throw new Error("Provide preheat, soak, reflow and cool phases in that order.");
  const parsed = raw.phases.map((phase, i) => {
    if (!phase || phase.name !== phases[i]) throw new Error("Provide the four phases in preheat, soak, reflow and cool order.");
    return { name: phases[i]!, seconds: number(phase.seconds, 1, 3600, "phase duration in seconds"), target_c: number(phase.target_c, 0, 350, "phase temperature in Celsius") };
  });
  const l = raw.limits;
  if (!l) throw new Error("Record this paste's manufacturer profile limits.");
  const limits = { ambient_c: number(l.ambient_c, 0, 80, "starting temperature"), liquidus_c: number(l.liquidus_c, 20, 330, "liquidus temperature"), min_peak_c: number(l.min_peak_c, 20, 350, "minimum peak"), max_peak_c: number(l.max_peak_c, 20, 350, "maximum peak"), min_above_liquidus_s: number(l.min_above_liquidus_s, 0, 3600, "minimum time above liquidus"), max_above_liquidus_s: number(l.max_above_liquidus_s, 1, 3600, "maximum time above liquidus"), max_ramp_c_per_s: number(l.max_ramp_c_per_s, 0.01, 20, "heating rate"), max_cool_c_per_s: number(l.max_cool_c_per_s, 0.01, 20, "cooling rate"), tolerance_c: number(l.tolerance_c, 0.1, 50, "curve tolerance"), max_gap_s: number(l.max_gap_s, 0.1, 30, "largest sample gap") };
  if (limits.min_peak_c < limits.liquidus_c || limits.max_peak_c < limits.min_peak_c || limits.max_above_liquidus_s < limits.min_above_liquidus_s || parsed[2]!.target_c < limits.min_peak_c || parsed[2]!.target_c > limits.max_peak_c || parsed[1]!.target_c >= limits.liquidus_c || parsed[0]!.target_c > parsed[1]!.target_c || parsed[3]!.target_c >= limits.liquidus_c || limits.ambient_c >= parsed[0]!.target_c || parsed.reduce((n, p) => n + p.seconds, 0) > 7200) throw new Error("The phases and paste limits disagree on the peak, liquidus or timing.");
  return { name: raw.name.trim(), phases: parsed, limits };
}
export function reflowTarget(profile: ReflowProfile, seconds: number): number {
  let time = 0, previous = profile.limits.ambient_c;
  for (const phase of profile.phases) {
    if (seconds <= time + phase.seconds) return previous + (phase.target_c - previous) * Math.max(0, seconds - time) / phase.seconds;
    time += phase.seconds; previous = phase.target_c;
  }
  return previous;
}
export function analyzeReflow(profile: ReflowProfile, samples: ReflowSample[]) {
  if (samples.length < 2 || samples.length > 50000) throw new Error("Provide between two and 50000 observed temperature samples.");
  samples.forEach((sample, i) => { number(sample.seconds, 0, 14400, "sample time"); number(sample.celsius, -20, 400, "sample temperature"); if (i && sample.seconds <= samples[i - 1]!.seconds) throw new Error("Sample times must increase without duplicates."); });
  const problems = new Set<string>(), l = profile.limits;
  const peak_c = Math.max(...samples.map(s => s.celsius));
  let above_liquidus_s = 0;
  if (samples[0]!.seconds > l.max_gap_s) problems.add("The beginning of the curve is missing.");
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!, dt = b.seconds - a.seconds, slope = (b.celsius - a.celsius) / dt;
    if (dt > l.max_gap_s) problems.add("The curve has a sample gap beyond its limit.");
    if (slope > l.max_ramp_c_per_s + 1e-8) problems.add("The heating rate exceeds the paste limit.");
    if (-slope > l.max_cool_c_per_s + 1e-8) problems.add("The cooling rate exceeds the paste limit.");
    if (a.celsius >= l.liquidus_c && b.celsius >= l.liquidus_c) above_liquidus_s += dt;
    else if ((a.celsius >= l.liquidus_c) !== (b.celsius >= l.liquidus_c)) above_liquidus_s += dt * (Math.max(a.celsius, b.celsius) - l.liquidus_c) / Math.abs(b.celsius - a.celsius);
    const knots = profile.phases.map((_, k) => profile.phases.slice(0, k + 1).reduce((sum, phase) => sum + phase.seconds, 0));
    for (const seconds of [a.seconds, b.seconds, ...knots.filter(t => t > a.seconds && t < b.seconds)]) {
      const actual = a.celsius + (b.celsius - a.celsius) * (seconds - a.seconds) / dt;
      if (Math.abs(actual - reflowTarget(profile, seconds)) > l.tolerance_c + 1e-8) problems.add("The measured curve leaves the profile tolerance.");
    }
  }
  if (peak_c < l.min_peak_c || peak_c > l.max_peak_c) problems.add("The peak temperature is outside the paste limits.");
  if (above_liquidus_s < l.min_above_liquidus_s || above_liquidus_s > l.max_above_liquidus_s) problems.add("Time above liquidus is outside the paste limits.");
  const total_s = profile.phases.reduce((n, p) => n + p.seconds, 0), last = samples.at(-1)!;
  if (last.seconds < total_s || last.celsius > profile.phases[3]!.target_c + l.tolerance_c) problems.add("The curve does not show the complete run and cooldown.");
  return { peak_c, above_liquidus_s, duration_s: last.seconds, problems: [...problems], in_spec: problems.size === 0 };
}
export function analyzeManualReflow(profile: ReflowProfile, observed: { peak_c: number; duration_s: number; above_liquidus_s: number }) {
  const peak = number(observed.peak_c, 0, 400, "observed peak"), duration = number(observed.duration_s, 1, 14400, "observed duration"), above = number(observed.above_liquidus_s, 0, duration, "time above liquidus");
  const l = profile.limits, problems: string[] = [];
  if (peak < l.min_peak_c || peak > l.max_peak_c) problems.push("The peak temperature is outside the paste limits.");
  if (above < l.min_above_liquidus_s || above > l.max_above_liquidus_s) problems.push("Time above liquidus is outside the paste limits.");
  if (duration < profile.phases.reduce((n, p) => n + p.seconds, 0)) problems.push("The recorded run is shorter than the profile.");
  return { ...observed, problems, in_spec: problems.length === 0, curve_verified: false };
}
export function yarcProfile(profile: ReflowProfile) {
  if (profile.phases[0]!.target_c !== profile.phases[1]!.target_c) throw new Error("YARC supports one soak plateau. Match the preheat target to the soak target.");
  return { name: profile.name, soakRampRate: String((profile.phases[0]!.target_c - profile.limits.ambient_c) / profile.phases[0]!.seconds), soakTemperature: String(profile.phases[1]!.target_c), soakDuration: String(profile.phases[1]!.seconds), reflowRampRate: String((profile.phases[2]!.target_c - profile.phases[1]!.target_c) / profile.phases[2]!.seconds), reflowTemperature: String(profile.phases[2]!.target_c), reflowDuration: "0" };
}
export function controleoProfile(profile: ReflowProfile) {
  return ["Controleo3", `name "${profile.name}"`, `maximum temperature ${profile.limits.max_peak_c}`, `deviation ${profile.limits.tolerance_c}`, "initialize timer 0", "start timer", ...profile.phases.map(p => p.name === "cool" ? `cooling fan on\nwait until below ${p.target_c}` : `ramp temperature ${p.target_c} ${p.seconds}`), "stop timer", "play beep", ""].join("\n");
}
