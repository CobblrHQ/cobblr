// What this server calls itself in the words its people read. One engine runs
// more than one product (docs/design-decisions/one-engine-two-products.md): a
// second product's owner must not be mailed "Reset your Cobblr password" (#6815).
// lint:product-name-not-hard-coded keeps the literal out of new strings.
//
// It reads the one variable itself rather than through ../env.js: pure modules
// (the calendar feed, the From rule, the push title) import this, and loading
// env.ts would make every one of their tests stand up the whole environment.
// env.ts still declares COBBLR_PRODUCT_NAME, so the server's schema lists it.

export function productName(): string {
  return (process.env.COBBLR_PRODUCT_NAME || "").trim() || "Cobblr";
}
