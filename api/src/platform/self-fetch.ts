// The api calling itself, without a socket (#4901).
//
// The assistant, the scan inbox, imports and a few kernel routes act through
// the api's own routes, so they get its auth, tenant scoping, validation and
// rules for free. They used to do it over HTTP to 127.0.0.1:$API_PORT, and
// under load that loopback dial was refused (ECONNREFUSED) while the same api
// kept answering other requests: a plan section's run failed with "fetch
// failed". selfFetch hands the request to the same express app in-process
// instead: every middleware still runs, from the same remote address a
// loopback call had (127.0.0.1), and the answer is parsed from the exact bytes
// a socket would have carried.
//
// One thing a socket gave for free has to be made here: a request off a socket
// starts with no async context. A call made inside another request would
// otherwise inherit that request's actor, via and request scope
// (request-context.ts) and act as whoever made the outer call, whatever its
// own Authorization says. So the request runs inside a snapshot taken at boot,
// outside any request, and sets every store itself, as on the HTTP path.

import { AsyncLocalStorage } from "node:async_hooks";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const outsideAnyRequest = AsyncLocalStorage.snapshot();
let handler: Handler | null = null;

/** The api's own app, once it is built (index.ts). Before that, and in a
 *  process that is not the api (a CLI), selfFetch goes over HTTP. */
export function setSelfHandler(h: Handler | null): void {
  handler = h;
}

class LoopbackSocket extends Duplex {
  readonly remoteAddress = "127.0.0.1";
  readonly remotePort = 0;
  readonly remoteFamily = "IPv4";
  readonly localAddress = "127.0.0.1";
  readonly encrypted = false;
  readonly written: Buffer[] = [];
  _read(): void {}
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/** A raw HTTP/1.1 response, as written to the socket, as a fetch Response. */
export function parseRawResponse(raw: Buffer): Response {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return new Response(null, { status: 502 });
  const head = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(head[0]?.split(" ")[1] ?? 502);
  const headers = new Headers();
  for (const line of head.slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  let body = raw.subarray(split + 4);
  if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) {
    const parts: Buffer[] = [];
    let at = 0;
    for (;;) {
      const eol = body.indexOf("\r\n", at);
      if (eol < 0) break;
      const size = parseInt(body.subarray(at, eol).toString("latin1"), 16);
      if (!size) break;
      parts.push(body.subarray(eol + 2, eol + 2 + size));
      at = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
    headers.delete("transfer-encoding");
  }
  const empty = status === 204 || status === 304 || body.length === 0;
  return new Response(empty ? null : new Uint8Array(body), { status, headers });
}

/** The path a request for this api named ("/api/v1/…", or a loopback URL to
 *  its own port), or null for any other address: a base URL a caller passed
 *  in (x-cobblr-base-url) or another server is fetched as it always was. */
function ownPath(input: unknown): string | null {
  if (typeof input !== "string" && !(input instanceof URL)) return null;
  const s = typeof input === "string" ? input : input.href;
  if (s.startsWith("/")) return s;
  const u = new URL(s);
  const own = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === String(process.env.API_PORT || "4000");
  return own ? u.pathname + u.search : null;
}

/** `fetch` against this api, handled in-process by its own app. The answer is
 *  buffered until the handler finishes, so this is for request and response
 *  routes: a server-sent-events or other never-ending stream never resolves
 *  (call those over HTTP). A full URL to any other address is an ordinary
 *  fetch, so a base URL a caller chose keeps its meaning. It rejects, naming the call, when the handler
 *  drops the response before finishing it, and when `init.signal` aborts, as
 *  fetch does. */
export async function selfFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const path = ownPath(input);
  if (path === null) return fetch(input, init);
  // loopback-ok: the fallback before the app is built, or outside the api process
  if (!handler) return fetch(`http://127.0.0.1:${process.env.API_PORT || "4000"}${path}`, init);
  const h = handler;
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  // The body as fetch would send it, and the content type it implies when the
  // caller set none (a FormData's multipart boundary, a URLSearchParams'
  // form encoding): without that type the route cannot parse the body.
  let body: Buffer | null = null;
  if (init.body !== undefined && init.body !== null) {
    const encoded = new Response(init.body as ConstructorParameters<typeof Response>[0]);
    body = Buffer.from(await encoded.arrayBuffer());
    const implied = encoded.headers.get("content-type");
    if (implied && !headers["content-type"]) headers["content-type"] = implied;
  }
  // HOST-OK: the Host header a loopback request carried, never used to build a link; loopback-ok: the same
  headers.host ??= `127.0.0.1:${process.env.API_PORT || "4000"}`;
  headers.connection = "close";
  if (body) headers["content-length"] = String(body.length);
  else delete headers["content-length"];

  return new Promise<Response>((resolve, reject) => {
    outsideAnyRequest(() => {
      const socket = new LoopbackSocket();
      const req = new IncomingMessage(socket as never);
      req.method = method;
      req.url = path;
      req.httpVersion = "1.1";
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 1;
      req.headers = headers;
      req.rawHeaders = Object.entries(headers).flat();
      const res = new ServerResponse(req);
      res.assignSocket(socket as never);
      res.shouldKeepAlive = false;
      res.on("finish", () => {
        try {
          resolve(parseRawResponse(Buffer.concat(socket.written)));
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
      // A response dropped before it finished (a handler that destroys it, or
      // throws after writing its headers) never emits "finish": without this
      // the caller waits forever, where a socket would have closed on it.
      res.on("close", () => {
        if (!res.writableFinished) reject(new Error(`The api's own ${method} ${path} closed before it answered`));
      });
      const signal = init.signal;
      if (signal) {
        const abort = () => {
          socket.destroy();
          reject(signal.reason ?? new Error(`The api's own ${method} ${path} was aborted`));
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        res.on("close", () => signal.removeEventListener("abort", abort));
      }
      // What an HTTP parser sets once the whole request has arrived. Without
      // it the request reads as aborted when its body ends, and Node destroys
      // the socket under a handler still working: a slower answer was lost.
      req.complete = true;
      if (body) req.push(body);
      req.push(null);
      try {
        h(req, res);
      } catch (err) {
        reject(err);
      }
    });
  });
}
