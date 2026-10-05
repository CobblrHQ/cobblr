// A small OpenID Connect provider for the sign-in tests (#4492): discovery,
// authorize, token, userinfo and end-session, enough to drive the api's real
// openid-client through the authorization code flow with PKCE. It checks what
// a real provider checks (the client secret, the PKCE verifier, the redirect
// URI, a single-use code) and can be told to lie (a wrong issuer, audience or
// nonce) so a test can show the api refuses it.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface Identity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  groups?: string[];
}
export type Lie = "issuer" | "audience" | "nonce" | null;

export interface FakeProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next authorize signs in as. */
  next: Identity;
  /** What the next ID token gets wrong, on purpose. */
  lie: Lie;
  /** Every client secret the token endpoint was sent (server to server only). */
  secretsSeen: string[];
  close(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { who: Identity; nonce: string; challenge: string; redirect: string; lie: Lie }>();
  const fake: FakeProvider = {
    issuer: "",
    clientId: `cobblr-test-${randomBytes(4).toString("hex")}`,
    clientSecret: `s3cr3t-${randomBytes(12).toString("hex")}`,
    next: { sub: "nobody" },
    lie: null,
    secretsSeen: [],
    close: async () => undefined,
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", fake.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: fake.issuer,
        authorization_endpoint: `${fake.issuer}/authorize`,
        token_endpoint: `${fake.issuer}/token`,
        userinfo_endpoint: `${fake.issuer}/userinfo`,
        jwks_uri: `${fake.issuer}/jwks`,
        end_session_endpoint: `${fake.issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "email", "profile", "groups"],
        claims_supported: ["sub", "email", "email_verified", "name", "groups"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      if (p.get("client_id") !== fake.clientId || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge") || !p.get("state") || !p.get("nonce")) {
        return json(400, { error: "invalid_request", seen: Object.fromEntries(p) });
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, { who: fake.next, nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, lie: fake.lie });
      const back = new URL(p.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state")!);
      back.searchParams.set("iss", fake.issuer);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = (req.headers.authorization ?? "").startsWith("Basic ")
        ? Buffer.from(req.headers.authorization!.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : null;
      const secret = basic?.[1] ?? form.get("client_secret") ?? "";
      fake.secretsSeen.push(secret);
      if ((basic?.[0] ?? form.get("client_id")) !== fake.clientId || secret !== fake.clientSecret) return json(401, { error: "invalid_client" });
      const got = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!got) return json(400, { error: "invalid_grant" });
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== got.challenge) return json(400, { error: "invalid_grant", why: "pkce" });
      if (form.get("redirect_uri") !== got.redirect) return json(400, { error: "invalid_grant", why: "redirect_uri" });
      const { sub, ...rest } = got.who;
      const id_token = await new SignJWT({ ...rest, nonce: got.lie === "nonce" ? "not-the-nonce" : got.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(got.lie === "issuer" ? "https://someone-else.example" : fake.issuer)
        .setAudience(got.lie === "audience" ? "another-client" : fake.clientId)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { access_token: `at-${randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: 300, id_token });
    }
    if (url.pathname === "/userinfo") return json(200, { sub: fake.next.sub });
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  fake.issuer = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
