import type { Engine } from "../core/engine.ts";

/** One bounded, non-overlapping sweep per process; the engine owns the DB lock. */
export class UploadScanWorker {
  private engine: Engine;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  constructor(engine: Engine) { this.engine = engine; }
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.sweep().catch(() => console.warn("Upload scan sweep failed; check database availability")); }, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  sweep(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async run(): Promise<void> {
    const rows = this.engine.db.sql.prepare(`SELECT u.tenant_id, u.id, u.scan_attempts FROM intake_uploads u
      JOIN tenants t ON t.id = u.tenant_id AND t.status = 'active'
      WHERE u.status = 'pending-scan' AND u.scan_retry_at <= ?
      ORDER BY u.scan_retry_at, u.uploaded_at, u.id LIMIT 10`).all(Date.now()) as unknown as Array<{ tenant_id: string; id: string; scan_attempts: number }>;
    for (const row of rows) {
      if (this.stopping) break;
      const tenantState = this.engine.db.sql.prepare("SELECT status FROM tenants WHERE id = ?").get(row.tenant_id) as { status: string } | undefined;
      if (tenantState?.status !== "active") continue;
      // Persist the lease before awaiting I/O: a restart does not create a retry storm.
      const attempt = row.scan_attempts + 1;
      this.engine.db.sql.prepare(`UPDATE intake_uploads SET scan_attempts = ?, scan_retry_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending-scan'`).run(attempt, Date.now() + 60_000, row.tenant_id, row.id);
      try {
        const tenant = this.engine.forTenant(row.tenant_id);
        const scanned = await tenant.uploads.scanOne(row.id, { actorId: "upload-scan-worker", actorKind: "device" });
        tenant.audit.record({ action: "U", outcome: 0, principalId: "upload-scan-worker", principalKind: "device",
          method: "WORKER", path: "/internal/upload-scan", resourceType: "DocumentReference", patient: scanned.patient_id,
          detail: `upload ${row.id} scanned: ${scanned.status}` });
      } catch {
        const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt - 1, 7));
        this.engine.db.sql.prepare(`UPDATE intake_uploads SET scan_retry_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending-scan'`).run(Date.now() + delay, row.tenant_id, row.id);
        // No filename, patient identifier, daemon reply or payload in operational logs.
        console.warn("Upload scan failed; content quarantined and retry scheduled");
      }
    }
  }
  status(): { pending: number; retrying: number; oldestAgeSec: number; degraded: boolean } {
    const row = this.engine.db.sql.prepare(`SELECT COUNT(*) AS pending,
      COALESCE(SUM(CASE WHEN scan_attempts > 0 THEN 1 ELSE 0 END), 0) AS retrying,
      MIN(uploaded_at) AS oldest FROM intake_uploads WHERE status = 'pending-scan'`).get() as { pending: number; retrying: number; oldest: string | null };
    const oldestAgeSec = row.oldest ? Math.max(0, Math.floor((Date.now() - Date.parse(row.oldest)) / 1000)) : 0;
    return { pending: row.pending, retrying: row.retrying, oldestAgeSec, degraded: oldestAgeSec > 900 };
  }
}
