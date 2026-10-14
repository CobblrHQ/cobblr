import { expect } from "vitest";
import { http, org, type TestSession } from "./helpers.js";

export async function untouchedAssets(s: TestSession, shape: "fresh" | "volume") {
  const count = shape === "volume" ? 120 : 1;
  const ids = new Set<string>();
  for (let n = 0; n < count; n++) {
    const made = await http<{ id: string }>(s, org(s, "/modules/assets/assets"), {
      method: "POST", body: { name: `Unrelated asset ${n}`, serial_number: `untouched-${n}`, metadata: { finish: "original" } },
    });
    ids.add(made.id);
  }
  const read = async () => (await http<{ items: Array<{ id: string }> }>(s, org(s, "/modules/assets/assets?limit=200"))).items.filter((i) => ids.has(i.id));
  const before = await read();
  expect(before).toHaveLength(count);
  return async () => expect(await read(), "the action changed an unrelated asset").toEqual(before);
}
