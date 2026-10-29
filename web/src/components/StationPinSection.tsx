// Your station PIN (#8845): a station a team shares can ask each person for
// their own four digits before it records their changes to them. Set per
// workspace, here, signed in as yourself; only its hash is kept.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError, SecretInput, useToast } from "@cobblr/platform-web";
import { SettingsSection } from "./SettingsSection";
import { STATION_MEMBER_PIN_RE } from "@cobblr/platform-contract/station-screen";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function StationPinSection() {
  const { activeOrg } = useActiveOrg();
  const slug = activeOrg?.slug ?? "";
  const qc = useQueryClient();
  const toast = useToast();
  const [pin, setPin] = useState("");
  const has = useQuery({ queryKey: ["my-station-pin", slug], queryFn: () => api.myStationPin(slug), enabled: !!slug });
  const save = useMutation({
    mutationFn: (next: string | null) => api.setMyStationPin(slug, next),
    onSuccess: (r) => {
      setPin("");
      qc.setQueryData(["my-station-pin", slug], r);
      toast.success(r.has_pin ? "Station PIN saved." : "Station PIN removed.");
    },
  });
  if (!activeOrg) return null;
  return (
    <SettingsSection
      title={`Station PIN in ${activeOrg.name}`}
      blurb={`A shared station can ask for your four digits when you tap your name, so nobody else's changes are recorded to you.${has.data?.has_pin ? " You have one set." : " You haven't set one yet."}`}
    >
      <form
        className="flex flex-wrap items-center gap-2"
        data-testid="station-pin-section"
        onSubmit={(e) => {
          e.preventDefault();
          if (STATION_MEMBER_PIN_RE.test(pin)) save.mutate(pin);
        }}
      >
        <SecretInput
          secret
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          what="station PIN"
          wrapperClassName="w-36"
          className="min-h-[44px] w-full rounded-lg border border-line px-3 text-lg tracking-widest dark:border-slate-600 dark:bg-slate-800"
          aria-label="New station PIN, four digits"
        />
        <button type="submit" disabled={!STATION_MEMBER_PIN_RE.test(pin) || save.isPending} className="min-h-[44px] rounded-lg bg-cobble-600 px-4 font-medium text-white disabled:opacity-40">
          {has.data?.has_pin ? "Change PIN" : "Set PIN"}
        </button>
        {has.data?.has_pin && (
          <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending} className="min-h-[44px] rounded-lg border border-line px-4 dark:border-slate-600">
            Remove
          </button>
        )}
      </form>
      <MutationError mutation={save} />
    </SettingsSection>
  );
}
