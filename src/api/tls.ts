/**
 * TLS and mutual TLS for the API listener.
 *
 * Between nodes on a jurisdictional network, a client certificate is the
 * practical answer: there is no browser, no user, and no interactive consent
 * flow — just two hosts that must each prove what they are. `requestCert` plus
 * `rejectUnauthorized` makes the TLS handshake itself the first gate, so an
 * untrusted caller never reaches the router.
 *
 * Certificates come from the filesystem, so an operator points these at
 * whatever their jurisdiction issues. scripts/gen-dev-certs.sh produces a
 * self-signed set for local work.
 */
import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";

export interface TlsConfig {
  serverOptions: ServerOptions;
  mutual: boolean;
}

export interface TlsEnv {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  /** Require a trusted client certificate. Needs caPath. */
  requireClientCert?: boolean;
}

/**
 * Builds TLS options, or returns null when no certificate is configured (the
 * plain-HTTP case). Throws when configuration is half-present, because a
 * silently-plaintext listener is worse than a startup failure.
 */
export function tlsFromEnv(env: TlsEnv): TlsConfig | null {
  const { certPath, keyPath, caPath, requireClientCert } = env;
  if (!certPath && !keyPath) {
    if (requireClientCert) throw new Error("NORTHSTAR_TLS_CLIENT_CA set without NORTHSTAR_TLS_CERT/KEY");
    return null;
  }
  if (!certPath || !keyPath) throw new Error("NORTHSTAR_TLS_CERT and NORTHSTAR_TLS_KEY must both be set");

  const serverOptions: ServerOptions = {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
    minVersion: "TLSv1.2",
  };

  if (requireClientCert) {
    if (!caPath) throw new Error("mutual TLS requires NORTHSTAR_TLS_CLIENT_CA");
    serverOptions.ca = readFileSync(caPath);
    serverOptions.requestCert = true;
    serverOptions.rejectUnauthorized = true;
  }

  return { serverOptions, mutual: Boolean(requireClientCert) };
}
