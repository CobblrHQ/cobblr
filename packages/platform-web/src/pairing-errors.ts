// Turning a browser pairing failure into something a person can act on.
//
// The case that motivated this: a TYPONOS PM240 is a Bluetooth CLASSIC printer.
// Paired in macOS it shows up in Chrome's chooser, and picking it throws
// `NotSupportedError: Unsupported device.` — because it has no GATT server for
// Web Bluetooth to talk to. Chrome is telling us exactly what is wrong, and we
// were forwarding the raw string to a toast, which reads as "your printer is
// broken" and dead-ends.
//
// It is not broken and it is not unsupported by Cobblr: it needs the SERIAL
// transport, which is the one route to a Classic device from a browser. An error
// whose remedy we know must name that remedy.

export type PairingRemedy = "serial" | "bridge" | "none";

export interface PairingFailure {
  message: string;
  /** What the UI should offer next. "serial" shows the connect-as-a-serial-port
   *  action; "bridge" means no browser can get there and the edge bridge is the
   *  route, so the UI must offer that door rather than dead-ending on an error. */
  remedy: PairingRemedy;
}

/** Chrome's wording when a chosen device exposes no GATT server. It is the
 *  signature of a Bluetooth CLASSIC device, not of a defective one. */
// Deliberately narrow: a flaky BLE link also throws GATT errors, and telling
// that user to switch to serial would send them down the wrong road. Only the
// no-GATT-at-all signatures qualify.
const CLASSIC_SIGNATURES = [
  /unsupported device/i,
  /NotSupportedError/i,
];

const NOT_FOUND = /No Services found|NotFoundError.*services/i;

/** Chrome refusing to open a Bluetooth Classic serial port.
 *
 *  On macOS this is not the printer and not the user: Chrome performs a
 *  mandatory SDP query before every open and it times out for EVERY paired
 *  Classic device — two label printers, an iPhone and an Apple Watch all failed
 *  identically, while native code opened the same printer first try. Filed as
 *  crbug 539890521. Telling someone to re-pair, restart or buy a different cable
 *  wastes their evening; the honest answer is that this door does not open and
 *  another one does. */
const SERIAL_OPEN_FAILED = /Failed to open serial port|open.*on .?SerialPort/i;

export function explainPairingFailure(e: unknown): PairingFailure {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);

  // A cancelled chooser is a normal outcome; callers drop it rather than shout.
  if (/No device selected|cancell?ed/i.test(raw)) return { message: "", remedy: "none" };

  if (SERIAL_OPEN_FAILED.test(raw)) {
    return {
      remedy: "bridge",
      message:
        "Your browser could not open this printer's serial port. On macOS that fails for every " +
        "Bluetooth Classic device — it is a known browser bug, not something wrong with your " +
        "printer or your setup. An edge bridge talks to it directly and does work.",
    };
  }

  if (CLASSIC_SIGNATURES.some((re) => re.test(raw))) {
    return {
      remedy: "serial",
      message:
        "This looks like a Bluetooth Classic printer, which no browser can print to over Bluetooth. " +
        "Pair it in your computer's Bluetooth settings, then connect it as a serial port instead.",
    };
  }

  if (NOT_FOUND.test(raw)) {
    return {
      remedy: "serial",
      message:
        "Paired, but the printer exposed nothing to print to. That usually means it is a Bluetooth " +
        "Classic printer — connect it as a serial port instead.",
    };
  }

  return { message: raw, remedy: "none" };
}
