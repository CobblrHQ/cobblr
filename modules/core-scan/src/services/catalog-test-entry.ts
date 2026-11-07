// Open catalogs hold entries people made to try the catalog out, some of them
// under the barcode of a real product: Open Food Facts answers a Stabilo pen's
// code with "Diagnostic Test Product DELETE ME" (#9304).
//
// The shapes come from a sample of Open Food Facts on 2026-11-07. They match a
// whole name or an instruction to delete it, never one word in a name, because
// the same sample holds Clearblue's "Pregnancy Test", BiotechUSA's "Black test",
// Fruittella's "Dummy" and XXX mints. Missing a test entry leaves today's wrong
// name; refusing a real product leaves a person to name it. So a name in doubt
// stands.

const plain = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** An instruction to the catalog's editors, in any part of a name or brand. */
const EDITOR_NOTE = /\b(?:delete me|to be deleted|a supprimer|ne pas utiliser|do not (?:use|add|buy))\b/;

const TEST_NAME = new RegExp(
  "^(?:" +
    [
      "test",
      "testing",
      "testprodukt",
      "for testing",
      "dev test",
      "example",
      "lorem ipsum",
      "qwerty",
      "producto de prueba",
      "produit de test",
      // "Test Product 2", "Test product API", "My test product". The fixed
      // openers keep out a real "Pregnancy Test Product".
      "(?:my |diagnostic |training supplier )?test(?:ing)? (?:product|produkt|produit|item)\\b.*",
      "(?:some )?example product\\b.*",
      "(?:sample|dummy) product",
      "fake product\\b.*",
    ].join("|") +
    ")$",
);

const TEST_BRAND = new Set(["test brand", "example brand"]);

/** Whether a name alone says it is a test entry. A web page can repeat a
 *  catalog's entry, so this holds for any name offered for a code. */
export function namesATestEntry(name: string | null | undefined): boolean {
  const n = plain(name);
  return !!n && (EDITOR_NOTE.test(n) || TEST_NAME.test(n));
}

/** Whether a catalog's answer is a test entry and not a product. Its brand can
 *  say so when its name does not: "Test Sin Azucares" by "Test Brand". */
export function isCatalogTestEntry(hit: { title?: string | null; brand?: string | null }): boolean {
  if (namesATestEntry(hit.title)) return true;
  const brand = plain(hit.brand);
  // A scan writes a row's name with its brand in front, and a heal reads that row.
  const title = plain(hit.title);
  if (brand && title.startsWith(`${brand} `) && namesATestEntry(title.slice(brand.length + 1))) return true;
  return EDITOR_NOTE.test(brand) || TEST_BRAND.has(brand) || (brand === "dummy" && plain(hit.title) === "dummy");
}
