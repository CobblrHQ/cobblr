import { IndicateInput, PlaceLight, type PlaceIndicateInput, type PlaceLightMapping } from "@cobblr/platform-contract/place-indicate";
import type { AdapterFetch } from "@cobblr/platform-contract/services";

export interface LightPlace { id: string; name?: string; parent_id: string | null; metadata: Record<string, unknown> }
interface Ref { kind: string; id: string }
interface LightContext { orgId: string; connectionId?: string; config?: Readonly<Record<string, string>>; fetch?: AdapterFetch }
interface Source {
  place(org: string, id: string): Promise<LightPlace | null>;
  path(org: string, ref: Ref): Promise<Ref[]>;
  accent(org: string): Promise<string>;
}
interface Active { off: () => Promise<void>; timer: ReturnType<typeof setTimeout> }

export class LightSignals {
  private active = new Map<string, Active>();
  private recent = new Map<string, number[]>();
  private tails = new Map<string, Promise<unknown>>();
  constructor(private source: Source) {}

  async find(org: string, ref: Ref): Promise<{ place: LightPlace; mapping: PlaceLightMapping } | null> {
    const candidates = ref.kind === "core-locations:location" ? [ref] : await this.source.path(org, ref);
    for (const candidate of candidates) {
      if (candidate.kind !== "core-locations:location") continue;
      const seen = new Set<string>();
      let id: string | null = candidate.id;
      while (id && !seen.has(id) && seen.size < 100) {
        seen.add(id);
        const place = await this.source.place(org, id);
        if (!place) break;
        const mapping = PlaceLight.safeParse(place.metadata.light);
        if (mapping.success) return { place, mapping: mapping.data };
        id = place.parent_id;
      }
    }
    return null;
  }

  async indicate(ctx: LightContext, raw: PlaceIndicateInput, driver: PlaceLightMapping["driver"]): Promise<{ indicated: boolean; place: string; color: string; duration: number }> {
    const input = IndicateInput.parse(raw);
    if (!ctx.connectionId || !ctx.fetch) throw new Error("Connect a light first.");
    const key = ctx.connectionId;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(ctx, input, driver));
    this.tails.set(key, next);
    try { return await next; } finally { if (this.tails.get(key) === next) this.tails.delete(key); }
  }

  private async run(ctx: LightContext, input: PlaceIndicateInput, driver: PlaceLightMapping["driver"]) {
    const key = ctx.connectionId!;
    const target = await this.find(ctx.orgId, { kind: "core-locations:location", id: input.place });
    if (!target || target.mapping.connection_id !== key || target.mapping.driver !== driver) throw new Error("This place has no light on this connection. Set its light in the place's settings.");
    const now = Date.now();
    const recent = (this.recent.get(key) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= 20 || recent.some(t => now - t < 1000)) throw new Error("This light is being asked too often. Wait a moment before trying again.");
    recent.push(now); this.recent.set(key, recent);
    const active = this.active.get(key);
    const accent = await this.source.accent(ctx.orgId);
    const color = (input.color ?? (active ? alternate(accent) : accent)).replace(/^#/, "").toUpperCase();
    const configured = Number(ctx.config?.duration || "30");
    const duration = input.duration ?? (Number.isInteger(configured) && configured >= 1 && configured <= 300 ? configured : 30);
    if (active) {
      await active.off();
      clearTimeout(active.timer);
      this.active.delete(key);
    }
    const send = async (off: boolean) => {
      const mapping = target.mapping;
      let path: string, body: unknown;
      if (mapping.driver === "wled") {
        const segments = new Map<number, Array<string | number>>();
        for (const p of mapping.pixels) {
          const values = segments.get(p.segment) ?? [];
          for (let i = 0; i < p.count; i++) values.push(p.led + i, off ? "000000" : color);
          segments.set(p.segment, values);
        }
        path = "/json/state";
        body = { ...(off ? {} : { on: true, bri: 255, transition: 0, nl: { on: true, dur: Math.ceil(duration / 60), mode: 0, tbri: 0 } }), seg: [...segments].map(([id, i]) => ({ id, ...(off ? {} : { on: true, bri: 255 }), i })) };
      } else if (mapping.driver === "esphome") {
        path = "/command";
        body = { command: "light", params: { entity: mapping.entity, state: !off, ...(off ? {} : { rgb: [0, 2, 4].map(i => parseInt(color.slice(i, i + 2), 16)) }), ...(!off && mapping.pixels ? { pixels: mapping.pixels } : {}) } };
      } else {
        path = `/api/services/light/${off ? "turn_off" : "turn_on"}`;
        body = { entity_id: mapping.entity, ...(off ? {} : { rgb_color: [0, 2, 4].map(i => parseInt(color.slice(i, i + 2), 16)) }) };
      }
      let response;
      try {
        response = await ctx.fetch!({ path, method: "POST", body, timeoutMs: 5000, ...(driver === "home-assistant" ? { headers: { authorization: `Bearer ${ctx.config?.token ?? ""}` } } : {}) });
      } catch { throw new Error("The light did not answer. Check its connection and your bridge."); }
      const reply = response.json as { error?: unknown; success?: boolean } | null;
      if (response.status >= 400 || reply?.error || reply?.success === false || (response.json as { ok?: boolean } | null)?.ok === false) throw new Error(`The light did not accept the request (${response.status}).`);
    };
    await send(false);
    const state: Active = { off: () => send(true), timer: setTimeout(() => {
      const prev = this.tails.get(key) ?? Promise.resolve();
      const end = prev.catch(() => undefined).then(async () => {
        if (this.active.get(key) !== state) return;
        try { await state.off(); } finally { this.active.delete(key); }
      });
      this.tails.set(key, end);
      void end.catch(() => undefined).finally(() => { if (this.tails.get(key) === end) this.tails.delete(key); });
    }, duration * 1000) };
    state.timer.unref?.();
    this.active.set(key, state);
    return { indicated: true, place: target.place.id, color, duration };
  }

  dispose(): void { for (const state of this.active.values()) clearTimeout(state.timer); this.active.clear(); this.recent.clear(); }
}

function alternate(accent: string): string {
  const hex = accent.replace(/^#/, "");
  return `#${[0, 2, 4].map(i => (255 - parseInt(hex.slice(i, i + 2), 16)).toString(16).padStart(2, "0")).join("")}`;
}
