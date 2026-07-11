// Rebuild a stored QR payload against the workspace's CURRENT custom label base
// URL, so a queued label's preview and print always reflect the base URL as it
// is now, not as it was when the label was queued (set the base after queuing
// and the preview updates). With no custom base set, the stored URL is used
// as-is (its origin was captured at queue time). The token is everything after
// "/qr/"; a legacy bare path with no "/qr/" is left untouched.
export function liveQrUrl(qrPayload: string, customBase: string | null | undefined): string {
  if (!customBase) return qrPayload;
  const i = qrPayload.indexOf("/qr/");
  if (i < 0) return qrPayload;
  const token = qrPayload.slice(i + 4);
  return `${customBase.replace(/\/+$/, "")}/qr/${token}`;
}
