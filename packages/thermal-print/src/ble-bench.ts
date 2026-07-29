// A virtual Web Bluetooth adapter, for driving the browser-BLE path without a
// printer.
//
// This is the one transport the bench cannot serve from another process:
// navigator.bluetooth lives in the page, so a fake has to live there too. It
// installs behind the SAME `bluetooth()` accessor the real code already goes
// through, so nothing above it changes — the chooser, the GATT walk, the
// write-characteristic ranking and the printing all run for real.
//
// WHAT IT REFUSES TO DO IS THE POINT. On these printers BLE is WRITE-ONLY: the
// PM220S accepts writes and never notifies, and the PM240's BLE tree is an
// outright decoy that accepts everything and prints nothing. So this fake:
//
//   • exposes writable characteristics and accepts every write,
//   • never notifies, and offers no readable characteristic at all,
//   • can be told to be a DECOY, where writes succeed and nothing happens.
//
// A fake that answered a status read here would make a green run meaningless on
// exactly the transport that has already produced two shipped bugs.
//
// Never active unless explicitly installed. Nothing imports this at module load;
// the app has to call installBenchBluetooth(), which is what keeps it out of a
// production page.

export interface BenchBleDeviceSpec {
  id: string;
  name: string;
  /** Writes are accepted and silently discarded — the PM240's BLE tree. The
   *  printer looks connected and never prints, which is the failure this models. */
  decoy?: boolean;
  /** Service/characteristic UUIDs to expose. Defaults match the pipes the real
   *  printers advertise, so the ranking code has something realistic to rank. */
  serviceUuid?: string;
  writeCharUuids?: string[];
  /** Fail the GATT connect, for the "paired but unreachable" case. */
  connectFails?: boolean;
}

/** Everything written to a virtual device this session — what the bench log and
 *  a test assert against, since a write-only device tells you nothing itself. */
export interface BenchBleWrite {
  deviceId: string;
  charUuid: string;
  bytes: Uint8Array;
  at: number;
}

const writes: BenchBleWrite[] = [];
export function benchBleWrites(): BenchBleWrite[] {
  return writes;
}
export function clearBenchBleWrites(): void {
  writes.length = 0;
}

const DEFAULT_SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb";
const DEFAULT_WRITE = ["0000ff02-0000-1000-8000-00805f9b34fb"];

function makeChar(deviceId: string, uuid: string, decoy: boolean) {
  return {
    uuid,
    properties: { write: false, writeWithoutResponse: true, notify: false, read: false },
    async writeValueWithoutResponse(v: BufferSource): Promise<void> {
      const bytes = v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
      // A decoy accepts the write and drops it. Recording it anyway is
      // deliberate: the whole lesson of the PM240 is that the write SUCCEEDING
      // tells you nothing, and a test should be able to show bytes were sent and
      // still nothing printed.
      writes.push({ deviceId, charUuid: uuid, bytes, at: Date.now() });
      if (decoy) return;
    },
    async writeValue(v: BufferSource): Promise<void> {
      return this.writeValueWithoutResponse(v);
    },
    // No startNotifications, no readValue: this is the fake's contract with
    // reality. Code that reaches for them gets the same TypeError it would from
    // a real printer that does not implement them.
  };
}

function makeDevice(spec: BenchBleDeviceSpec) {
  const serviceUuid = spec.serviceUuid ?? DEFAULT_SERVICE;
  const chars = (spec.writeCharUuids ?? DEFAULT_WRITE).map((u) => makeChar(spec.id, u, !!spec.decoy));
  let connected = false;
  const service = {
    uuid: serviceUuid,
    async getCharacteristics() {
      return chars;
    },
    async getCharacteristic(uuid: string) {
      const c = chars.find((x) => x.uuid.toLowerCase() === uuid.toLowerCase());
      if (!c) throw new Error(`No Characteristic matching UUID ${uuid}.`);
      return c;
    },
  };
  const device = {
    id: spec.id,
    name: spec.name,
    gatt: {
      get connected() {
        return connected;
      },
      async connect() {
        if (spec.connectFails) {
          // Chrome's real wording for an unreachable device, so error handling
          // is exercised against the string it will actually see.
          throw new Error("GATT Server is disconnected. Cannot retrieve services.");
        }
        connected = true;
        return {
          async getPrimaryServices() {
            return [service];
          },
          async getPrimaryService(uuid: string) {
            if (uuid.toLowerCase() !== serviceUuid.toLowerCase()) {
              throw new Error(`No Service matching UUID ${uuid}.`);
            }
            return service;
          },
        };
      },
      disconnect() {
        connected = false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return device;
}

let installed: { restore: () => void } | null = null;

/** Put virtual BLE devices behind navigator.bluetooth.
 *
 *  `chooses` decides which device the "chooser" returns, standing in for the
 *  human picking one — a fake chooser that always returns the first device
 *  could never reproduce picking the wrong printer, which is a real mistake. */
export function installBenchBluetooth(
  specs: BenchBleDeviceSpec[],
  opts: { chooses?: (devices: BenchBleDeviceSpec[]) => BenchBleDeviceSpec | null } = {},
): () => void {
  const nav = globalThis.navigator as unknown as { bluetooth?: unknown };
  const previous = nav?.bluetooth;
  const devices = specs.map((s) => ({ spec: s, device: makeDevice(s) }));

  const fake = {
    async requestDevice(_o: unknown) {
      const pick = opts.chooses ? opts.chooses(specs) : specs[0];
      if (!pick) {
        // Exactly what Chrome throws when someone closes the chooser, because
        // "the user cancelled" is a case the UI must handle without alarm.
        throw Object.assign(new Error("User cancelled the requestDevice() chooser."), { name: "NotFoundError" });
      }
      const found = devices.find((d) => d.spec.id === pick.id);
      if (!found) throw new Error("User cancelled the requestDevice() chooser.");
      return found.device;
    },
    async getDevices() {
      return devices.map((d) => d.device);
    },
  };

  Object.defineProperty(globalThis.navigator, "bluetooth", { value: fake, configurable: true, writable: true });
  const restore = () => {
    if (previous === undefined) {
      delete (globalThis.navigator as unknown as Record<string, unknown>).bluetooth;
    } else {
      Object.defineProperty(globalThis.navigator, "bluetooth", { value: previous, configurable: true, writable: true });
    }
    installed = null;
  };
  installed = { restore };
  return restore;
}

export function benchBluetoothInstalled(): boolean {
  return installed !== null;
}
