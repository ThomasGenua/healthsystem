/**
 * The scope model and the route-to-scope map.
 *
 * Four scopes. The first three are system scopes; `patient` is deliberately a
 * separate trust boundary. A SMART `patient/*.read` token must never become a
 * general `read` token: the latter can read every Patient on the FHIR facade,
 * while the former may reach only records for which its OAuth subject has a
 * live patient_authority grant.
 *
 *   admin   operate the engine: channels, messages, the delivery queue, keys
 *   read    read the FHIR facade and the terminology/conformance lookups
 *   write   push messages in through an ingest or FHIR source
 *   patient reach the patient/proxy surface, still subject to a live grant
 *
 * `admin` implies the other system scopes. It does not imply `patient`: an
 * operator is not the patient, and the separate surface refuses API keys even
 * if one is mis-issued with that word on it.
 */
export type Scope = "admin" | "read" | "write" | "patient";

/** Scopes that may be put on service/API-key credentials. */
export const ALL_SCOPES: Scope[] = ["admin", "read", "write"];

export function isScope(s: string): s is Scope {
  return s === "admin" || s === "read" || s === "write" || s === "patient";
}

/** Expands implied scopes: admin covers everything. */
export function effectiveScopes(granted: Iterable<string>): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted) {
    if (isScope(s)) out.add(s);
  }
  if (out.has("admin")) {
    out.add("read");
    out.add("write");
  }
  return out;
}

/**
 * SMART on FHIR scopes map onto the three above. A token minted by an identity
 * provider speaks `system/Patient.read`, not `read`, so translate rather than
 * demanding callers configure Portage-specific scope names in their IdP.
 *
 * Both SMART v1 (`.read` / `.write` / `.*`) and v2 (`.rs` / `.cud` / `.cruds`)
 * verb syntax are accepted.
 */
export function scopesFromSmart(raw: Iterable<string>): Set<Scope> {
  const out = new Set<string>();
  for (const s of raw) {
    if (isScope(s)) {
      out.add(s);
      continue;
    }
    // portage/admin is the escape hatch for operator tokens, since SMART has
    // no notion of "administer the interface engine".
    if (s === "portage/admin" || s === "system/*.admin") {
      out.add("admin");
      continue;
    }
    const m = /^(system|user|patient)\/[^.]+\.(.+)$/.exec(s);
    if (!m) continue;
    const context = m[1];
    const verb = m[2];
    // The most important line in this map. Patient-context scopes are not a
    // small spelling of system read/write; they open only /patient/*, where a
    // subject-to-patient authority check runs again on every request.
    if (context === "patient") {
      if (verb === "*" || verb === "read" || verb === "write" || /^[cruds]+$/.test(verb)) {
        out.add("patient");
      }
      continue;
    }
    if (verb === "*") {
      out.add("read");
      out.add("write");
    } else if (verb === "read") {
      out.add("read");
    } else if (verb === "write") {
      out.add("write");
    } else if (/^[cruds]+$/.test(verb)) {
      // SMART v2 spells permissions as a subset of c-r-u-d-s. Tested only
      // after the v1 words are ruled out: "read" is not a v2 verb, and
      // treating it as one would read its "d" as delete and grant write.
      if (verb.includes("r") || verb.includes("s")) out.add("read");
      if (/[cud]/.test(verb)) out.add("write");
    }
  }
  return effectiveScopes(out);
}

/**
 * The scope a request needs, or null when the route is public.
 *
 * Public by design: the admin UI shell, liveness, and the CapabilityStatement.
 * A CapabilityStatement is a discovery document — a client has to be able to
 * read it to learn how to authenticate against everything else.
 */
export function requiredScope(method: string, path: string): Scope | null {
  if (method === "GET" && (path === "/" || path === "/ui")) return null;
  if (method === "GET" && path === "/api/health") return null;
  // Metrics carry counters, ages and channel ids — no patient data — and a
  // scrape happens before any credential is configured, so it is open like
  // liveness is.
  if (method === "GET" && path === "/metrics") return null;
  if (method === "GET" && path === "/fhir/metadata") return null;

  if (path === "/patient" || path.startsWith("/patient/")) return "patient";
  if (path.startsWith("/api/")) return "admin";
  if (path.startsWith("/ingest/")) return "write";

  // The audit trail is served under /fhir/ for consumers that expect the
  // standard AuditEvent shape, but it is not clinical data: it records who
  // looked at whom. A consumer with read access to the facade must not also
  // learn the access history of every patient in it.
  if (path === "/fhir/AuditEvent" || path.startsWith("/fhir/AuditEvent/")) return "admin";

  // A Subscription is likewise not clinical data. It is a standing instruction
  // to send patient records to an address, which is a routing decision of
  // exactly the kind POST /api/channels makes — and that needs admin.
  //
  // Under the general rule below it needed only `write`, which is what a feed
  // is given: a lab or an ADT sender that should be able to push messages in
  // and nothing else. That credential could register a rest-hook of its own
  // choosing and have the facade's contents delivered to it, turning push-only
  // access into a continuous read of the clinical record. Reading the list is
  // admin for the same reason the audit trail is — it enumerates every place
  // patient data has been arranged to go.
  if (path === "/fhir/Subscription" || path.startsWith("/fhir/Subscription/")) return "admin";

  if (path.startsWith("/fhir/")) return method === "GET" ? "read" : "write";

  // Anything unrouted falls through to a 404 handler, but make the default
  // deny rather than allow so a new route added without thought is closed.
  return "admin";
}
