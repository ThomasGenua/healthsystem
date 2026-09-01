/**
 * Where a resource came from, which is not the question the audit trail answers.
 *
 * `audit_events` is a hash-chained record of access and system activity, and
 * it is the right shape for "who read this chart, when, and were they allowed
 * to". It is the wrong shape for "where did this observation come from". An
 * audit row can say a laboratory feed wrote something at 04:12. It cannot say
 * that this potassium was produced by mapping version 3 from message 8812, or
 * that this medication entry arrived in a migration rather than from a
 * prescriber, or that this risk score was computed by an approved instrument
 * at a stated version.
 *
 * Those are the questions asked after something goes wrong, and they are
 * asked about the data rather than about the people. Treating the two records
 * as interchangeable loses whichever one was not on somebody's mind when the
 * row was written — so they are separate stores here, and the tests assert
 * they answer different questions rather than the same question twice.
 *
 * ## Deliberately not chained
 *
 * The audit trail is chained because its integrity claim is that nothing was
 * removed from it. Provenance makes no such claim: each record is a statement
 * about one write, and the sequence that matters is the resource's own version
 * history, which each record names. Chaining it would imply a completeness
 * guarantee this does not have — a resource written by a path that does not
 * record provenance would leave a gap the chain would then assert over.
 *
 * ## Unattributed is a value
 *
 * Where nothing stated an actor, the agent is null and the record says so. It
 * is not filled in with whoever happened to be on the request, because a
 * lineage naming the wrong author is worse than one admitting it does not
 * know: the first is believed.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db.ts";

export type ProvenanceActivity = "create" | "update" | "transform" | "import" | "reconcile" | "compute";

export interface ProvenanceInput {
  target: { type: string; id: string; version: number };
  activity: ProvenanceActivity;
  agent?: { id: string; kind: string; organizationId?: string };
  source?: { kind: "message" | "resource" | "file"; id: string };
  /** The mapping or pipeline that produced this, and the version that ran. */
  transformation?: { id: string; version: string };
  /** The clinical rule or instrument, for a computed result. */
  rule?: { id: string; version: string };
  /** When the thing described happened, if not when it was recorded. */
  occurredAt?: string;
  at?: Date;
}

export interface ProvenanceRow {
  id: string;
  target: { type: string; id: string; version: number };
  activity: ProvenanceActivity;
  agent: { id: string; kind: string; organizationId: string | null } | null;
  source: { kind: string; id: string } | null;
  transformation: { id: string; version: string | null } | null;
  rule: { id: string; version: string | null } | null;
  occurredAt: string | null;
  recordedAt: string;
}

function toRow(r: Record<string, unknown>): ProvenanceRow {
  const agentId = r.agent_id as string | null;
  const transformation = r.transformation as string | null;
  const ruleId = r.rule_id as string | null;
  return {
    id: String(r.id),
    target: { type: String(r.target_type), id: String(r.target_id), version: Number(r.target_version) },
    activity: String(r.activity) as ProvenanceActivity,
    agent: agentId
      ? { id: agentId, kind: String(r.agent_kind ?? "unknown"), organizationId: (r.organization_id as string | null) ?? null }
      : null,
    source: r.source_kind ? { kind: String(r.source_kind), id: String(r.source_id ?? "") } : null,
    transformation: transformation ? { id: transformation, version: (r.transformation_version as string | null) ?? null } : null,
    rule: ruleId ? { id: ruleId, version: (r.rule_version as string | null) ?? null } : null,
    occurredAt: (r.occurred_at as string | null) ?? null,
    recordedAt: String(r.recorded_at),
  };
}

export class ProvenanceStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(input: ProvenanceInput): ProvenanceRow {
    const id = randomUUID();
    const now = (input.at ?? new Date()).toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO provenance
           (tenant_id, id, target_type, target_id, target_version, activity,
            agent_id, agent_kind, organization_id, source_kind, source_id,
            transformation, transformation_version, rule_id, rule_version,
            occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.db.tenantId, id, input.target.type, input.target.id, input.target.version, input.activity,
        input.agent?.id ?? null, input.agent?.kind ?? null, input.agent?.organizationId ?? null,
        input.source?.kind ?? null, input.source?.id ?? null,
        input.transformation?.id ?? null, input.transformation?.version ?? null,
        input.rule?.id ?? null, input.rule?.version ?? null,
        input.occurredAt ?? null, now
      );
    return this.require(id);
  }

  get(id: string): ProvenanceRow | undefined {
    const row = this.db.sql
      .prepare("SELECT * FROM provenance WHERE tenant_id = ? AND id = ?")
      .get(this.db.tenantId, id) as unknown as Record<string, unknown> | undefined;
    return row ? toRow(row) : undefined;
  }

  private require(id: string): ProvenanceRow {
    const row = this.get(id);
    if (!row) throw new Error(`provenance ${id} vanished immediately after being written`);
    return row;
  }

  /**
   * Every recorded step behind one resource, newest version first.
   *
   * This is the lineage read: a correction and the value it replaced each
   * carry their own record, so the history survives the resource being
   * overwritten.
   */
  forTarget(type: string, id: string): ProvenanceRow[] {
    return (
      this.db.sql
        .prepare(
          `SELECT * FROM provenance WHERE tenant_id = ? AND target_type = ? AND target_id = ?
             ORDER BY target_version DESC, recorded_at DESC`
        )
        .all(this.db.tenantId, type, id) as unknown as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /** Everything produced from one inbound message, for tracing a bad feed. */
  forSource(kind: string, sourceId: string): ProvenanceRow[] {
    return (
      this.db.sql
        .prepare(
          "SELECT * FROM provenance WHERE tenant_id = ? AND source_kind = ? AND source_id = ? ORDER BY recorded_at"
        )
        .all(this.db.tenantId, kind, sourceId) as unknown as Array<Record<string, unknown>>
    ).map(toRow);
  }

  /**
   * The FHIR projection.
   *
   * `agent` is required by the R4 structure, so an unattributed write is
   * expressed as an agent whose type is `unknown` rather than by omitting the
   * element and producing an invalid resource. The distinction stays legible:
   * nothing claims a person who was never recorded.
   */
  toFhir(row: ProvenanceRow, baseUrl = ""): Record<string, unknown> {
    const ref = (t: string, i: string) => ({ reference: `${baseUrl}${baseUrl ? "/" : ""}${t}/${i}` });
    const agents: Array<Record<string, unknown>> = [
      row.agent
        ? {
            type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "author" }] },
            who: { identifier: { value: row.agent.id }, display: `${row.agent.kind} ${row.agent.id}` },
            ...(row.agent.organizationId ? { onBehalfOf: ref("Organization", row.agent.organizationId) } : {}),
          }
        : {
            type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "author" }] },
            who: { display: "unattributed: no actor was recorded for this write" },
          },
    ];
    if (row.transformation) {
      agents.push({
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "assembler" }] },
        who: { display: `${row.transformation.id}${row.transformation.version ? ` v${row.transformation.version}` : ""}` },
      });
    }
    if (row.rule) {
      agents.push({
        type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type", code: "performer" }] },
        who: { display: `${row.rule.id}${row.rule.version ? ` v${row.rule.version}` : ""}` },
      });
    }
    return {
      resourceType: "Provenance",
      id: row.id,
      target: [{ ...ref(row.target.type, row.target.id), display: `version ${row.target.version}` }],
      recorded: row.recordedAt,
      ...(row.occurredAt ? { occurredDateTime: row.occurredAt } : {}),
      activity: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-DataOperation", code: row.activity.toUpperCase() }] },
      agent: agents,
      ...(row.source
        ? { entity: [{ role: "source", what: { identifier: { system: `urn:northstar:${row.source.kind}`, value: row.source.id } } }] }
        : {}),
    };
  }
}
