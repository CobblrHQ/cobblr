// This person's Discord status, one request shared by every door that asks
// discordConnectable / doorLeadsSomewhere (lib/discord-connect.ts). Kept apart
// from the rule so the rule stays plain data that anything can import.
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useDiscordStatus(enabled = true) {
  return useQuery({
    queryKey: ["discord-status"],
    queryFn: () => api.meDiscordStatus(),
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
}
