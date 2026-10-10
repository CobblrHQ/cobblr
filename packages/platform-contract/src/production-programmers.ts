// The programmers a production station can run, and the AVR fuses a plan may
// set. Kept apart from production-test.ts, which needs node:crypto, so the plan
// editor in the browser offers exactly the list the contract accepts.

/** pyOCD joins the first five for the CMSIS-DAP probes it drives best. */
export const PROGRAMMERS = ["openocd", "esptool", "avrdude", "picotool", "probe-rs", "pyocd"] as const;
export type Programmer = (typeof PROGRAMMERS)[number];

/** AVR fuse bytes a plan may set, each written then read back. */
export const AVR_FUSES = ["lfuse", "hfuse", "efuse", "lock"] as const;
export type AvrFuse = (typeof AVR_FUSES)[number];
