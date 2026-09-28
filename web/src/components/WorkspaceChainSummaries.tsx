// One line per workspace on Your account, Connections: who answers there, in
// order, and the way to change it (#3842). The whole order lives on that
// workspace's AI page; this is where a person holding several connections
// across several workspaces sees it without opening each one.
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { AI_JOB_GROUPS, chainSummary } from "../lib/ai-chain";
import { WHO_ANSWERS_ANCHOR } from "./WhoAnswersSection";
import { SettingsSection } from "./SettingsSection";

const SHOWN = AI_JOB_GROUPS.filter((g) => g.id === "photos" || g.id === "chat");

export function WorkspaceChainSummaries({ workspaces }: { workspaces: Array<{ id: string; slug: string; name: string }> }) {
  const results = useQueries({
    queries: workspaces.flatMap((w) =>
      SHOWN.map((g) => ({
        queryKey: aiAvailabilityKeys.chain(w.slug, g.shows),
        queryFn: () => api.getAiChain(w.slug, g.shows),
      })),
    ),
  });
  if (!workspaces.length) return null;
  return (
    <SettingsSection title="Who answers in your workspaces" blurb="The AI each workspace asks first, then next, for photos and for chat.">
      <ul className="mt-1.5 space-y-1.5">
        {workspaces.map((w, wi) => (
          <li key={w.id} className="text-[12px] text-muted dark:text-slate-400">
            <span className="font-medium text-content dark:text-mortar-100">{w.name}</span>
            {SHOWN.map((g, gi) => {
              const data = results[wi * SHOWN.length + gi]?.data;
              const line = data ? chainSummary(data.you) : null;
              return (
                <span key={g.id} className="block">
                  {g.title}: {data ? (line ?? "nothing answers") : "…"}
                </span>
              );
            })}
            <Link to={`/w/${w.slug}/configuration/ai#${WHO_ANSWERS_ANCHOR}`} className="text-accent hover:underline">
              Change the order
            </Link>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
