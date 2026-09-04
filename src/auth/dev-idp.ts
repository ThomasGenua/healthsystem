/**
 * A synthetic identity provider, for development only.
 *
 * Northstar is a resource server: it validates tokens and does not issue
 * them. That is a deliberate boundary, and the portal must not be the thing
 * that erodes it — so this does not add a sign-in path to the engine. It adds
 * an *issuer*, and the engine goes on validating tokens exactly as it
 * validates a real identity provider's: `JwtVerifier` fetches this JWKS over
 * HTTP, checks the `kid`, the algorithm, the signature, the issuer, the
 * audience and the expiry, and knows nothing about where the token came from.
 *
 * There is no branch in `AuthGate` for development. Nothing here is reachable
 * from the validation path. Turn it off and the portal signs in against
 * Entra, Keycloak or ONE ID with no code change, because it was never signing
 * in against anything else.
 *
 * ## Why it is safe to have in the tree
 *
 * Three properties, and none of them is a configuration option:
 *
 *   - **It is mutually exclusive with a real issuer.** `server.ts` refuses to
 *     start when `NORTHSTAR_DEV_IDP=on` and `NORTHSTAR_OIDC_ISSUER` are both
 *     set. There is no state in which a deployment is half on a real provider
 *     and half on this.
 *   - **The signing key is generated at boot and never written down.** No key
 *     file exists to leak or to be copied to a second machine, and every
 *     token this ever issued stops verifying the moment the process exits.
 *   - **It cannot invent authority.** `subjects()` lists only OAuth subjects
 *     that already hold a live `patient_authority` grant, which a named clerk
 *     at the clinic had to write a method to create. Signing in as somebody
 *     is impossible until the clinic has said who they are — which is the
 *     real constraint, modelled rather than bypassed.
 *
 * What it is not: identity proofing, ONE ID, a consent screen, or a login
 * anybody should point at a real person. It is a way to see the portal work.
 */
import { generateKeyPairSync, randomUUID, sign as cryptoSign, type KeyObject } from "node:crypto";

export interface DevSubject {
  /** The OAuth subject id, which is what a grant names. */
  subject: string;
  /** The custodian the grant lives under. */
  tenantId: string;
  /** Charts this subject may reach, for the picker. Never a chart they may not. */
  patients: Array<{ patientId: string; relationship: string }>;
}

export interface DevIdpOptions {
  /** The issuer URL this provider answers as. Must match what the verifier is configured with. */
  issuer: string;
  /** The audience minted into every token. Must match the verifier's. */
  audience: string;
  /** Lists who may sign in. Called per request, so a revoked grant disappears from the picker. */
  liveSubjects: () => DevSubject[];
  /** Token lifetime. Short by default: this is a demo, not a session. */
  ttlSec?: number;
}

interface Jwk {
  kty: string;
  n?: string;
  e?: string;
  kid: string;
  alg: string;
  use: string;
}

const b64url = (value: object): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export class DevIdentityProvider {
  private readonly opts: DevIdpOptions;
  private readonly privateKey: KeyObject;
  private readonly jwk: Jwk;

  constructor(opts: DevIdpOptions) {
    this.opts = opts;
    // In memory, per process. A development provider that persisted its key
    // would be a development provider somebody could take to production.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    // The JWK is taken from the private key and stripped to its public half,
    // rather than from the public key directly: on Node 22,
    // `publicKey.export({format: "jwk"})` throws "Invalid key object type
    // public, expected private" for RSA. `n` and `e` *are* the public key —
    // everything else in an RSA private JWK is the secret — so this publishes
    // exactly what a public export would have, and the destructuring below is
    // what keeps `d`, `p`, `q` and the rest from ever reaching the object.
    const full = privateKey.export({ format: "jwk" }) as { kty?: string; n?: string; e?: string };
    this.jwk = {
      kty: full.kty ?? "RSA",
      n: full.n,
      e: full.e,
      kid: randomUUID(),
      alg: "RS256",
      use: "sig",
    };
  }

  get issuer(): string {
    return this.opts.issuer;
  }

  /** Enough of an OIDC discovery document for `JwtVerifier.discover()` to find the keys. */
  openidConfiguration(): Record<string, unknown> {
    const base = this.opts.issuer.replace(/\/+$/, "");
    return {
      issuer: this.opts.issuer,
      jwks_uri: `${base}/.well-known/jwks.json`,
      // Named so a reader of the document can see what this is. A real
      // provider would list an authorization endpoint here; this one has a
      // subject picker, and saying so is better than implying a flow it does
      // not implement.
      token_endpoint: `${base}/token`,
      subjects_endpoint: `${base}/subjects`,
      id_token_signing_alg_values_supported: ["RS256"],
      northstar_development_provider: true,
    };
  }

  jwks(): { keys: Jwk[] } {
    return { keys: [this.jwk] };
  }

  /** Who may sign in: subjects the clinic has already granted a chart to. */
  subjects(): DevSubject[] {
    return this.opts.liveSubjects();
  }

  /**
   * Mints a token for one of those subjects.
   *
   * Refuses anybody not on the list, so a token cannot be minted for a
   * subject whose grants have expired or been revoked between the picker
   * being drawn and the button being pressed.
   */
  issue(subject: string): { access_token: string; token_type: string; expires_in: number; subject: DevSubject } {
    const who = this.subjects().find((s) => s.subject === subject);
    if (!who) throw new Error(`no live grant for subject ${subject}; this provider cannot create authority`);

    const ttl = this.opts.ttlSec ?? 3600;
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: this.jwk.kid };
    const claims = {
      iss: this.opts.issuer,
      aud: this.opts.audience,
      sub: who.subject,
      iat: now,
      exp: now + ttl,
      // The one scope the patient surface accepts. Deliberately not a wider
      // one: a development token that could read the whole FHIR facade would
      // be testing a different boundary than the portal uses.
      scope: "patient/*.read",
      northstar_tenant: who.tenantId,
    };
    const signing = `${b64url(header)}.${b64url(claims)}`;
    const signature = cryptoSign("sha256", Buffer.from(signing, "utf8"), this.privateKey).toString("base64url");
    return { access_token: `${signing}.${signature}`, token_type: "Bearer", expires_in: ttl, subject: who };
  }
}

/**
 * Whether a development provider may run, and why not when it may not.
 *
 * Returns the refusal text rather than throwing, so `server.ts` can print it
 * and exit rather than showing a stack trace for what is a configuration
 * mistake.
 */
export function devIdpRefusal(env: { devIdp?: string; oidcIssuer?: string }): string | null {
  if ((env.devIdp ?? "").toLowerCase() !== "on") return "not enabled";
  if (env.oidcIssuer) {
    return (
      "NORTHSTAR_DEV_IDP=on and NORTHSTAR_OIDC_ISSUER are mutually exclusive. " +
      "The development provider replaces the identity provider; running both would leave half the " +
      "deployment trusting a key generated at boot. Unset one."
    );
  }
  return null;
}
