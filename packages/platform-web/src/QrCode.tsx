// Render a string value as a scannable QR image. Used by the `qr` field
// renderer (and directly, e.g. the Quick Access drawer showing a pinned entry's
// code). QR is safe to *generate* from an owned value (a UPC, a location/asset
// tag, a URL) — unlike a scanner's CONFIG barcodes, which are exact Code-128 and
// must be stored as an image, never regenerated (KB spec §3.5).
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 128 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { margin: 1, errorCorrectionLevel: "M", width: size })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value, size]);
  if (!value) return null;
  if (!src) return <span className="inline-block animate-pulse rounded bg-subtle dark:bg-slate-800" style={{ width: size, height: size }} />;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={`QR code for ${value}`}
      className="rounded bg-white p-1"
    />
  );
}
