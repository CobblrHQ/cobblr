import { countOf, quantityWithUnit } from "@cobblr/platform-contract";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { NumberField, SearchInput, usePageTitle, useRunAction } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
const button =
  "inline-flex min-h-11 items-center justify-center rounded border border-line px-4 py-2 disabled:opacity-50";
const control =
  "block min-h-11 w-full rounded border border-line bg-surface px-3 py-2";
const panel = "min-w-0 rounded-lg border border-line bg-surface p-4 space-y-3";
const formats = ["pes", "dst", "exp", "jef", "vp3"];
type Hoop = {
  name: string;
  width_mm: number;
  height_mm: number;
};
type Config = {
  label: string;
  hoops: Hoop[];
  formats: string[];
  stitches_per_minute: number;
  filename_prefix: string;
  asset_ref: {
    kind: string;
    id: string;
  } | null;
};
type Machine = {
  id: string;
  config: Config;
};
type Stop = {
  index: number;
  color: string | null;
  brand: string;
  code: string;
  name: string;
  estimated_m: number;
  stitches: number;
};
type Summary = {
  width_mm: number;
  height_mm: number;
  x_mm: number;
  y_mm: number;
  stitch_count: number;
  colour_changes: number;
  estimated_minutes: number;
  stops: Stop[];
  paths: {
    color: string;
    points: [number, number][];
  }[];
};
type Design = {
  id: string;
  name: string;
  summary: Summary;
};
type Spool = {
  id: string;
  name: string;
  color: string | null;
  brand: string;
  code: string;
  remaining: number;
  unit: string;
};
type Report = {
  verdict: "good" | "scrap";
  finished: boolean;
  idle_confirmed: true;
  needle_up_confirmed: true;
  usage: {
    index: number;
    metres: number;
  }[];
};
type Run = {
  job_id: string;
  started_at: string | null;
  consumed_at: string | null;
  interrupted: boolean;
  report: Report | null;
  plan: {
    filename: string;
    file_id: string;
    hoop: Hoop;
    checklist: string[];
    summary: Summary;
    threads: Record<string, Spool>;
  };
};
type Page<T> = {
  items: T[];
  total: number;
  complete: boolean;
};
const freshConfig = (): Config => ({
  label: "",
  hoops: [{ name: "Main hoop", width_mm: 100, height_mm: 100 }],
  formats: ["pes"],
  stitches_per_minute: 600,
  filename_prefix: "EMB",
  asset_ref: null,
});
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function EmbroideryPreview({ summary }: { summary: Summary }) {
  const width = Math.max(1, summary.width_mm),
    height = Math.max(1, summary.height_mm);
  return (
    <svg
      role="img"
      aria-label="Embroidery stitch preview"
      className="w-full max-h-80 rounded border border-line bg-surface"
      viewBox={`${summary.x_mm - 2} ${summary.y_mm - 2} ${width + 4} ${height + 4}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {summary.paths.map((path, i) => (
        <polyline
          key={i}
          points={path.points.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={path.color}
          strokeWidth={0.2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
function SummaryView({ summary }: { summary: Summary }) {
  return (
    <>
      <EmbroideryPreview summary={summary} />
      <p>
        {summary.width_mm.toFixed(1)} × {summary.height_mm.toFixed(1)} mm ·{" "}
        {summary.stitch_count.toLocaleString()} stitches ·{" "}
        {countOf(summary.colour_changes, "colour change")}
      </p>
      <p className="text-sm text-muted">
        About {summary.estimated_minutes} minutes at the saved stitch speed.
        Time and thread lengths are estimates.
      </p>
    </>
  );
}
export function EmbroideryPage() {
  const { activeSlug: slug, activeOrg } = useActiveOrg();
  usePageTitle("Embroidery");
  // PRESS-ARGS: The machine, design, thread mapping and station checklist supply the operation's inputs before confirmation.
  const runAction = useRunAction();
  const admin = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  const [assetSearch, setAssetSearch] = useState("");
  const assets = useQuery({
    queryKey: ["embroidery-assets", slug, assetSearch],
    queryFn: () => api.listEntities(slug, "assets:asset", assetSearch),
    enabled: admin,
  });
  const [chartQuery, setChartQuery] = useState("");
  const [chartBrand, setChartBrand] = useState("");
  const [chartOffset, setChartOffset] = useState(0);
  const chart = useQuery({
    queryKey: ["embroidery-chart", slug, chartQuery, chartBrand, chartOffset],
    queryFn: () =>
      api.embroideryList<
        Page<{ brand: string; code: string; color: string; name: string }> & {
          brands: string[];
        }
      >(
        slug,
        `chart?limit=20&offset=${chartOffset}&q=${encodeURIComponent(chartQuery)}&brand=${encodeURIComponent(chartBrand)}`,
      ),
  });
  const [machineId, setMachineId] = useState("");
  const [designId, setDesignId] = useState("");
  const [hoop, setHoop] = useState("");
  const [format, setFormat] = useState("pes");
  const [config, setConfig] = useState<Config>(freshConfig);
  const [editing, setEditing] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [selectedSpools, setSelectedSpools] = useState<Record<string, Spool>>(
    {},
  );
  const [machineOffset, setMachineOffset] = useState(0),
    [designOffset, setDesignOffset] = useState(0),
    [spoolOffset, setSpoolOffset] = useState(0),
    [stockSearch, setStockSearch] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [stationVersion, setStationVersion] = useState(0);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [usage, setUsage] = useState<Record<string, string>>({});
  const [verdict, setVerdict] = useState<"good" | "scrap">("good"),
    [finished, setFinished] = useState(true),
    [idle, setIdle] = useState(false),
    [needleUp, setNeedleUp] = useState(false);
  const key = `cobblr.embroidery-station.${slug}.${machineId}`,
    saved = localStorage.getItem(key);
  let station: {
    id: string;
    token: string;
  } | null = null;
  try {
    station = saved ? JSON.parse(saved) : null;
  } catch {
    /* A damaged local credential is treated as unenrolled. */
  }
  const machines = useQuery({
    queryKey: ["embroidery-machines", slug, machineOffset],
    queryFn: () =>
      api.embroideryList<Page<Machine>>(
        slug,
        `machines?limit=20&offset=${machineOffset}`,
      ),
  });
  const designs = useQuery({
    queryKey: ["embroidery-designs", slug, designOffset],
    queryFn: () =>
      api.embroideryList<Page<Design>>(
        slug,
        `designs?limit=20&offset=${designOffset}`,
      ),
  });
  const spools = useQuery({
    queryKey: ["embroidery-spools", slug, spoolOffset, stockSearch, designId],
    queryFn: () =>
      api.embroideryList<
        Page<Spool> & {
          suggestions: {
            index: number;
            threads: {
              spool: Spool;
              exact: boolean;
              distance: number | null;
            }[];
          }[];
        }
      >(
        slug,
        `spools?limit=20&offset=${spoolOffset}&q=${encodeURIComponent(stockSearch)}${designId ? `&design_id=${designId}` : ""}`,
      ),
  });
  const runs = useQuery({
    queryKey: ["embroidery-runs", slug, machineId],
    queryFn: () =>
      api.embroideryList<Page<Run>>(
        slug,
        `runs?machine_id=${machineId}&limit=20&offset=0`,
      ),
    enabled: !!machineId,
    refetchInterval: 10000,
  });
  const [stationOffset, setStationOffset] = useState(0);
  const currentStation = useQuery({
    queryKey: [
      "embroidery-current-station",
      slug,
      machineId,
      station?.id,
      stationVersion,
    ],
    queryFn: () =>
      api.embroideryList<Page<{ id: string; revoked_at: string | null }>>(
        slug,
        `machines/${machineId}/stations?limit=20&offset=0&q=${encodeURIComponent(station!.id)}`,
      ),
    enabled: !!machineId && !!station && admin,
  });
  const stations = useQuery({
    queryKey: [
      "embroidery-stations",
      slug,
      machineId,
      stationVersion,
      stationOffset,
    ],
    queryFn: () =>
      api.embroideryList<
        Page<{
          id: string;
          label: string;
          revoked_at: string | null;
        }>
      >(
        slug,
        `machines/${machineId}/stations?limit=20&offset=${stationOffset}`,
      ),
    enabled: !!machineId && admin,
  });
  const machine = machines.data?.items.find((m) => m.id === machineId),
    design = designs.data?.items.find((d) => d.id === designId),
    pending = runs.data?.items.find((r) => !r.consumed_at);
  const linkedAsset = useQuery({
    queryKey: ["embroidery-linked-asset", slug, machine?.config.asset_ref],
    queryFn: () =>
      api.lookupEntity(
        slug,
        machine!.config.asset_ref!.kind,
        machine!.config.asset_ref!.id,
      ),
    enabled: !!machine?.config.asset_ref,
  });
  const authorized =
    !!station &&
    !!currentStation.data?.items.some(
      (s) => s.id === station?.id && !s.revoked_at,
    );
  const selectedHoop = machine?.config.hoops.find((h) => h.name === hoop),
    tooLarge =
      !!design &&
      !!selectedHoop &&
      (design.summary.width_mm > selectedHoop.width_mm ||
        design.summary.height_mm > selectedHoop.height_mm);
  const missing =
    design?.summary.stops.filter((s) => !mapping[String(s.index)]) ?? [];
  const selectMachine = (id: string) => {
    setMachineId(id);
    setStationOffset(0);
    const m = machines.data?.items.find((v) => v.id === id);
    setHoop(m?.config.hoops[0]?.name ?? "");
    setFormat(m?.config.formats[0] ?? "pes");
    setChecks({});
    setUsage({});
    setIdle(false);
    setNeedleUp(false);
    setVerdict("good");
  };
  const refresh = async () => {
    await Promise.all([
      machines.refetch(),
      designs.refetch(),
      spools.refetch(),
      runs.refetch(),
      stations.refetch(),
      ...(station ? [currentStation.refetch()] : []),
    ]);
  };
  const perform = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(success);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const mutate = (operation: string, id: string | undefined, fields: unknown) =>
    runAction({
      actionId: "digifab:embroidery-job",
      args: { operation, id, fields },
    });
  const chooseThread = (index: number, id: string) => {
    setMapping((v) => ({ ...v, [index]: id }));
    const spool =
      spools.data?.items.find((s) => s.id === id) ?? selectedSpools[id];
    if (spool) setSelectedSpools((v) => ({ ...v, [id]: spool }));
  };
  const pageButtons = (
    offset: number,
    total: number | undefined,
    set: (n: number) => void,
  ) => (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={button}
        disabled={offset === 0 || busy}
        onClick={() => set(Math.max(0, offset - 20))}
      >
        Previous
      </button>
      <p>
        {offset + 1} to {Math.min(offset + 20, total ?? 0)} of {total ?? 0}
      </p>
      <button
        type="button"
        className={button}
        disabled={offset + 20 >= (total ?? 0) || busy}
        onClick={() => set(offset + 20)}
      >
        Next
      </button>
    </div>
  );
  return (
    <div className="p-4 sm:p-6 space-y-6" data-testid="embroidery-page">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Embroidery</h1>
          <p className="text-muted">
            Check hoops and threads, export to USB, and record what you used.
          </p>
        </div>
        <Link className={button} to="/digifab">
          Fleet and setup
        </Link>
      </header>
      {(error || machines.error || designs.error || runs.error) && (
        <p role="alert" className={`${panel} border-red-500 break-words`}>
          {error || message(machines.error || designs.error || runs.error)}
        </p>
      )}
      {notice && (
        <p role="status" className={panel}>
          {notice}
        </p>
      )}
      <section className={panel}>
        <h2 className="text-sm font-semibold">Machine and hoop</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <label>
            Machine
            <select
              className={control}
              value={machineId}
              onChange={(e) => selectMachine(e.target.value)}
            >
              <option value="">Choose a machine</option>
              {machines.data?.items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.config.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hoop
            <select
              className={control}
              value={hoop}
              disabled={!machine || !!pending}
              onChange={(e) => setHoop(e.target.value)}
            >
              <option value="">Choose a hoop</option>
              {machine?.config.hoops.map((h) => (
                <option key={h.name} value={h.name}>
                  {h.name} · {h.width_mm} × {h.height_mm} mm
                </option>
              ))}
            </select>
          </label>
          <label>
            Machine file format
            <select
              className={control}
              value={format}
              disabled={!machine || !!pending}
              onChange={(e) => setFormat(e.target.value)}
            >
              {(machine?.config.formats ?? formats).map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(machines.data?.total ?? 0) > 20 &&
          pageButtons(machineOffset, machines.data?.total, setMachineOffset)}
        {!machines.isLoading && !machines.data?.total && (
          <p>No embroidery machines saved yet.</p>
        )}
        {admin && (
          <div className="flex flex-wrap gap-3">
            <button
              className={button}
              onClick={() => {
                setEditing(null);
                setConfig(freshConfig());
                setShowSetup(true);
              }}
            >
              Add machine
            </button>
            {machine && (
              <button
                className={button}
                disabled={!!pending}
                onClick={() => {
                  setEditing(machine.id);
                  setConfig(machine.config);
                  setShowSetup(true);
                }}
              >
                Edit machine
              </button>
            )}
          </div>
        )}
        {machine?.config.asset_ref && (
          <Link
            className={button}
            to={linkedAsset.data?.detailUrl ?? "/instances/sewing-machines"}
          >
            Open maintained asset
          </Link>
        )}
        {showSetup && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await mutate(
                  editing ? "update_machine" : "create_machine",
                  editing ?? undefined,
                  config,
                );
                setShowSetup(false);
              }, "Machine settings saved.");
            }}
          >
            <label>
              Machine name
              <input
                className={control}
                required
                maxLength={100}
                value={config.label}
                onChange={(e) =>
                  setConfig({ ...config, label: e.target.value })
                }
              />
            </label>
            <label>
              Find maintained asset
              <SearchInput
                size="lg"
                aria-label="Find maintained asset"
                value={assetSearch}
                onChange={setAssetSearch}
                placeholder="Search by name"
              />
            </label>
            <label>
              Maintained asset (optional)
              <select
                className={control}
                value={config.asset_ref?.id ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    asset_ref: e.target.value
                      ? { kind: "assets:asset", id: e.target.value }
                      : null,
                  })
                }
              >
                <option value="">Keep unlinked</option>
                {config.asset_ref &&
                  !assets.data?.items.some(
                    (a) => a.id === config.asset_ref?.id,
                  ) && (
                    <option value={config.asset_ref.id}>
                      Current linked asset
                    </option>
                  )}
                {assets.data?.items.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted">
              Search by name if your asset is not shown. Keep manuals, service
              history and accessory links on its asset record.
            </p>
            <fieldset className="space-y-3">
              <legend>Usable hoops</legend>
              {config.hoops.map((h, i) => (
                <div className="grid gap-3 sm:grid-cols-4" key={i}>
                  <label>
                    Hoop name
                    <input
                      className={control}
                      required
                      value={h.name}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          hoops: config.hoops.map((v, j) =>
                            j === i ? { ...v, name: e.target.value } : v,
                          ),
                        })
                      }
                    />
                  </label>
                  {(["width_mm", "height_mm"] as const).map((field) => (
                    <label key={field}>
                      {field === "width_mm" ? "Width (mm)" : "Height (mm)"}
                      <NumberField
                        className={control}
                        required
                        min={0.1}
                        max={1000}
                        value={h[field]}
                        onChange={(n) =>
                          setConfig({
                            ...config,
                            hoops: config.hoops.map((v, j) =>
                              j === i ? { ...v, [field]: n } : v,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className={button}
                    disabled={config.hoops.length === 1}
                    onClick={() =>
                      setConfig({
                        ...config,
                        hoops: config.hoops.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remove hoop
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={button}
                disabled={config.hoops.length >= 20}
                onClick={() =>
                  setConfig({
                    ...config,
                    hoops: [
                      ...config.hoops,
                      {
                        name: `Hoop ${config.hoops.length + 1}`,
                        width_mm: 100,
                        height_mm: 100,
                      },
                    ],
                  })
                }
              >
                Add hoop
              </button>
            </fieldset>
            <fieldset>
              <legend>Formats accepted by this machine</legend>
              <div className="flex flex-wrap gap-4">
                {formats.map((f) => (
                  <label key={f} className="flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={config.formats.includes(f)}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          formats: e.target.checked
                            ? [...config.formats, f]
                            : config.formats.filter((v) => v !== f),
                        })
                      }
                    />
                    {f.toUpperCase()}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                Stitches per minute
                <NumberField
                  className={control}
                  integer
                  min={1}
                  max={3000}
                  required
                  value={config.stitches_per_minute}
                  onChange={(n) => setConfig({ ...config, stitches_per_minute: n })}
                />
              </label>
              <label>
                File name prefix
                <input
                  className={control}
                  required
                  pattern="[A-Z0-9]{1,3}"
                  maxLength={3}
                  value={config.filename_prefix}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      filename_prefix: e.target.value.toUpperCase(),
                    })
                  }
                />
              </label>
            </div>
            <p className="text-sm text-muted">
              Use the machine manual's usable sewing area and accepted formats.
              USB export works from any browser and needs no vendor desktop
              software.
            </p>
            <button
              className={button}
              disabled={busy || !config.formats.length}
            >
              Save machine
            </button>
            <button
              type="button"
              className={`${button} ml-3`}
              onClick={() => setShowSetup(false)}
            >
              Cancel
            </button>
          </form>
        )}
      </section>
      <section className={panel}>
        <h2 className="text-sm font-semibold">Design and thread</h2>
        {admin && (
          <label>
            Import embroidery file
            <input
              className={`${control} max-w-full`}
              type="file"
              accept=".pes,.dst,.exp,.jef,.vp3"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void perform(async () => {
                  if (file.size > 2 * 1024 * 1024)
                    throw new Error("Choose a file smaller than 2 MB.");
                  const stored = await api.uploadFile(slug, file);
                  await mutate("import_design", undefined, {
                    file_id: stored.id,
                    name: file.name,
                  });
                }, "Design imported. Choose it below.");
                e.target.value = "";
              }}
            />
          </label>
        )}
        <label>
          Design
          <select
            className={control}
            value={designId}
            disabled={!!pending}
            onChange={(e) => {
              setDesignId(e.target.value);
              setMapping({});
              setSelectedSpools({});
              setSpoolOffset(0);
            }}
          >
            <option value="">Choose a saved design</option>
            {designs.data?.items.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {(designs.data?.total ?? 0) > 20 &&
          pageButtons(designOffset, designs.data?.total, setDesignOffset)}
        {design && (
          <>
            <SummaryView summary={design.summary} />
            {tooLarge && (
              <p role="alert">
                This design is larger than the chosen hoop. Choose a larger hoop
                or a smaller design.
              </p>
            )}
            <p className="text-sm text-muted">
              Chart colours and nearest matches are approximate. Check the
              physical spool. DST and EXP may leave colours unspecified.
            </p>
            <label>
              Find owned thread
              <SearchInput
                size="lg"
                aria-label="Find owned thread"
                value={stockSearch}
                onChange={(value) => {
                  setStockSearch(value);
                  setSpoolOffset(0);
                }}
                placeholder="Search spool names"
              />
            </label>
            {spools.error && <p role="alert">{message(spools.error)}</p>}
            {(spools.data?.total ?? 0) > 20 &&
              pageButtons(spoolOffset, spools.data?.total, setSpoolOffset)}
            {design.summary.stops.map((stop) => (
              <div
                className="rounded border border-line p-3 space-y-2"
                key={stop.index}
              >
                <h3 className="text-sm font-semibold">
                  Colour {stop.index + 1}: {stop.name || "Unspecified colour"}
                </h3>
                <p>
                  {stop.color ?? "Colour unspecified"}
                  {stop.code ? ` · ${stop.brand} ${stop.code}` : ""} · about{" "}
                  {stop.estimated_m} m
                </p>
                <label>
                  Owned thread for colour {stop.index + 1}
                  <select
                    className={control}
                    disabled={!!pending}
                    value={mapping[String(stop.index)] ?? ""}
                    onChange={(e) => chooseThread(stop.index, e.target.value)}
                  >
                    <option value="">Choose a thread spool</option>
                    {Object.values({
                      ...selectedSpools,
                      ...Object.fromEntries(
                        (spools.data?.items ?? []).map((s) => [s.id, s]),
                      ),
                    }).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ·{" "}
                        {quantityWithUnit(s.remaining, s.unit, {
                          symbol: s.unit,
                          name: s.unit,
                          plural: s.unit,
                          category: s.unit === "m" ? "length" : "mass",
                        })}
                        {s.color ? ` · ${s.color}` : " · colour needed"}
                      </option>
                    ))}
                  </select>
                </label>
                {spools.data?.suggestions
                  .find((s) => s.index === stop.index)
                  ?.threads.map((t) => (
                    <button
                      key={t.spool.id}
                      type="button"
                      className={`${button} mr-2`}
                      disabled={!!pending}
                      onClick={() => chooseThread(stop.index, t.spool.id)}
                    >
                      {t.exact ? "Chart match" : "Nearby on this stock page"}:{" "}
                      {t.spool.name}
                    </button>
                  ))}
              </div>
            ))}
            {!!missing.length && (
              <p role="alert">
                You are missing threads for{" "}
                {countOf(missing.length, "colour stop")}:{" "}
                {missing.map((s) => s.index + 1).join(", ")}.
              </p>
            )}
            {admin && (
              <button
                className={button}
                disabled={
                  busy ||
                  !!pending ||
                  !machine ||
                  !selectedHoop ||
                  tooLarge ||
                  !!missing.length
                }
                onClick={() =>
                  void perform(
                    () =>
                      mutate("prepare", undefined, {
                        machine_id: machineId,
                        design_id: designId,
                        hoop,
                        format,
                        threads: mapping,
                      }),
                    "USB run prepared. Download it and follow the machine checklist.",
                  )
                }
                data-testid="embroidery-prepare"
              >
                Prepare USB run
              </button>
            )}
          </>
        )}
      </section>
      {machine && admin && (
        <section className={panel}>
          <h2 className="text-sm font-semibold">Authorized station screen</h2>
          <p>
            {authorized
              ? "This screen is authorized for this machine."
              : "Authorize this browser or tablet while you are at the machine. Run tracking starts only from an authorized screen."}
          </p>
          {!authorized && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const enrolled = await api.enrollEmbroideryStation(
                    slug,
                    machineId,
                    "Embroidery screen",
                  );
                  localStorage.setItem(
                    key,
                    JSON.stringify({ id: enrolled.id, token: enrolled.token }),
                  );
                  setStationVersion((v) => v + 1);
                }, "This screen is authorized.")
              }
            >
              Authorize this screen
            </button>
          )}
          {stations.data?.items
            .filter((s) => !s.revoked_at)
            .map((s) => (
              <div className="flex flex-wrap gap-3 items-center" key={s.id}>
                <span>
                  {s.label}
                  {s.id === station?.id ? " · this screen" : ""}
                </span>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api.revokeEmbroideryStation(slug, machineId, s.id);
                      if (s.id === station?.id) localStorage.removeItem(key);
                      setStationVersion((v) => v + 1);
                    }, "Station authorization revoked.")
                  }
                >
                  Revoke screen
                </button>
              </div>
            ))}
          {(stations.data?.total ?? 0) > 20 &&
            pageButtons(stationOffset, stations.data?.total, setStationOffset)}
        </section>
      )}
      {pending && (
        <section className={panel} data-testid="embroidery-run">
          <h2 className="text-sm font-semibold">{pending.plan.filename}</h2>
          <p>
            {pending.report && !pending.consumed_at
              ? "Thread use needs to be saved. Retry the same outcome."
              : pending.interrupted
                ? "Interrupted run, outcome needed"
                : pending.started_at
                  ? "Run tracking active, machine status is not connected"
                  : "Prepared USB run"}
          </p>
          <SummaryView summary={pending.plan.summary} />
          <ol className="list-decimal pl-5 space-y-2">
            {pending.plan.checklist.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const blob = await api.downloadEmbroidery(slug, pending.job_id),
                  url = URL.createObjectURL(blob),
                  a = document.createElement("a");
                a.href = url;
                a.download = pending.plan.filename;
                a.click();
                URL.revokeObjectURL(url);
              }, "File downloaded. Copy it to the USB stick and check it at the machine.")
            }
          >
            Download {pending.plan.filename}
          </button>
          {!pending.started_at && !pending.report && admin && (
            <div className="space-y-2">
              {[
                ["file_copied", "File copied to USB and stick safely ejected"],
                [
                  "file_confirmed",
                  "Exact file and preview confirmed at the machine",
                ],
                ["hoop_mounted", "Chosen hoop mounted"],
                ["colours_loaded", "Selected thread colours loaded in order"],
                ["origin_clear", "Origin checked and needle path clear"],
              ].map(([name, label]) => (
                <label className="flex min-h-11 gap-3 items-center" key={name}>
                  <input
                    type="checkbox"
                    checked={!!checks[name!]}
                    onChange={(e) =>
                      setChecks({ ...checks, [name!]: e.target.checked })
                    }
                  />
                  {label}
                </label>
              ))}
              <button
                className={button}
                disabled={
                  busy ||
                  !authorized ||
                  Object.values(checks).filter(Boolean).length !== 5
                }
                onClick={() =>
                  void perform(
                    () =>
                      mutate("start", pending.job_id, {
                        ...checks,
                        station_token: station?.token,
                      }),
                    "Run tracking started. Start the physical machine using its own controls.",
                  )
                }
                data-testid="embroidery-start"
              >
                Start tracking this run
              </button>
            </div>
          )}
          {pending.started_at && !pending.report && admin && (
            <button
              className={button}
              disabled={busy || pending.interrupted}
              onClick={() =>
                void perform(
                  () => mutate("interrupt", pending.job_id, {}),
                  "Interruption recorded. Use the physical machine's Stop control, then record thread use.",
                )
              }
            >
              Record interruption
            </button>
          )}
          {admin && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const report = pending.report ?? {
                  verdict:
                    pending.started_at && !pending.interrupted
                      ? verdict
                      : "scrap",
                  finished:
                    !!pending.started_at && finished && !pending.interrupted,
                  idle_confirmed: true,
                  needle_up_confirmed: true,
                  usage: pending.plan.summary.stops.map((s) => ({
                    index: s.index,
                    metres: pending.started_at
                      ? Number(usage[String(s.index)])
                      : 0,
                  })),
                };
                void perform(
                  () =>
                    mutate("outcome", pending.job_id, {
                      ...report,
                      station_token: station?.token,
                    }),
                  "Outcome saved and measured thread use recorded.",
                );
              }}
            >
              <h3 className="text-sm font-semibold">
                {pending.started_at
                  ? "Measure thread used"
                  : "Discard this unstarted run"}
              </h3>
              {pending.plan.summary.stops.map((stop) => (
                <label key={stop.index}>
                  Colour {stop.index + 1}:{" "}
                  {pending.plan.threads[String(stop.index)]?.name} · used metres
                  <input
                    className={control}
                    type="number"
                    min={0}
                    max={100000}
                    step={0.001}
                    required
                    disabled={!pending.started_at || !!pending.report}
                    value={
                      pending.report?.usage.find((s) => s.index === stop.index)
                        ?.metres ??
                      (!pending.started_at
                        ? 0
                        : (usage[String(stop.index)] ?? ""))
                    }
                    onChange={(e) =>
                      setUsage({ ...usage, [stop.index]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label>
                Outcome
                <select
                  className={control}
                  disabled={!pending.started_at || !!pending.report}
                  value={
                    pending.report?.verdict ??
                    (!pending.started_at || pending.interrupted
                      ? "scrap"
                      : verdict)
                  }
                  onChange={(e) =>
                    setVerdict(e.target.value as "good" | "scrap")
                  }
                >
                  <option value="good" disabled={pending.interrupted}>
                    Good
                  </option>
                  <option value="scrap">Scrap</option>
                </select>
              </label>
              {pending.started_at &&
                !pending.interrupted &&
                !pending.report && (
                  <label className="flex min-h-11 gap-3 items-center">
                    <input
                      type="checkbox"
                      checked={finished}
                      onChange={(e) => setFinished(e.target.checked)}
                    />
                    Design finished
                  </label>
                )}
              <label className="flex min-h-11 gap-3 items-center">
                <input
                  type="checkbox"
                  checked={idle}
                  onChange={(e) => setIdle(e.target.checked)}
                />
                Machine physically idle
              </label>
              <label className="flex min-h-11 gap-3 items-center">
                <input
                  type="checkbox"
                  checked={needleUp}
                  onChange={(e) => setNeedleUp(e.target.checked)}
                />
                Needle raised and hoop safe to remove
              </label>
              <button
                className={button}
                disabled={busy || !authorized || !idle || !needleUp}
              >
                {pending.report
                  ? "Retry saved outcome"
                  : pending.started_at
                    ? "Save outcome and thread use"
                    : "Discard with zero thread use"}
              </button>
            </form>
          )}
        </section>
      )}
      {!!runs.data?.items.some((r) => r.consumed_at) && (
        <section className={panel}>
          <h2 className="text-sm font-semibold">Recent runs</h2>
          <ul className="space-y-2">
            {runs.data.items
              .filter((r) => r.consumed_at)
              .map((r) => (
                <li className="break-words" key={r.job_id}>
                  {r.plan.filename} · {r.report?.verdict} ·{" "}
                  {r.report?.usage.reduce((n, s) => n + s.metres, 0).toFixed(3)}{" "}
                  m used
                </li>
              ))}
          </ul>
          <p className="text-sm text-muted">
            Showing the latest 20 runs for this machine.
          </p>
        </section>
      )}
      <details className={panel}>
        <summary className="min-h-11 cursor-pointer flex items-center font-semibold">
          Thread brand charts
        </summary>
        <p className="text-sm text-muted">
          This cross-brand reference is a subset of each chart. Copy the brand
          and code to your thread's Inventory record. Confirm the physical
          colour.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label>
            Brand chart
            <select
              className={control}
              value={chartBrand}
              onChange={(e) => {
                setChartBrand(e.target.value);
                setChartOffset(0);
              }}
            >
              <option value="">All charts</option>
              {chart.data?.brands.map((brand) => (
                <option key={brand}>{brand}</option>
              ))}
            </select>
          </label>
          <label>
            Find chart code
            <SearchInput
              size="lg"
              aria-label="Find chart code"
              value={chartQuery}
              onChange={(value) => {
                setChartQuery(value);
                setChartOffset(0);
              }}
            />
          </label>
        </div>
        {chart.error && <p role="alert">{message(chart.error)}</p>}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {chart.data?.items.map((t) => (
            <li
              key={`${t.brand}:${t.code}`}
              className="flex gap-3 items-center min-w-0"
            >
              <span
                className="h-8 w-8 shrink-0 rounded border border-line"
                style={{ backgroundColor: t.color }}
                aria-hidden="true"
              />
              <span className="break-words">
                {t.brand} · {t.code}
                <br />
                <span className="text-sm text-muted">
                  {t.color} · approximate
                </span>
              </span>
            </li>
          ))}
        </ul>
        {pageButtons(chartOffset, chart.data?.total, setChartOffset)}
      </details>
      <section className={panel}>
        <h2 className="text-sm font-semibold">Sewing machines and patterns</h2>
        <p>
          The Sewing bundle keeps machines as maintained assets, manuals and
          linked accessories, thread spools, wearing needles, and pattern PDFs
          with supplies and sizes.
        </p>
        <Link className={button} to="/bundles">
          Add Sewing from Bundles
        </Link>
      </section>
    </div>
  );
}
