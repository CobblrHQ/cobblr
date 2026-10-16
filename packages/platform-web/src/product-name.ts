let name = "Cobblr"; // PRODUCT-NAME: The engine default for hosts that have not supplied their server's name.

/** Set from /auth/config before loading the shell and its page definitions. */
export function configureProductName(value: string | null | undefined): void {
  name = value?.trim() || "Cobblr"; // PRODUCT-NAME: Servers predating product_name use the engine's default.
}

export function productName(): string {
  return name;
}
