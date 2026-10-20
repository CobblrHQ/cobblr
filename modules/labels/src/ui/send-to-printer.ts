// Sending the queue's rendered sheet to a saved printer. A printer reached
// through a bridge on this person's own machine is sent from this browser,
// with the same bridge client the server runs over the tunnel; any other
// printer is the server's to reach (#7607). Either way the answer is a job the
// person confirms once the paper looks right.
import { EdgeBridgeClient, httpBridgeTransport } from "@cobblr/platform-contract/edge-bridge-client";
import { localBridgeOf } from "@cobblr/platform-web";

export interface SavedPrinter {
  id: string;
  name: string;
  settings?: unknown;
}

export async function sendPdfToPrinter(
  printer: SavedPrinter,
  pdfBase64: string,
  server: (printerId: string, body: { document_base64: string; content_type: string; filename: string; job_name: string }) => Promise<{ jobId: string; state: string }>,
): Promise<{ jobId: string; state: string }> {
  const bridge = localBridgeOf(printer);
  if (!bridge) return server(printer.id, { document_base64: pdfBase64, content_type: "application/pdf", filename: "labels.pdf", job_name: "labels" });
  if (!bridge.instance) throw new Error(`${printer.name} has no printer chosen on its bridge. Edit the printer and pick one, then try again.`);
  const client = new EdgeBridgeClient(httpBridgeTransport(bridge.bridgeUrl!, { token: bridge.token }), bridge.instance);
  const bytes = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
  const job = await client.printOnce(bytes, "labels.pdf");
  return { jobId: job.jobId, state: job.state ?? "queued" };
}
