// The order a list of choices is shown in: by the size it names, then by text.
//
// A text sort put "10.0 mm" between "1.5 mm" and "2.0 mm" in the hook gauge
// picker (#5886): to a person picking a size, a list of sizes runs small to
// large. A choice's size is the first quantity in it: a decimal ("2.5 mm",
// "0.25 in"), a fraction ("3/8"), or a whole and a fraction ("1 1/2 in").
// Choices that name a size come first, smallest up; the rest follow by text,
// with any digits in them read as numbers ("Size 9" before "Size 10").
// Every choice list sorts through compareChoices
// (capability choices:sort-by-size).

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const QUANTITY = /(\d+)\s+(\d+)\s*\/\s*(\d+)|(\d+)\s*\/\s*(\d+)|(\d*\.\d+|\d+)/;

/** The first quantity a choice names, or null when it names none. */
export function choiceQuantity(choice: string): number | null {
  const m = QUANTITY.exec(choice);
  if (!m) return null;
  if (m[1] !== undefined) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  if (m[4] !== undefined) return Number(m[5]) === 0 ? null : Number(m[4]) / Number(m[5]);
  return Number(m[6]);
}

/** Two choices in the order a person reads them: by size, then by text. */
export function compareChoices(a: string, b: string): number {
  const qa = choiceQuantity(a);
  const qb = choiceQuantity(b);
  if (qa !== null && qb !== null && qa !== qb) return qa - qb;
  if (qa !== null && qb === null) return -1;
  if (qa === null && qb !== null) return 1;
  return collator.compare(a, b);
}
