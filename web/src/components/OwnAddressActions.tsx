// "Email it to me" and "Add to contacts" beside a person's own Cobblr address
// (#5462). Gmail suggests a recipient by the names it has had mail from, so
// the long receipts+ address was found by nothing when they typed "Cobblr".
// One email from the address, or its contact card, puts "Cobblr Receipts
// <workspace>" in their address book. Once sent, the card says where it went
// and what to do if it landed in Spam, with Resend right there.

import { useState } from "react";
import { downloadBlob, useToast } from "@cobblr/platform-web";
import { ownAddressSentWords, ownAddressVCard } from "@cobblr/platform-contract/address-name";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";

export function OwnAddressActions({
  address,
  name,
  which = "receipts",
  workspace,
}: {
  address: string;
  /** "Cobblr Receipts <workspace name>". */
  name: string;
  which?: "receipts" | "orders";
  workspace?: string | null;
}) {
  const toast = useToast();
  const { activeSlug } = useActiveOrg();
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const send = async () => {
    setSending(true);
    try {
      const out = await api.emailMyAddress(activeSlug, which);
      setSentTo(out.to);
    } catch (err) {
      toast.error((err as Error).message || "Could not send it. Copy the address instead.");
    } finally {
      setSending(false);
    }
  };
  return (
    <span className="mt-1.5 block text-[11px]">
      {sentTo && (
        <span className="mb-1 block text-muted" role="status" data-testid="own-address-sent">
          {ownAddressSentWords(sentTo, which)}
        </span>
      )}
      <span className="flex gap-2">
        <button type="button" disabled={sending || !activeSlug} onClick={() => void send()} className="text-accent hover:underline disabled:opacity-50">
          {sending ? "Sending…" : sentTo ? "Resend" : "Email it to me"}
        </button>
        <button
          type="button"
          onClick={() => {
            downloadBlob(new Blob([ownAddressVCard({ name, address, workspace })], { type: "text/vcard" }), `${name.replace(/[^\w ()'-]+/g, "").trim() || "Cobblr"}.vcf`);
          }}
          className="text-accent hover:underline"
        >
          Add to contacts
        </button>
      </span>
    </span>
  );
}
