// Who an automation can message without naming a person: the two roles a wire
// addresses by what the record is. "Whoever has it" is read off the event that
// fired the wire (the overdue sweep says who the assignee is); a record nobody
// has, or a person with no login to tell, falls through to the household, so
// the louder step never goes to nobody.

export const ASSIGNEE_RECIPIENT = "@assignee";
export const HOUSEHOLD_RECIPIENT = "@household";

export const RECIPIENT_ROLES = [
  { value: ASSIGNEE_RECIPIENT, label: "Whoever it is assigned to (everyone when nobody is)" },
  { value: HOUSEHOLD_RECIPIENT, label: "Everyone in the workspace" },
] as const;

export function isRecipientRole(v: unknown): v is (typeof RECIPIENT_ROLES)[number]["value"] {
  return v === ASSIGNEE_RECIPIENT || v === HOUSEHOLD_RECIPIENT;
}

/** A role as a wire's sentence says it ("tell whoever it is assigned to"). */
export function recipientRoleSaid(role: (typeof RECIPIENT_ROLES)[number]["value"]): string {
  return role === ASSIGNEE_RECIPIENT ? "whoever it is assigned to" : "everyone";
}
