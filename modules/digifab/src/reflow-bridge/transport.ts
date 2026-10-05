import { Duplex } from "node:stream";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { connect } from "node:net";
export interface ReflowTransport { stream: Duplex; write(line: string): Promise<void>; close(): Promise<void> }
const exec = promisify(execFile);
export function serialArguments(path: string, baud: number, os: string) {
  if (!Number.isInteger(baud) || baud < 1200 || baud > 2000000) throw new Error("Choose a supported serial baud rate.");
  if (os === "win32") {
    if (!/^COM[1-9][0-9]*$/i.test(path)) throw new Error("Choose a COM port without other characters.");
    const source = String.raw`using System;
using System.IO;
using System.IO.Ports;
using System.Threading;
public static class CobblrReflowPort {
 public static void Forward(string name, int baud) {
  using (var port = new SerialPort(name, baud, Parity.None, 8, StopBits.One)) {
   port.Handshake = Handshake.None; port.DtrEnable = false; port.RtsEnable = false; port.Open();
   var output = Console.OpenStandardOutput();
   var reader = new Thread(() => { try { var data = new byte[4096]; while (true) { int count = port.BaseStream.Read(data, 0, data.Length); if (count == 0) break; output.Write(data, 0, count); output.Flush(); } } catch (Exception e) { Console.Error.WriteLine(e.Message); Environment.Exit(1); } });
   reader.IsBackground = true; reader.Start();
   try { var input = Console.OpenStandardInput(); var data = new byte[4096]; int count; while ((count = input.Read(data, 0, data.Length)) > 0) port.BaseStream.Write(data, 0, count); } finally { port.Close(); }
  }
 }
}`;
    const program = `Add-Type -TypeDefinition @'\n${source}\n'@; try { [CobblrReflowPort]::Forward('${path.toUpperCase()}',${baud}) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")] };
  }
  if (!["linux", "darwin"].includes(os) || !/^\/dev\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes("..")) throw new Error("Choose the USB serial device path on Linux or macOS, or a Windows COM port.");
  return { command: "stty", args: [os === "darwin" ? "-f" : "-F", path, String(baud), "raw", "-echo", "-ixon", "-ixoff", "cs8", "-cstopb", "-parenb", "clocal", "-hupcl", "min", "0", "time", "0"] };
}
class SerialStream extends Duplex {
  private closing = false;
  private reading = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private file: FileHandle) { super(); }
  override _read() { if (!this.reading) { this.reading = true; void this.receive(); } }
  private async receive(): Promise<void> {
    if (this.closing) return;
    try { const data = Buffer.alloc(4096), { bytesRead } = await this.file.read(data, 0, data.length, null); if (this.closing) return; if (bytesRead && !this.push(data.subarray(0, bytesRead))) { this.reading = false; return; } }
    catch (e) { if (!["EAGAIN", "EWOULDBLOCK"].includes((e as NodeJS.ErrnoException).code ?? "")) { this.destroy(e as Error); return; } }
    if (!this.closing) this.timer = setTimeout(() => { this.timer = null; void this.receive(); }, 5);
  }
  override _write(bytes: Buffer, _encoding: BufferEncoding, callback: (e?: Error | null) => void) { void (async () => { let offset = 0; while (offset < bytes.length) { if (this.closing) throw new Error("The serial port closed."); const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, null); if (!bytesWritten) throw new Error("The serial port stopped accepting bytes."); offset += bytesWritten; } })().then(() => callback(), e => callback(e as Error)); }
  override _destroy(e: Error | null, callback: (e?: Error | null) => void) { this.closing = true; if (this.timer) clearTimeout(this.timer); this.timer = null; void this.file.close().then(() => callback(e), error => callback(error as Error)); }
}
function wrapped(stream: Duplex, close: () => Promise<void>): ReflowTransport { return { stream, write: line => new Promise((resolve, reject) => { stream.write(`${line}\n`, e => e ? reject(e) : resolve()); }), close }; }
export async function openReflowTransport(config: Record<string, unknown>): Promise<ReflowTransport> {
  const timeoutMs = Number(config.timeoutMs || 5000);
  if (config.transport === "tcp") {
    const host = String(config.host || ""), port = Number(config.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Give the serial adapter's network address and port.");
    const socket = connect({ host, port }), timer = setTimeout(() => socket.destroy(new Error("The controller did not connect.")), timeoutMs);
    try { await once(socket, "connect"); } finally { clearTimeout(timer); }
    return wrapped(socket, async () => { socket.destroy(); });
  }
  const path = String(config.path || ""), setup = serialArguments(path, Number(config.baud || 115200), process.platform);
  if (process.platform === "win32") {
    const child = spawn(setup.command, setup.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    let error = ""; child.stderr.on("data", b => { error = (error + String(b)).slice(-1000); }); child.on("error", e => stream.destroy(e)); child.on("exit", code => stream.destroy(code ? new Error(error || "The COM port closed.") : undefined));
    stream.once("close", () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    return wrapped(stream, async () => { child.kill(); stream.destroy(); });
  }
  await exec(setup.command, setup.args, { timeout: timeoutMs });
  const stream = new SerialStream(await open(path, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK));
  return wrapped(stream, async () => { stream.destroy(); if (!stream.closed) await once(stream, "close"); });
}
