/**
 * Declarative conformance validation. A pack holds per-resource-type rules:
 * cardinality, fixed values, patterns, code membership (inline or against a
 * ValueSet in the terminology store), required keys per element, and oneOf
 * choices. This is deliberately not a full StructureDefinition engine; it is
 * the working subset that catches the failures that actually break exchange,
 * and packs are data, so tightening a profile never touches code.
 */
import type { ConformanceIssue, ConformancePack, ProfileRule } from "../types.ts";
import type { TerminologyStore } from "../terminology/store.ts";

export class ConformanceRegistry {
  private packs = new Map<string, ConformancePack>();

  register(pack: ConformancePack): void {
    if (!pack.id || !Array.isArray(pack.profiles)) throw new Error("Conformance pack requires id and profiles");
    this.packs.set(pack.id, pack);
  }

  get(id: string): ConformancePack | undefined {
    return this.packs.get(id);
  }

  list(): Array<{ id: string; name: string; profiles: string[]; capability: boolean }> {
    return [...this.packs.values()].map((p) => ({
      id: p.id,
      name: p.name,
      profiles: p.profiles.map((x) => x.resourceType),
      capability: !!p.capability,
    }));
  }
}

/** Collect values at a dot path; arrays flatten at every hop. */
export function collect(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];
  for (const raw of path.split(".")) {
    const key = raw.replace(/\[\]$/, "");
    const next: unknown[] = [];
    for (const v of current) {
      if (v == null || typeof v !== "object") continue;
      const child = (v as Record<string, unknown>)[key];
      if (child == null) continue;
      if (Array.isArray(child)) next.push(...child);
      else next.push(child);
    }
    current = next;
  }
  return current.filter((v) => v !== null && v !== undefined && v !== "");
}

export function validateResource(
  pack: ConformancePack,
  resource: Record<string, unknown>,
  terminology?: TerminologyStore
): ConformanceIssue[] {
  const type = String(resource.resourceType ?? "");
  const profile = pack.profiles.find((p) => p.resourceType === type);
  if (!profile) {
    return [{ severity: "information", message: `Pack ${pack.id} has no profile for ${type || "(missing resourceType)"}` }];
  }
  const issues: ConformanceIssue[] = [];
  for (const rule of profile.rules) issues.push(...checkRule(rule, resource, terminology));
  return issues;
}

function checkRule(rule: ProfileRule, resource: Record<string, unknown>, terminology?: TerminologyStore): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const desc = rule.description ? ` (${rule.description})` : "";

  if (rule.oneOf) {
    const present = rule.oneOf.filter((p) => collect(resource, p).length > 0);
    const min = rule.min ?? 1;
    if (present.length < min) {
      issues.push({
        severity: "error",
        path: rule.oneOf.join(" | "),
        message: `Expected at least ${min} of [${rule.oneOf.join(", ")}], found ${present.length}${desc}`,
      });
    }
    return issues;
  }

  if (!rule.path) return issues;
  const values = collect(resource, rule.path);

  if (rule.min !== undefined && values.length < rule.min) {
    issues.push({ severity: "error", path: rule.path, message: `Expected at least ${rule.min}, found ${values.length}${desc}` });
  }
  if (rule.max !== undefined && values.length > rule.max) {
    issues.push({ severity: "error", path: rule.path, message: `Expected at most ${rule.max}, found ${values.length}${desc}` });
  }
  if (rule.fixed !== undefined) {
    for (const v of values) {
      if (String(v) !== String(rule.fixed)) {
        issues.push({ severity: "error", path: rule.path, message: `Value "${String(v)}" must equal "${String(rule.fixed)}"${desc}` });
        break;
      }
    }
  }
  if (rule.pattern) {
    const re = new RegExp(rule.pattern);
    for (const v of values) {
      if (typeof v !== "string" || !re.test(v)) {
        issues.push({ severity: "error", path: rule.path, message: `Value "${String(v)}" does not match ${rule.pattern}${desc}` });
        break;
      }
    }
  }
  if (rule.inSet) {
    const set = new Set(rule.inSet.map(String));
    for (const v of values) {
      if (!set.has(String(v))) {
        issues.push({ severity: "error", path: rule.path, message: `Value "${String(v)}" not in [${rule.inSet.join(", ")}]${desc}` });
        break;
      }
    }
  }
  if (rule.valueSetRef) {
    if (!terminology) {
      issues.push({ severity: "warning", path: rule.path, message: `Rule references ValueSet ${rule.valueSetRef} but no terminology store is attached` });
    } else {
      const members = terminology.memberCodes(rule.valueSetRef);
      for (const v of values) {
        if (!members.has(String(v))) {
          issues.push({ severity: "error", path: rule.path, message: `Code "${String(v)}" is not in ValueSet ${rule.valueSetRef}${desc}` });
          break;
        }
      }
    }
  }
  if (rule.each) {
    values.forEach((v, i) => {
      if (v == null || typeof v !== "object") {
        issues.push({ severity: "error", path: rule.path, message: `Element ${i} is not an object${desc}` });
        return;
      }
      for (const req of rule.each!.required) {
        const val = (v as Record<string, unknown>)[req];
        if (val === null || val === undefined || val === "") {
          issues.push({ severity: "error", path: `${rule.path}[${i}].${req}`, message: `Missing required ${req}${desc}` });
        }
      }
    });
  }
  return issues;
}

/** Exchange-level check: does the facade CapabilityStatement cover the pack? */
export function checkCapability(
  pack: ConformancePack,
  capability: Record<string, unknown>
): { ok: boolean; issues: ConformanceIssue[] } {
  const issues: ConformanceIssue[] = [];
  if (!pack.capability) return { ok: true, issues };
  const rest = (capability.rest as Array<{ resource?: Array<{ type: string; interaction?: Array<{ code: string }> }> }>) ?? [];
  const resources = rest[0]?.resource ?? [];
  for (const type of pack.capability.resourceTypes) {
    const entry = resources.find((r) => r.type === type);
    if (!entry) {
      issues.push({ severity: "error", message: `CapabilityStatement missing resource ${type}` });
      continue;
    }
    const have = new Set((entry.interaction ?? []).map((i) => i.code));
    for (const need of pack.capability.interactions) {
      if (!have.has(need)) issues.push({ severity: "error", message: `Resource ${type} missing interaction ${need}` });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function toOperationOutcome(issues: ConformanceIssue[]): Record<string, unknown> {
  if (issues.length === 0) {
    return { resourceType: "OperationOutcome", issue: [{ severity: "information", code: "informational", diagnostics: "Valid" }] };
  }
  return {
    resourceType: "OperationOutcome",
    issue: issues.map((i) => ({
      severity: i.severity,
      code: i.severity === "error" ? "invariant" : "informational",
      diagnostics: i.message,
      ...(i.path ? { expression: [i.path] } : {}),
    })),
  };
}
