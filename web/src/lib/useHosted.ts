import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Is this a hosted Cobblr (one we run for people) rather than a self-hosted
 *  one? A hosted Cobblr cannot reach a device on the person's own network
 *  without a bridge there; a self-hosted one usually sits beside it. Unknown
 *  (still loading) reads as not hosted, so nothing asks for a bridge early. */
export function useHosted(): boolean {
  const q = useQuery({ queryKey: ["auth-config"], queryFn: () => api.authConfig(), staleTime: 5 * 60_000 });
  return !!q.data?.hosted;
}
