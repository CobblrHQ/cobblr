// /configuration/openapi — show the live auto-generated OpenAPI 3.1
// spec. v0.1: lists every entity kind's schema + the well-known
// platform paths. Builders integrating from outside Cobblr can copy
// it into Swagger UI / Insomnia.

import { useQuery } from "@tanstack/react-query";
import { Copy, Download, FileText } from "lucide-react";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useToast, usePageTitle } from "@cobblr/platform-web";
import { QueryError } from "../components/QueryError";

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<
      string,
      { type?: string; properties?: Record<string, unknown>; required?: string[]; description?: string }
    >;
  };
}

export function OpenApiPage() {
  usePageTitle("OpenAPI");
  const { activeSlug } = useActiveOrg();
  const toast = useToast();

  const specQ = useQuery({
    queryKey: ["openapi-spec", activeSlug],
    queryFn: async () => {
      const res = await fetch(
        `/api/v1/orgs/${activeSlug}/modules/core-openapi/openapi.json`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("cobblr.token") ?? ""}`,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as OpenApiSpec;
    },
    enabled: !!activeSlug,
  });

  const spec = specQ.data;
  const schemas = Object.entries(spec?.components.schemas ?? {});
  const paths = Object.keys(spec?.paths ?? {});

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <FileText size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          OpenAPI
        </h1>
        {spec && (
          <span className="text-sm text-muted dark:text-slate-400">
            v{spec.info.version} · {schemas.length} schemas · {paths.length} paths
          </span>
        )}
        <div className="flex-1" />
        {spec && (
          <>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(JSON.stringify(spec, null, 2));
                toast.success("Spec copied to clipboard");
              }}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800"
            >
              <Copy size={14} />
              Copy
            </button>
            <button
              onClick={() => {
                // The spec endpoint needs a Bearer header, which a
                // plain <a download> navigation can't send (→ 401).
                // The spec is already fetched into memory, so download
                // a blob of it rather than re-hitting the endpoint.
                const blob = new Blob([JSON.stringify(spec, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "cobblr-openapi.json";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white"
            >
              <Download size={14} />
              Download
            </button>
          </>
        )}
      </div>

      <p className="text-sm text-muted dark:text-slate-400">
        Auto-generated from the live module registry. Point Swagger UI /
        Insomnia / curl at the endpoint, or download the JSON file. Each
        entity kind appears as a <code className="font-mono">Module.Type</code>{" "}
        component schema; well-known platform routes are documented per-path.
      </p>

      {specQ.isLoading && <div className="text-sm text-muted">Loading…</div>}
      {specQ.isError && <QueryError what="the API spec" onRetry={() => specQ.refetch()} />}

      {spec && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section>
            <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-2">
              Component schemas
            </h2>
            <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 max-h-96 overflow-y-auto overflow-x-auto">
              {schemas.map(([name, s]) => (
                <li key={name} className="px-3 py-2 text-sm">
                  <div className="font-mono text-xs">{name}</div>
                  {s.description && (
                    <div className="text-xs text-muted mt-0.5">
                      {s.description}
                    </div>
                  )}
                  {s.properties && (
                    <div className="text-xs text-muted mt-1">
                      {Object.keys(s.properties).slice(0, 8).join(", ")}
                      {Object.keys(s.properties).length > 8 && "…"}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-sm font-medium text-content dark:text-slate-300 mb-2">
              Paths
            </h2>
            <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 max-h-96 overflow-y-auto overflow-x-auto font-mono text-xs">
              {paths.map((p) => (
                <li key={p} className="px-3 py-1.5 whitespace-nowrap">
                  {p}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
