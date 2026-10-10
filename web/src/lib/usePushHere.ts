// This device and Web Push (#5267, #5565): what it can do, whether it is on,
// and the two taps that change that. One hook, so the open bell's row and the
// notification settings card turn it on the same way and agree about it.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { api } from "./api";
import { installRoute, readInstallEnv } from "./install-app";
import { pushReadiness, readPushEnv, thisDeviceId, turnOffPushHere, turnOnPushHere } from "./push-device";

export const PUSH_QUERY_KEY = ["me-push"] as const;

export function usePushHere() {
  const qc = useQueryClient();
  const toast = useToast();
  const [route] = useState(() => installRoute(readInstallEnv()));
  const [env, setEnv] = useState(() => readPushEnv(route));
  const [mine, setMine] = useState(() => thisDeviceId());
  const q = useQuery({ queryKey: PUSH_QUERY_KEY, queryFn: () => api.mePush() });
  const refresh = () => void qc.invalidateQueries({ queryKey: PUSH_QUERY_KEY });
  const devices = q.data?.devices ?? [];
  const here = devices.find((d) => d.id === mine) ?? null;

  const turnOn = useMutation({
    mutationFn: async () => {
      const key = q.data?.public_key;
      if (!key) throw new Error("This server has not made its push key yet. Try again in a minute.");
      return turnOnPushHere(key, env);
    },
    onSuccess: (r) => {
      setEnv(readPushEnv(route));
      if (r.ok) {
        setMine(r.id);
        toast.success("Notifications are on for this device. Send a test to see one arrive.");
      } else if (r.why === "failed") toast.error(r.message ?? "This device could not be turned on.");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't turn notifications on"),
  });

  /** Stop pushes to a device; this one is unsubscribed in the browser too. */
  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (id === mine) await turnOffPushHere();
      await api.removeMePushDevice(id);
    },
    onSuccess: (_r, id) => {
      if (id === mine) setMine(null);
      refresh();
    },
    onError: () => toast.error("Couldn't remove that device"),
  });

  return { q, route, readiness: pushReadiness(env), devices, here, mine, publicKey: q.data?.public_key ?? null, turnOn, remove, refresh };
}
