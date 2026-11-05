// Mail to someone's own forwarding address that can't be filed is a real receipt
// or order about to vanish. A non-2xx answer makes the mail Worker refuse it during
// delivery, so the sender hears and a forged sender gets no bounce. A signature that
// fails says nothing about which other addresses are real.
export function addressRefusal(reason: "bad_token" | "not_a_member"): { status: number; body: Record<string, unknown>; orgId?: string; userId?: string } {
  return {
    status: 422,
    body: {
      ignored: true,
      reason,
      error: { code: "address_not_recognised", message: "This forwarding address is not in use." },
    },
  };
}
