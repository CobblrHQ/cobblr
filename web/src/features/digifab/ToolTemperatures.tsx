import type { DigifabFleetDevice } from "../../lib/api";

export function ToolTemperatures({ tools }: { tools: NonNullable<DigifabFleetDevice["temps"]>["tools"] }) {
  if (!tools || tools.length < 2) return null;
  return <dl aria-label="Tool temperatures and filament" className="grid grid-cols-2 gap-2 text-sm mt-2">
    {tools.map((tool, index) => <div key={tool.id} className="min-w-0 rounded border border-line p-2">
      <dt className="font-medium">Tool {index + 1}</dt>
      <dd>{Math.round(tool.actual)}{tool.target != null ? ` / ${Math.round(tool.target)}` : ""} °C</dd>
      {tool.filament && <dd className="flex flex-wrap items-center gap-1 text-muted">
        {tool.filament.color && <span aria-label={`Filament color ${tool.filament.color}`} className="inline-block h-3 w-3 rounded-full border border-line" style={{ backgroundColor: tool.filament.color }} />}
        {[tool.filament.vendor, tool.filament.material].filter(Boolean).join(" · ")}
      </dd>}
    </div>)}
  </dl>;
}
