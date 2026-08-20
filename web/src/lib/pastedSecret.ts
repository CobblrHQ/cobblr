/** Clean up what someone actually pasted into a credential field.
 *
 *  A real user setting up Google AI Studio clicked "copy curl quickstart" instead of the
 *  key and pasted the whole command in. That saves silently, then fails at the first scan
 *  with a provider error nobody can read, hours later and far from the cause.
 *
 *  Provider pages put a copy button next to a curl snippet and next to the key, side by
 *  side, so this is a normal mistake rather than a careless one. The key is usually right
 *  there inside the snippet, so pull it out rather than scolding. */

/** Where an API key hides inside a copied snippet, in the order worth trying. */
const IN_SNIPPET: RegExp[] = [
  // Google: -H 'x-goog-api-key: KEY'
  /x-goog-api-key["' :]+\s*([A-Za-z0-9._~+/=-]{16,})/i,
  // OpenAI/Anthropic style: Authorization: Bearer KEY
  /authorization["' :]+\s*bearer\s+([A-Za-z0-9._~+/=-]{16,})/i,
  // Anthropic: -H 'x-api-key: KEY'
  /x-api-key["' :]+\s*([A-Za-z0-9._~+/=-]{16,})/i,
  // Query string: ?key=KEY
  /[?&]key=([A-Za-z0-9._~+/=-]{16,})/i,
];

/** A placeholder is not a key, and pulling one out would be worse than pulling nothing:
 *  it looks like it worked. */
const PLACEHOLDER = /^(YOUR[_-]?API[_-]?KEY|GEMINI_API_KEY|API[_-]?KEY|PASTE[_A-Z]*|<.*>)$/i;

export interface CleanedSecret {
  value: string;
  /** True when a key was recovered from a larger snippet, so the UI can say so. */
  extracted: boolean;
  /** Set when the value is still not usable. */
  problem?: "looks-like-a-command" | "placeholder" | "has-whitespace";
}

export function cleanPastedSecret(raw: string): CleanedSecret {
  const trimmed = raw.trim();
  if (!trimmed) return { value: "", extracted: false };

  // Extraction FIRST, because a pasted URL carrying ?key=... has no whitespace at all and
  // would otherwise sail through the single-token path as if the URL were the key. Each
  // pattern requires a header or parameter name around the value, so a plain key cannot
  // match one by accident.
  for (const re of IN_SNIPPET) {
    const m = trimmed.match(re);
    const found = m?.[1];
    if (found && !PLACEHOLDER.test(found)) return { value: found, extracted: true };
  }

  // A single token with no spaces is the normal case; take it as-is.
  if (!/\s/.test(trimmed)) {
    if (PLACEHOLDER.test(trimmed)) return { value: trimmed, extracted: false, problem: "placeholder" };
    // A bare URL with nothing extractable is not a key either.
    if (/^https?:\/\//i.test(trimmed)) return { value: trimmed, extracted: false, problem: "looks-like-a-command" };
    return { value: trimmed, extracted: false };
  }

  // Multi-line or command-shaped, and nothing recoverable in it.
  const looksLikeCommand = /\bcurl\b|\bhttps?:\/\/|-H\s|--header/i.test(trimmed);
  return {
    value: trimmed,
    extracted: false,
    problem: looksLikeCommand ? "looks-like-a-command" : "has-whitespace",
  };
}

/** What to tell the person, or null when the value is fine. Deliberately not phrased as
 *  a scolding: the two copy buttons sit next to each other. */
export function pastedSecretHint(c: CleanedSecret): string | null {
  if (c.extracted) return "Pulled the key out of the snippet you pasted.";
  switch (c.problem) {
    case "looks-like-a-command":
      return "That looks like a whole command, not a key. Copy just the key itself, usually the long value after the API key label.";
    case "placeholder":
      return "That is the placeholder from the example, not your key.";
    case "has-whitespace":
      return "That has spaces or line breaks in it, so it is probably not just the key.";
    default:
      return null;
  }
}
