// A phone number as people write it ("+1 (555) 010-0123"), in the
// international form a text provider takes (+15550100123). A leading + is
// required: without the country code a number is a guess.

const E164 = /^\+[1-9]\d{6,14}$/;

export function normalisePhone(raw: string): string | null {
  const s = raw.trim().replace(/[\s().-]/g, "");
  return E164.test(s) ? s : null;
}
