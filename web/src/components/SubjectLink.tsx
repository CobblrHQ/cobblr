// The web app's SubjectLink: the shared one (@cobblr/platform-web), told the
// workspace the person is in, which this app knows from its own auth context.
import type { ReactNode } from "react";
import { SubjectLink as Shared } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export { subjectRoute } from "@cobblr/platform-web";

export function SubjectLink(props: { href: string; children: ReactNode; className?: string; testId?: string }) {
  const { activeSlug } = useActiveOrg();
  return <Shared {...props} activeSlug={activeSlug} />;
}
