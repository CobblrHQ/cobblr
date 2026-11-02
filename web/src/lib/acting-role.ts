// The guest guard lives in @cobblr/platform-web (acting-role.ts), so the shell
// and every module's own client share one role registry (#5190, #5598).
export { GUEST_NOT_SHARED, SUPPORT_READ_ONLY, makesBackgroundWrites, mayRead, refusedForGuest, refusedForSupportSession, rememberRole, roleIn } from "@cobblr/platform-web";
