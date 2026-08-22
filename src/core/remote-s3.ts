/**
 * An S3-compatible destination for a snapshot that has left the machine.
 *
 * No AWS SDK: the four calls a backup needs (put, get, list, delete) are
 * SigV4-signed `fetch` requests. That keeps the engine free of a required
 * runtime dependency, and it works against MinIO, Wasabi, Cloudflare R2 and
 * the rest of the S3-shaped world, not only AWS.
 *
 * HTTPS is required except on loopback. Sending a chart, an allergy list and
 * an audit trail to a remote over cleartext because somebody typed `http://`
 * is the kind of quiet failure this codebase refuses.
 */
import { createHash, createHmac } from "node:crypto";

export interface S3Config {
  bucket: string;
  /** Object-key prefix, no leading or trailing slash. */
  prefix: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /**
   * API endpoint. Unset means AWS virtual-hosted (`https://bucket.s3.region.amazonaws.com`).
   * A custom endpoint (MinIO, a regional S3-compatible) is path-style.
   */
  endpoint?: string;
  /** Override fetch, so tests can drive the signer without a network. */
  fetch?: typeof fetch;
  /** Override the clock, so a signature can be pinned. */
  now?: () => Date;
}

export interface S3Object {
  key: string;
  bytes: number;
}

export class S3RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "S3RequestError";
    this.status = status;
  }
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function amzDate(d: Date): { stamp: string; date: string } {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return { stamp: iso, date: iso.slice(0, 8) };
}

/**
 * URI-encode a single path segment the way SigV4 wants: every byte except
 * unreserved characters, and slashes left intact when `keepSlash` is set so a
 * key like `portage/a.db.enc` stays one path.
 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9._~-]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else {
      const buf = Buffer.from(ch, "utf8");
      for (const b of buf) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
}

function queryString(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
}

function target(cfg: S3Config, key: string, query?: Record<string, string>): { url: URL; host: string; canonicalUri: string } {
  const object = [cfg.prefix, key].filter(Boolean).join("/");
  if (cfg.endpoint) {
    const url = new URL(cfg.endpoint);
    if (url.protocol !== "https:" && !isLoopback(url)) {
      throw new Error(
        `PORTAGE_BACKUP_S3_ENDPOINT must be https (got ${url.protocol}//${url.host}); ` +
          "a snapshot is the clinical record, and cleartext is refused except on loopback"
      );
    }
    const path = `/${[cfg.bucket, object].filter(Boolean).join("/")}`;
    url.pathname = path;
    url.search = query ? `?${queryString(query)}` : "";
    return { url, host: url.host, canonicalUri: uriEncode(path, true) };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  const path = object ? `/${object}` : "/";
  const url = new URL(`https://${host}${path}`);
  url.search = query ? `?${queryString(query)}` : "";
  return { url, host, canonicalUri: uriEncode(path, true) };
}

export async function s3Request(
  cfg: S3Config,
  method: string,
  key: string,
  opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const now = (cfg.now ?? (() => new Date()))();
  const { stamp, date } = amzDate(now);
  const payload = opts.body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const { url, host, canonicalUri } = target(cfg, key, opts.query);

  const extra = opts.headers ?? {};
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
    ...extra,
  };
  const headerLookup = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const signedNames = [...headerLookup.keys()].sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headerLookup.get(n)}\n`).join("");

  const canonicalRequest = [
    method,
    canonicalUri,
    opts.query ? queryString(opts.query) : "",
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(cfg.secretKey, date, cfg.region, "s3"), stringToSign).toString("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
    `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;

  const fetchFn = cfg.fetch ?? fetch;
  const res = await fetchFn(url, {
    method,
    headers,
    body: opts.body && opts.body.length > 0 ? new Uint8Array(opts.body) : undefined,
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
}

function s3Message(status: number, body: Buffer, fallback: string): string {
  const text = body.toString("utf8");
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
  if (code || msg) return `S3 ${status} ${code ?? ""} ${msg ?? ""}`.trim();
  return `${fallback} (HTTP ${status})`;
}

export async function s3Put(cfg: S3Config, name: string, body: Buffer): Promise<void> {
  const res = await s3Request(cfg, "PUT", name, { body });
  if (res.status !== 200 && res.status !== 204) {
    throw new S3RequestError(res.status, s3Message(res.status, res.body, `PUT ${name} failed`));
  }
}

export async function s3Get(cfg: S3Config, name: string): Promise<Buffer> {
  const res = await s3Request(cfg, "GET", name);
  if (res.status !== 200) {
    throw new S3RequestError(res.status, s3Message(res.status, res.body, `GET ${name} failed`));
  }
  return res.body;
}

export async function s3Delete(cfg: S3Config, name: string): Promise<"deleted" | "denied"> {
  const res = await s3Request(cfg, "DELETE", name);
  if (res.status === 200 || res.status === 204) return "deleted";
  if (res.status === 403) return "denied";
  throw new S3RequestError(res.status, s3Message(res.status, res.body, `DELETE ${name} failed`));
}

export async function s3List(cfg: S3Config): Promise<S3Object[]> {
  const prefix = cfg.prefix ? `${cfg.prefix}/` : "";
  const out: S3Object[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2" };
    if (prefix) query.prefix = prefix;
    if (token) query["continuation-token"] = token;
    const res = await s3Request(cfg, "GET", "", { query });
    if (res.status !== 200) {
      throw new S3RequestError(res.status, s3Message(res.status, res.body, "ListObjects failed"));
    }
    const xml = res.body.toString("utf8");
    const re = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      out.push({ key: m[1], bytes: Number(m[2]) });
    }
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    token = truncated ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
  } while (token);
  return out;
}

/** Exported so a unit test can pin the signature against a fixed clock and payload. */
export function signCanonicalRequestForTest(
  cfg: Pick<S3Config, "accessKey" | "secretKey" | "region">,
  canonicalRequest: string,
  stamp: string
): string {
  const date = stamp.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  return hmac(signingKey(cfg.secretKey, date, cfg.region, "s3"), stringToSign).toString("hex");
}
