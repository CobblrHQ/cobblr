// Whether the app asks this person to verify their email: only when their
// address is unverified AND an email can actually reach them. An install with
// no email sender cannot verify anyone, and used to ask its operator to on the
// first screen anyway, with a Resend that sent nothing (#6442). A server that
// predates can_verify_email (undefined) keeps asking, as before.
export function asksToVerifyEmail(user: { email_verified?: boolean; can_verify_email?: boolean } | null | undefined): boolean {
  return !!user && user.email_verified === false && user.can_verify_email !== false;
}
