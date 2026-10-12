import { http, org, type TestSession } from "./helpers.js";

export async function completeMockJob(s: TestSession, id: string): Promise<boolean> {
  // The mock advances by poll count, so queue contention must not decide completion.
  for (let i = 0; i < 8; i++) {
    const { status } = await http<{ status: string }>(s, org(s, `/modules/digifab/jobs/${id}/poll`), {
      method: "POST", body: {},
    });
    if (status === "completed") return true;
    if (status === "failed" || status === "cancelled") return false;
  }
  return false;
}
