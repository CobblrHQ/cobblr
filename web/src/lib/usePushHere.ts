// This device and Web Push (#5267, #5565): what it can do, whether it is on,
// and the two taps that change that. One hook, so the open bell's row and the
// notification settings card turn it on the same way and agree about it.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api } from "./api";
import { installRoute, readInstallEnv } from "./install-app";
import { pushReadiness, pushTurnOnProblem, readPushEnv, thisDeviceId, turnOffPushHere, turnOnPushHere, type PushTurnOnFailure } from "./push-device";

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

  // Why the last Turn on did not finish, said where it was pressed until the
  // next try (#5810: a refusal came back as the same button and nothing else).
  const [problem, setProblem] = useState<{ why: PushTurnOnFailure; message?: string } | null>(null);
  const turnOn = useMutation({
    mutationFn: () => turnOnPushHere(q.data?.public_key, env),
    onMutate: () => setProblem(null),
    onSuccess: (r) => {
      setEnv(readPushEnv(route));
      if (r.ok) {
        setMine(r.id);
        toast.success("Notifications are on for this device. Send a test to see one arrive.");
      } else setProblem({ why: r.why, message: r.message });
      refresh();
    },
    onError: (e) => setProblem({ why: "not-saved", message: e instanceof Error ? e.message : String(e) }),
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

  /** Send a test to a device: the card's per-device button and the bell's
   *  row send it the same way and say what happened the same way. */
  const test = useMutation({
    mutationFn: (id: string) => api.testMePushDevice(id),
    onSuccess: (r) => {
      if (r.outcome === "sent") toast.success(`Sent a test to ${r.label}.`);
      else toast.error(r.outcome === "gone" ? `${r.label} is no longer subscribed, so it was removed. Turn it on there again.` : `${r.label}: ${r.reason ?? "not delivered"}`);
      refresh();
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "The test was not delivered");
      refresh();
    },
  });

  const readiness = pushReadiness(env);
  // A block the browser now reports is said by the denied state itself.
  const failure = problem && readiness.kind !== "denied" ? { why: problem.why, ...pushTurnOnProblem(problem, env) } : null;
  return { q, route, readiness, devices, here, mine, publicKey: q.data?.public_key ?? null, turnOn, failure, remove, test, refresh };
}
