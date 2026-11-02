import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import { startApi } from '../src/api/admin.ts';
import { AuthGate } from '../src/auth/gate.ts';
import { ClinicBoard } from '../src/workspace/board.ts';

test('arrangement actions bind privacy to the stored patient, audit writes and isolate tenants', async () => {
  const engine = new Engine({ dbPath: ':memory:', tickMs: 15 });
  await engine.start();
  const t = engine.forTenant('default');
  const by = { actorId: 'clerk', actorKind: 'practitioner' };
  const key = t.keys.issue('operator', ['admin']).key;
  const readKey = t.keys.issue('reader', ['read']).key;
  engine.db.createTenant('other', 'Other clinic');
  const otherKey = engine.forTenant('other').keys.issue('other-operator', ['admin']).key;
  const api = await startApi(engine, 0, '127.0.0.1', { auth: new AuthGate({ keys: engine.keys }) });
  const base = `http://127.0.0.1:${api.port}`;
  const post = (op: string, body: unknown, token = key, suffix = '') => fetch(`${base}/api/clinical/arrangement-${op}${suffix}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const visit = t.clinics.planVisit({ resourceId: 'doctor', service: 'Clinic', community: 'Test', days: [{ date: '2026-12-02', from: '09:00', to: '12:00' }], slotMinutes: 30, by }).visit;
    const make = (patientId: string) => t.arrangements.request({ visitId: visit.id, patientId, kind: 'transport', detail: 'Synthetic transport need', by });
    const hidden = make('PRIVATE'); const visible = make('VISIBLE');
    t.consent.record({ patientId: 'PRIVATE', kind: 'withhold-all', by });
    for (const [op,field] of [['assign','ownerId'],['confirm','evidence'],['cancel','reason']]) {
      assert.equal((await post(op, { id: hidden.id, [field]: 'details' }, key, '?patient=VISIBLE')).status, 403, 'a different query patient cannot bypass the directive');
      assert.equal((await post(op, { id: visible.id, [field]: 'details' }, readKey)).status, 403);
      assert.equal((await post(op, { id: visible.id, [field]: 'details' }, otherKey)).status, 404);
      assert.equal((await post(op, { id: visible.id, [field]: '  ' })).status, 400);
      assert.equal((await post(op, { id: visible.id, [field]: {} })).status, 400);
    }
    assert.deepEqual(t.arrangements.get(hidden.id), hidden, 'refused requests do not alter the arrangement');
    assert.equal((await post('assign', { id: visible.id, ownerId: ' nurse-2 ' })).status, 200);
    assert.equal(t.arrangements.get(visible.id)!.owner_id, 'nurse-2');
    assert.equal(t.audit.list({ limit: 1 })[0].patient, 'VISIBLE');
    assert.equal((await post('confirm', { id: visible.id, evidence: 'Confirmed by phone with transport desk' })).status, 200);
    assert.equal(t.arrangements.get(visible.id)!.confirmation_evidence, 'Confirmed by phone with transport desk');
    assert.notEqual((await post('confirm', { id: visible.id, evidence: 'Second click' })).status, 200);
    const cancelled = make('VISIBLE');
    assert.equal((await post('cancel', { id: cancelled.id, reason: 'Patient arranged their own transport' })).status, 200);
    assert.equal(t.arrangements.get(cancelled.id)!.cancelled_reason, 'Patient arranged their own transport');
    assert.notEqual((await post('assign', { id: cancelled.id, ownerId: 'someone' })).status, 200);
    const board = await (await fetch(base + '/api/clinical/clinic-attention', { headers: { authorization: `Bearer ${key}` } })).json() as any;
    assert.deepEqual({ count: board.arrangements.count, withheld: board.arrangements.withheldCount }, { count: 0, withheld: 1 });
    assert.equal(JSON.stringify(board).includes('PRIVATE'), false);
    assert.deepEqual(t.board.attention().unconfirmedArrangements!.rows.map(r => r.id), [hidden.id]);
    const unwired = new ClinicBoard({ schedule: t.schedule, encounters: t.encounters, tasks: t.tasks, discharges: t.discharges, handoffs: t.handoffs });
    assert.equal(unwired.attention().unconfirmedArrangements, undefined);
    assert.equal(engine.forTenant('other').board.attention().unconfirmedArrangements!.rows.length, 0);
    const otherBoard = await (await fetch(base + '/api/clinical/clinic-attention', { headers: { authorization: `Bearer ${otherKey}` } })).json() as any;
    assert.equal(otherBoard.arrangements.count, 0);
    assert.equal(otherBoard.arrangements.withheldCount, 0);
    assert.equal((await fetch(base + '/api/clinical/clinic-attention', { headers: { authorization: `Bearer ${readKey}` } })).status, 403);
    const original = t.arrangements.unconfirmed;
    t.arrangements.unconfirmed = () => { throw new Error('Synthetic source failure'); };
    try {
      const failed = await fetch(base + '/api/clinical/clinic-attention', { headers: { authorization: `Bearer ${key}` } });
      assert.equal(failed.status, 500, 'a source failure is not an empty board');
    } finally { t.arrangements.unconfirmed = original; }
  } finally { await api.close(); await engine.stop(); }
});
