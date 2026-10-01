// Add a thing by saying what it is: the words go to the scan inbox as a note,
// and Cobblr finds (or builds) the right home and files it. One door for the
// dashboard's "Just add it", its "try" chips and the palette's "Add a thing".
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api } from "./api";

export function useAddByWords(slug: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (t: string) => api.scanNote(slug, t),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Added - finding the right home…");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that"),
  });
}
