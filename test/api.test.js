const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { start, stop, reset, api, create, money, app } = require('./helpers');
const { today, addDays, monthOf, shiftMonth } = require('../src/lib/dates');
const { setSettings } = require('../src/services/settings');

before(start);
after(stop);
beforeEach(reset);

const T = today();
const YM = monthOf(T);

const entity = (o = {}) => create('entities', { type: 'llc', state: 'FL', purpose: 'hold_real_estate', formedAt: '2016-03-01', status: 'active', ...o });
const property = async (o = {}) => {
  const entityCode = o.entityCode || (await entity()).code;
  return create('properties', { name: 'Orchid Court', type: 'multifamily', entityCode, city: 'Miami', zip: '33101', unitCount: 3, status: 'owned', purchasePrice: money(240000000), estimatedValue: money(300000000), ...o });
};
const unit = (propertyCode, unitCode = 'A-101', o = {}) => create('units', { propertyCode, unitCode, type: '1br', areaSqm: 60, listedRent: money(180000), status: 'vacant', ...o });

test('no header needed; envelope, unknown route, health', async () => {
  await request(app).get('/health').expect(200);
  const res = await api.get('entities').expect(200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.page.total, 0);
  assert.ok(res.body.asOf);
  const nf = await api.get('nothing-here').expect(404);
  assert.equal(nf.body.error.code, 'not_found');
  assert.match(nf.body.error.requestId, /^req_/);
});

test('create: server codes, version 1, validation, enums, limits, read-only fields ignored', async () => {
  const bad = (await api.post('properties', { name: '', type: 'castle', unitCount: -1, zip: 'abc', city: 'x'.repeat(100), fullAddress: '1 Main St' }).expect(400)).body.error;
  assert.equal(bad.code, 'validation_failed');
  const codes = Object.fromEntries(bad.fields.map((f) => [f.field, f.code]));
  assert.equal(codes.name, 'required');
  assert.equal(codes.type, 'invalid_enum');
  assert.equal(codes.entityCode, 'required');
  assert.equal(codes.unitCount, 'out_of_range');
  assert.equal(codes.zip, 'invalid_format');
  assert.equal(codes.city, 'too_long');

  const e = await entity();
  assert.equal(e.code, 'PN-A');
  assert.equal(e.version, 1);
  assert.equal((await entity()).code, 'PN-B');
  const p = await property({ entityCode: e.code, id: 'x', code: 'HACK', version: 9, occupancyPct: 5 });
  assert.equal(p.code, 'TS-101');
  assert.equal(p.version, 1);
  assert.equal(p.occupancyPct, null, 'computed value is never taken from the body');
  assert.match(p.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal((await property({ entityCode: e.code })).code, 'TS-102');

  // full address only for commercial / land; refs must exist
  assert.equal((await api.post('properties', { name: 'A', type: 'multifamily', entityCode: e.code, city: 'Miami', zip: '33101', unitCount: 1, fullAddress: '1 Main St' }).expect(400)).body.error.fields[0].code, 'not_allowed');
  assert.equal((await api.post('properties', { name: 'A', type: 'land', entityCode: 'PN-ZZ', city: 'Miami', zip: '33101', unitCount: 0 }).expect(400)).body.error.fields[0].code, 'not_found');
});

test('money is write-only: accepted, never returned; PATCH keeps it when not sent', async () => {
  const p = await property();
  assert.equal('purchasePrice' in p, false);
  assert.equal('estimatedValue' in p, false);
  assert.equal(JSON.stringify(p).includes('amountMinor'), false);
  const bad = (await api.post('properties', { name: 'A', type: 'land', entityCode: p.entityCode, city: 'Miami', zip: '33101', unitCount: 0, purchasePrice: 5 }).expect(400)).body.error;
  assert.equal(bad.fields[0].field, 'purchasePrice');
  const res = await api.patch(`properties/${p.id}`, { version: 1, name: 'Orchid Court II' }).expect(200);
  assert.equal(res.body.data.version, 2);
  const list = await api.get('properties').expect(200);
  assert.equal(JSON.stringify(list.body).includes('amountMinor'), false);
  await api.get('properties?sort=purchasePrice').expect(400);
});

test('PATCH: version required, conflict returns the current record, unchanged data keeps version', async () => {
  const e = await entity();
  assert.equal((await api.patch(`entities/${e.id}`, { state: 'GA' }).expect(400)).body.error.fields[0].field, 'version');
  const ok = (await api.patch(`entities/${e.id}`, { version: 1, state: 'GA' }).expect(200)).body.data;
  assert.equal(ok.state, 'GA');
  assert.equal(ok.version, 2);
  const stale = (await api.patch(`entities/${e.id}`, { version: 1, state: 'TX' }).expect(409)).body.error;
  assert.equal(stale.code, 'version_conflict');
  assert.equal(stale.current.version, 2);
  assert.equal(stale.current.state, 'GA');
  assert.equal((await api.patch(`entities/${e.id}`, { version: 2, state: 'GA' }).expect(200)).body.data.version, 2);
  await api.patch('entities/nope', { version: 1 }).expect(404);
});

test('PII filter: 422 pii_detected with the kind; contact fields allow email / phone only', async () => {
  const e = await entity();
  for (const [note, kind] of [['ssn 123-45-6789', 'ssn'], ['ein 12-3456789', 'tax_id'], ['card 4242 4242 4242 4242', 'card'], ['acct 123456789012', 'account'], ['a@b.com', 'email'], ['call (305) 555-1234', 'phone']]) {
    const r = (await api.post('properties', { name: 'W', type: 'land', entityCode: e.code, city: 'Miami', zip: '33101', unitCount: 0, note }).expect(422)).body.error;
    assert.equal(r.code, 'pii_detected', note);
    assert.equal(r.fields[0].kind, kind, note);
    assert.equal(r.fields[0].field, 'note');
  }
  await create('vendors', { companyName: 'Cool Air LLC', serviceType: 'hvac', companyEmail: 'info@coolair.com', companyPhone: '305-555-1234' });
  assert.equal((await api.post('vendors', { companyName: 'Cool Air', serviceType: 'hvac', note: 'mail info@coolair.com' }).expect(422)).body.error.code, 'pii_detected');
});

test('list: limit/cursor, q (accent-insensitive), status, sort, filter by relation, stats', async () => {
  const e = await entity();
  await property({ entityCode: e.code, name: 'Đường Hoa' });
  await property({ entityCode: e.code, name: 'Beta Tower', status: 'selling' });
  await property({ entityCode: e.code, name: 'Gamma Plaza', status: 'selling' });
  const p1 = (await api.get('properties?limit=2&sort=name').expect(200)).body;
  assert.deepEqual(p1.data.map((x) => x.name), ['Beta Tower', 'Gamma Plaza']);
  assert.equal(p1.page.total, 3);
  const p2 = (await api.get(`properties?limit=2&sort=name&cursor=${p1.page.nextCursor}`).expect(200)).body;
  assert.deepEqual(p2.data.map((x) => x.name), ['Đường Hoa']);
  assert.equal(p2.page.nextCursor, null);
  assert.equal((await api.get('properties?q=duong hoa').expect(200)).body.data.length, 1);
  assert.equal((await api.get('properties?q=SELLING').expect(200)).body.data.length, 2);
  assert.equal((await api.get('properties?status=selling,sold').expect(200)).body.data.length, 2);
  assert.equal((await api.get(`properties?entityCode=${e.code}`).expect(200)).body.data.length, 3);
  assert.equal((await api.get('properties?entityCode=PN-ZZ').expect(200)).body.data.length, 0);
  assert.deepEqual((await api.get('properties/stats').expect(200)).body.byStatus, { owned: 1, selling: 2 });
  assert.equal((await api.get('properties/stats').expect(200)).body.total, 3);
  assert.equal((await api.get('properties?sort=-name').expect(200)).body.data[0].name, 'Đường Hoa');
});

test('units, unit map, occupancy and vacancy on the property; unit codes are unique per property', async () => {
  const p = await property({ unitCount: 4 });
  const q = await property({ name: 'Second' });
  await unit(p.code, 'A-101', { status: 'leased' });
  await unit(p.code, 'A-102', { status: 'vacant', vacantSince: addDays(T, -10) });
  await unit(p.code, 'A-103', { status: 'vacating' });
  await unit(p.code, 'A-104', { status: 'repair' });
  await unit(q.code, 'A-101');
  await api.post('units', { propertyCode: p.code, unitCode: 'A-101', type: '1br', areaSqm: 50, status: 'vacant' }).expect(409);
  const got = (await api.get(`properties/${p.id}`).expect(200)).body.data;
  assert.equal(got.unitMap, 'LVSR');
  assert.equal(got.vacantCount, 1);
  assert.equal(got.occupancyPct, 25);
  const u = (await api.get(`units?propertyCode=${p.code}&sort=code`).expect(200)).body.data;
  assert.equal(u[1].code, 'A-102');
  assert.equal(u[1].vacantDays, 10);
  assert.equal((await api.patch(`units/${u[0].id}`, { version: 1, unitCode: 'B-1' }).expect(400)).body.error.fields[0].code, 'immutable');
});

test('lease lifecycle: derived status, computed fields, renew, terminate, queue item', async () => {
  const p = await property();
  await unit(p.code, 'A-101', { status: 'leased' });
  const lease = await create('leases', { propertyCode: p.code, unitCode: 'A-101', startDate: addDays(T, -300), endDate: addDays(T, 30), monthlyRent: money(180000), deposit: money(180000) });
  assert.equal(lease.code, 'HD-101');
  assert.equal(lease.status, 'expiring');
  assert.equal(lease.daysRemaining, 30);
  assert.ok(lease.elapsedPct > 85 && lease.elapsedPct < 95);
  assert.equal(lease.termMonths, 11);
  assert.equal((await api.post('leases', { propertyCode: p.code, unitCode: 'A-101', startDate: '2026-05-01', endDate: '2026-01-01', monthlyRent: money(1) }).expect(400)).body.error.fields[0].code, 'must_be_after_start');
  assert.equal((await api.post('leases', { propertyCode: p.code, unitCode: 'Z-9', startDate: '2026-01-01', endDate: '2027-01-01', monthlyRent: money(1) }).expect(400)).body.error.fields[0].code, 'not_found');
  let q = (await api.get('queue-items?type=lease_renewal').expect(200)).body.data;
  assert.equal(q.length, 1);
  assert.equal(q[0].autoGenerated, true);
  assert.equal(q[0].source.code, lease.code);

  const renewed = (await api.post(`leases/${lease.id}/renew`, { startDate: addDays(T, 31), endDate: addDays(T, 400), monthlyRent: money(190000) }).expect(200)).body.data;
  assert.equal(renewed.renewedFromCode, lease.code);
  assert.equal(renewed.status, 'upcoming');
  assert.equal((await api.get(`leases/${lease.id}`)).body.data.status, 'renewed');
  q = (await api.get('queue-items?type=lease_renewal').expect(200)).body.data;
  assert.equal(q[0].status, 'done', 'auto item closes once the lease is renewed');
  await api.post(`leases/${lease.id}/renew`, { startDate: addDays(T, 31), endDate: addDays(T, 400), monthlyRent: money(1) }).expect(409);
  const term = (await api.post(`leases/${renewed.id}/terminate`).expect(200)).body.data;
  assert.equal(term.status, 'terminated');
});

test('queue: vacant unit item is idempotent, claim, stats, manual items kept', async () => {
  const p = await property();
  const u = await unit(p.code, 'A-101');
  await api.patch(`units/${u.id}`, { version: 1, type: '2br' }).expect(200);
  const items = (await api.get('queue-items?type=vacant_unit').expect(200)).body.data;
  assert.equal(items.length, 1, 'no duplicate for the same source and type');
  await create('queue-items', { type: 'manual', title: 'Call insurer', priority: 'high' });
  const claim = (await api.post(`queue-items/${items[0].id}/claim`, { assigneeName: 'Linh' }).expect(200)).body.data;
  assert.equal(claim.status, 'claimed');
  assert.equal(claim.assigneeName, 'Linh');
  await api.post(`queue-items/${items[0].id}/claim`, { assigneeName: 'Linh' }).expect(409);
  const stats = (await api.get('queue-items/stats').expect(200)).body;
  assert.equal(stats.total, 2);
  assert.equal(stats.waitingByType.manual, 1);
  // unit leased -> its auto item is done
  await api.patch(`units/${u.id}`, { version: 2, status: 'leased' }).expect(200);
  assert.equal((await api.get(`queue-items/${items[0].id}`)).body.data.status, 'done');
});

test('rent collections: derived status, summary, period lock', async () => {
  const p = await property();
  await unit(p.code, 'A-101');
  await unit(p.code, 'A-102');
  const month = shiftMonth(YM, -1);
  const a = await create('rent-collections', { month, propertyCode: p.code, unitCode: 'A-101', amountDue: money(180000), amountCollected: money(180000) });
  const b = await create('rent-collections', { month, propertyCode: p.code, unitCode: 'A-102', amountDue: money(180000), amountCollected: money(0) });
  assert.equal(a.status, 'paid');
  assert.equal(a.locked, false);
  assert.equal(b.status, 'overdue');
  const sum = (await api.get(`rent-collections/summary?month=${month}`).expect(200)).body.data;
  assert.deepEqual({ ...sum[0], lastCollectedAt: undefined }, { propertyCode: p.code, month, collectedPct: 50, unitsPaid: 1, unitsTotal: 2, overdueCount: 1, lastCollectedAt: undefined, status: 'overdue' });
  await api.post('rent-collections', { month, propertyCode: p.code, unitCode: 'A-102', amountDue: money(1), amountCollected: money(0) }).expect(409);
  // partial payment
  const part = (await api.patch(`rent-collections/${b.id}`, { version: 1, amountCollected: money(100000) }).expect(200)).body.data;
  assert.equal(part.status, 'partial');
  // EALING locks the period: no edit, no delete, no create
  await setSettings({ closedThrough: month });
  assert.equal((await api.patch(`rent-collections/${b.id}`, { version: 2, amountCollected: money(180000) }).expect(409)).body.error.code, 'period_locked');
  assert.equal((await api.del(`rent-collections/${b.id}`).expect(409)).body.error.code, 'period_locked');
  await unit(p.code, 'A-103');
  assert.equal((await api.post('rent-collections', { month, propertyCode: p.code, unitCode: 'A-103', amountDue: money(1) }).expect(409)).body.error.code, 'period_locked');
  assert.equal((await api.get(`rent-collections/${b.id}`)).body.data.locked, true);
  await setSettings({ closedThrough: null });
});

test('delete: impact preview, cascade to children and generated queue items, entity delete blocked', async () => {
  const e = await entity();
  const p = await property({ entityCode: e.code });
  const u = await unit(p.code, 'A-101', { status: 'leased' });
  await unit(p.code, 'A-102');
  await create('leases', { propertyCode: p.code, unitCode: 'A-101', startDate: addDays(T, -10), endDate: addDays(T, 20), monthlyRent: money(1) });
  await create('work-orders', { propertyCode: p.code, category: 'plumbing', title: 'Leak', priority: 'normal' });
  await create('exit-plans', { propertyCode: p.code, strategy: 'hold', holdYears: 5, targetExitYear: 2031, priority: 1 });
  assert.ok((await api.get('queue-items')).body.page.total >= 3);

  const blocked = (await api.del(`entities/${e.id}`).expect(409)).body.error;
  assert.equal(blocked.code, 'has_dependents');
  assert.equal(blocked.blockedBy[0].resource, 'properties');
  const impact = (await api.get(`properties/${p.id}/delete-impact`).expect(200)).body;
  assert.equal(impact.willDelete.units, 2);
  assert.equal(impact.willDelete.leases, 1);
  assert.equal(impact.willDelete.workOrders, 1);
  assert.equal(impact.willDelete.exitPlans, 1);
  assert.equal(impact.willDelete.propertyRecords, 8);

  // a unit delete takes only its own leases
  await api.del(`units/${u.id}`).expect(204);
  assert.equal((await api.get('leases')).body.page.total, 0);
  assert.equal((await api.get('units')).body.page.total, 1);

  await api.del(`properties/${p.id}`).expect(204);
  for (const r of ['units', 'work-orders', 'exit-plans', 'property-records', 'queue-items']) assert.equal((await api.get(r)).body.page.total, 0, r);
  await api.del(`entities/${e.id}`).expect(204);
  await api.get(`properties/${p.id}`).expect(404);
});

test('property: default record checklist by type, duplicate, record summary', async () => {
  const p = await property();
  const recs = (await api.get(`property-records?propertyCode=${p.code}`).expect(200)).body.data;
  assert.equal(recs.length, 8);
  assert.ok(recs.every((r) => r.status === 'missing'));
  await api.patch(`property-records/${recs[0].id}`, { version: 1, status: 'present', docDate: '2026-01-01' }).expect(200);
  assert.equal((await api.patch(`property-records/${recs[1].id}`, { version: 1, storageNote: 'C:/docs/secret.pdf' }).expect(400)).body.error.fields[0].code, 'not_allowed');
  const s = (await api.get('property-records/summary').expect(200)).body.data[0];
  assert.equal(s.propertyCode, p.code);
  assert.equal(s.present, 1);
  assert.equal(s.missing, 7);
  assert.equal(s.completenessPct, 12.5);
  assert.equal(s.status, 'missing');
  const copy = (await api.post(`properties/${p.id}/duplicate`).expect(200)).body.data;
  assert.equal(copy.name, 'Orchid Court (bản sao)');
  assert.notEqual(copy.code, p.code);
});

test('entities: tree, parent cycle refused, parent delete blocked', async () => {
  const a = await entity();
  const b = await entity({ parentCode: a.code, parentOwnershipPct: 60 });
  const tree = (await api.get('entities/tree').expect(200)).body.data;
  assert.equal(tree[0].code, a.code);
  assert.equal(tree[0].children[0].code, b.code);
  assert.equal(tree[0].children[0].ownershipPct, 60);
  assert.equal((await api.patch(`entities/${a.id}`, { version: 1, parentCode: b.code }).expect(400)).body.error.fields[0].code, 'cycle');
  assert.equal((await api.patch(`entities/${a.id}`, { version: 1, parentCode: a.code }).expect(400)).body.error.fields[0].code, 'self_reference');
  await api.del(`entities/${a.id}`).expect(409);
  assert.equal((await api.get(`entities/${a.id}`)).body.data.propertyCount, 0);
  await property({ entityCode: a.code });
  assert.equal((await api.get(`entities/${a.id}`)).body.data.propertyCount, 1);
});

test('intercompany: counterpart entry, confirm with the other amount, reconcile pairs, delete both', async () => {
  const a = await entity();
  const b = await entity();
  const e = await create('intercompany-entries', { creditEntityCode: a.code, debitEntityCode: b.code, txnType: 'capital_transfer', date: '2026-10-05', amount: money(1000000), description: 'Seed' });
  assert.equal(e.counterpartConfirmed, false);
  assert.equal('amount' in e, false);
  assert.equal((await api.post('intercompany-entries', { creditEntityCode: a.code, debitEntityCode: a.code, txnType: 'repayment', date: '2026-10-05', amount: money(1) }).expect(400)).body.error.fields[0].code, 'must_differ');
  const all = (await api.get('intercompany-entries').expect(200)).body.data;
  assert.equal(all.length, 2);
  const mirror = all.find((x) => x.isCounterpart);
  let pair = (await api.get('intercompany-pairs').expect(200)).body.data[0];
  assert.equal(pair.code, `SC-${a.code.slice(3)}${b.code.slice(3)}`);
  assert.equal(pair.reconcileStatus, 'mismatch');
  assert.equal(pair.pendingConfirmCount, 1);
  await api.post(`intercompany-entries/${mirror.id}/confirm`, { amount: money(900000) }).expect(200);
  pair = (await api.get('intercompany-pairs').expect(200)).body.data[0];
  assert.equal(pair.pendingConfirmCount, 0);
  assert.equal(pair.deviationPct, 10);
  assert.equal(pair.reconcileStatus, 'mismatch');
  await api.post(`intercompany-entries/${mirror.id}/confirm`, { amount: money(900000) }).expect(409);
  assert.equal((await api.get(`intercompany-entries/${e.id}`)).body.data.counterpartConfirmed, true);
  await api.del(`intercompany-entries/${e.id}`).expect(204);
  assert.equal((await api.get('intercompany-entries')).body.page.total, 0);
});

test('cash flows → income entries (auto), loans (dscr/ltv/status), revenue targets, locked flag', async () => {
  const e = await entity();
  const p = await property({ entityCode: e.code });
  await create('cash-flows', { entityCode: e.code, propertyCode: p.code, direction: 'income', category: 'rent', amount: money(1000000), date: `${YM}-03` });
  await create('cash-flows', { entityCode: e.code, propertyCode: p.code, direction: 'expense', category: 'repairs_maintenance', amount: money(300000), date: `${YM}-04` });
  const bad = (await api.post('cash-flows', { entityCode: e.code, direction: 'income', category: 'property_tax', amount: money(1), date: `${YM}-04` }).expect(400)).body.error;
  assert.equal(bad.fields[0].code, 'wrong_direction');
  const inc = (await api.get('income-entries').expect(200)).body.data;
  assert.equal(inc.length, 1);
  assert.equal(inc[0].source, 'auto');
  assert.equal(inc[0].group, 'rent');
  assert.equal((await api.patch(`income-entries/${inc[0].id}`, { version: 1, reason: 'x' }).expect(400)).body.error.fields[0].code, 'auto_entry_readonly');
  const manual = await create('income-entries', { entityCode: e.code, period: YM, group: 'other', amount: money(50000), reason: 'Parking' });
  assert.equal(manual.source, 'manual');
  assert.equal((await api.post('income-entries', { entityCode: e.code, period: YM, group: 'other', amount: money(1) }).expect(400)).body.error.fields[0].code, 'required');
  const target = await create('revenue-targets', { scope: 'month', period: YM, target: money(2100000) });
  assert.equal(target.completionPct, 50);
  assert.equal((await api.post('revenue-targets', { scope: 'quarter', period: '2026-13', target: money(1) }).expect(400)).body.error.fields[0].code, 'invalid_format');

  const loan = await create('loans', { propertyCode: p.code, lenderName: 'First Bank', originalPrincipal: money(200000000), currentBalance: money(150000000), ratePct: 6.5, rateType: 'fixed', termYears: 10, startDate: addDays(T, -365), maturityDate: addDays(T, 200), monthlyPayment: money(1200000) });
  assert.equal(loan.status, 'maturing');
  assert.equal(loan.ltvPct, 50);
  assert.ok(loan.remainingDays === 200 && loan.elapsedPct > 60);
  assert.equal(loan.dscr, round2((1000000 - 300000) / (1200000 * 12)));
  assert.equal((await api.get('queue-items?type=loan_maturity')).body.data.length, 1);
  assert.equal((await api.post('loans', { lenderName: 'x', originalPrincipal: money(1), currentBalance: money(1), rateType: 'fixed', termYears: 1, startDate: '2026-01-01', maturityDate: '2027-01-01' }).expect(400)).body.error.fields[0].code, 'required');

  await setSettings({ closedThrough: YM });
  assert.equal((await api.get('cash-flows')).body.data[0].locked, true);
  await api.del(`cash-flows/${(await api.get('cash-flows')).body.data[0].id}`).expect(409);
  await setSettings({ closedThrough: null });
});
const round2 = (n) => Math.round(n * 100) / 100;

test('month-end close: template steps, derived status and progress', async () => {
  const e = await entity();
  const c = await create('month-end-closes', { entityCode: e.code, month: YM });
  assert.equal(c.steps.length, 7);
  assert.equal(c.status, 'todo');
  assert.equal(c.totalCount, 7);
  assert.equal(c.reconciliation, 'match');
  await api.post('month-end-closes', { entityCode: e.code, month: YM }).expect(409);
  const steps = c.steps.map((s, i) => (i < 3 ? { ...s, status: 'done', doneByName: 'Linh' } : s));
  const upd = (await api.patch(`month-end-closes/${c.id}`, { version: 1, steps }).expect(200)).body.data;
  assert.equal(upd.status, 'doing');
  assert.equal(upd.completedCount, 3);
  assert.equal(upd.progressPct, 42.9);
  assert.ok(upd.steps[0].doneAt);
  const done = (await api.patch(`month-end-closes/${c.id}`, { version: 2, steps: upd.steps.map((s) => ({ ...s, status: 'done' })) }).expect(200)).body.data;
  assert.equal(done.status, 'done');
});

test('deals: default checklist, cap rate, checklist patch, close creates property + units, convert land', async () => {
  const e = await entity();
  const d = await create('deals', { name: 'Palm Villas', kind: 'acquisition', assetType: 'multifamily', area: 'Miami', offerPrice: money(500000000), projectedNoi: money(30000000), unitCount: 3, stage: 'analysis' });
  assert.equal(d.checklistTotal, 6);
  assert.equal(d.checklistDone, 0);
  assert.equal(d.projectedCapRatePct, 6);
  assert.equal((await api.get('queue-items?type=due_diligence')).body.data.length, 1);
  const c = (await api.patch(`deals/${d.id}/checklist/legal_title`, { version: 1, status: 'done', note: 'ok' }).expect(200)).body.data;
  assert.equal(c.checklistDone, 1);
  await api.patch(`deals/${d.id}/checklist/nope`, { version: 2, status: 'done' }).expect(404);
  await api.patch(`deals/${d.id}/checklist/legal_title`, { version: 1, status: 'todo' }).expect(409);
  await api.post(`deals/${d.id}/close`, {}).expect(400);
  const closed = (await api.post(`deals/${d.id}/close`, { entityCode: e.code, city: 'Miami', zip: '33101' }).expect(200)).body.data;
  assert.equal(closed.deal.stage, 'closed');
  assert.equal(closed.property.name, 'Palm Villas');
  assert.equal((await api.get(`units?propertyCode=${closed.property.code}`)).body.page.total, 3);
  assert.equal((await api.get('queue-items?type=due_diligence')).body.data[0].status, 'done');

  const land = await create('deals', { name: 'Lot 7', kind: 'acquisition', assetType: 'land' });
  await api.post(`deals/${d.id}/convert-to-development`, { entityCode: e.code }).expect(409);
  const dev = (await api.post(`deals/${land.id}/convert-to-development`, { entityCode: e.code }).expect(200)).body.data;
  assert.equal(dev.stage, 'land_purchase');
  assert.equal(dev.entityCode, e.code);
});

test('scenarios: allowed ratio keys per tool, no money, target must exist and is unlinked on delete', async () => {
  const deal = await create('deals', { name: 'Palm', kind: 'acquisition', assetType: 'multifamily' });
  const s = await create('scenarios', { toolId: 'acq', name: 'Base', ratios: { vac: 5, opex: 40, ltv: 65, rate: 6.5, term: 25 }, target: { kind: 'deal', code: deal.code }, headline: { label: 'Cap rate', value: '6.80%' } });
  assert.equal(s.target.code, deal.code);
  const err = async (b) => (await api.post('scenarios', { toolId: 'acq', name: 'x', ratios: { vac: 5 }, ...b }).expect(400)).body.error.fields[0];
  assert.equal((await err({ ratios: { vac: 5, price: 3 } })).code, 'unknown_key');
  assert.equal((await err({ ratios: { vac: 240000000 } })).code, 'out_of_range');
  assert.equal((await err({ headline: { label: 'Price', value: '$2,400,000' } })).code, 'money_not_allowed');
  assert.equal((await err({ target: { kind: 'deal', code: 'GD-999' } })).code, 'not_found');
  assert.equal((await api.get(`scenarios?toolId=acq&targetKind=deal&targetCode=${deal.code}`)).body.data.length, 1);
  await api.del(`deals/${deal.id}`).expect(204);
  assert.equal((await api.get(`scenarios/${s.id}`)).body.data.target, null);
});

test('operations: work order ages, PM schedule, storm damage → work order, inspection → work order, utilities rise', async () => {
  const p = await property({ unitCount: 10 });
  const wo = await create('work-orders', { propertyCode: p.code, category: 'hvac', title: 'AC down', priority: 'urgent' });
  assert.equal(wo.status, 'new');
  const done = (await api.patch(`work-orders/${wo.id}`, { version: 1, status: 'done' }).expect(200)).body.data;
  assert.equal(done.completedAt, T);
  assert.equal(done.processDays, 0);

  const pm = await create('pm-schedules', { propertyCode: p.code, task: 'roof_check', frequency: 'quarterly', lastDoneAt: addDays(T, -100) });
  assert.equal(pm.status, 'overdue');
  const doneAt = (await api.post(`pm-schedules/${pm.id}/complete`).expect(200)).body.data;
  assert.equal(doneAt.lastDoneAt, T);
  assert.equal(doneAt.status, 'done');
  const tpl = (await api.post('pm-schedules/from-template', { templateKey: 'hurricane_prep', propertyCode: p.code }).expect(200)).body.data;
  assert.equal(tpl.length, 4);
  assert.equal((await api.post('pm-schedules/from-template', { templateKey: 'x', propertyCode: p.code }).expect(400)).body.error.fields[0].code, 'invalid_enum');

  const storm = await create('storm-plans', { propertyCode: p.code });
  assert.equal(storm.checklist.length, 9);
  assert.equal(storm.checklistDonePct, 0);
  const dmg = (await api.post(`storm-plans/${storm.id}/damages`, { category: 'roof', severity: 'severe', count: 3 }).expect(200)).body.data;
  assert.equal(dmg.stormPlan.responseLevel, 'damaged');
  assert.equal(dmg.stormPlan.linkedWorkOrderCount, 1);
  assert.equal(dmg.workOrder.priority, 'urgent');
  assert.equal((await api.get('queue-items?type=storm')).body.data.length, 1);

  const ins = await create('inspections', { propertyCode: p.code, date: T, category: 'roof', result: 'good' });
  await api.post(`inspections/${ins.id}/create-work-order`).expect(409);
  const bad = await create('inspections', { propertyCode: p.code, date: T, category: 'electrical', result: 'urgent_fix' });
  const r = (await api.post(`inspections/${bad.id}/create-work-order`).expect(200)).body.data;
  assert.equal(r.inspection.linkedWorkOrderCode, r.workOrder.code);
  assert.equal(r.workOrder.category, 'electrical');

  await create('utilities', { propertyCode: p.code, kind: 'electric', period: shiftMonth(YM, -1), usageValue: 1000, usageUnit: 'kWh', cost: money(150000) });
  const u = await create('utilities', { propertyCode: p.code, kind: 'electric', period: YM, usageValue: 1500, usageUnit: 'kWh', cost: money(220000) });
  assert.equal(u.momPct, 50);
  assert.equal(u.status, 'abnormal_rise');
  assert.equal(u.usagePerUnit, 150);
  await api.post('utilities', { propertyCode: p.code, kind: 'electric', period: YM, usageValue: 1, usageUnit: 'kWh' }).expect(409);

  const eq = await create('equipment', { propertyCode: p.code, kind: 'hvac', installedAt: addDays(T, -365 * 5), warrantyEnd: addDays(T, 30), expectedLifeYears: 10 });
  assert.equal(eq.ageYears, 5);
  assert.equal(eq.remainingLifePct, 50);
  assert.equal(eq.replaceYear, Number(T.slice(0, 4)) - 5 + 10);
  assert.equal((await api.get('queue-items?type=warranty_expiring')).body.data.length, 1);

  const v = await create('vendors', { companyName: 'Cool Air', serviceType: 'hvac', licenseExpiry: addDays(T, 20), insuranceExpiry: addDays(T, 300) });
  assert.equal(v.status, 'expiring');
  const gone = await create('vendors', { companyName: 'Old Co', serviceType: 'hvac', licenseExpiry: addDays(T, -1) });
  assert.equal(gone.status, 'expired');
});

test('asset classes, exit plan trigger, development project, partners & providers', async () => {
  const e = await entity();
  const a = await create('asset-classes', { classKey: 'rental_real_estate', estimatedValue: money(70000000), targetWeightPct: 50, toleranceBandPct: 5 });
  const b = await create('asset-classes', { classKey: 'cash_equivalent', entityCode: e.code, estimatedValue: money(30000000), targetWeightPct: 50, toleranceBandPct: 5 });
  const list = (await api.get('asset-classes?sort=code').expect(200)).body.data;
  assert.equal(list[0].actualWeightPct, 70);
  assert.equal(list[0].deviationPts, 20);
  assert.equal(list[0].status, 'high');
  assert.equal(list[1].actualWeightPct, 30);
  assert.equal(list[1].liquidityMonths, null);
  assert.equal((await api.get('reports/portfolio-allocation')).body.data.length, 2);

  const p = await property({ entityCode: e.code, estimatedValue: money(100000000) });
  await create('loans', { propertyCode: p.code, lenderName: 'First Bank', originalPrincipal: money(1), currentBalance: money(60000000), rateType: 'fixed', termYears: 10, startDate: addDays(T, -100), maturityDate: addDays(T, 3000) });
  const plan = await create('exit-plans', { propertyCode: p.code, strategy: 'sell', holdYears: 5, targetExitYear: 2030, priority: 1, trigger: { metric: 'ltv', op: 'gte', valuePct: 55 } });
  assert.equal(plan.triggerMet, true);
  await api.post('exit-plans', { propertyCode: p.code, strategy: 'hold', holdYears: 1, targetExitYear: 2030, priority: 2 }).expect(409);
  await api.post(`exit-plans/${plan.id}/create-sale-deal`).expect(409);
  await api.patch(`exit-plans/${plan.id}`, { version: 1, lifecycleStage: 'prep_sale' }).expect(200);
  const deal = (await api.post(`exit-plans/${plan.id}/create-sale-deal`).expect(200)).body.data;
  assert.equal(deal.kind, 'disposition');

  const dp = await create('development-projects', { name: 'Harbor', entityCode: e.code, area: 'Miami', productType: 'multifamily', plannedUnits: 2, stage: 'lease_or_sale', stages: [{ stage: 'land_purchase', plannedDate: addDays(T, -60), actualDate: addDays(T, -50), progressPct: 100 }, { stage: 'lease_or_sale', plannedDate: addDays(T, -5), progressPct: 50, tasks: [{ title: 'List units' }] }] });
  assert.equal(dp.progressPct, 75);
  assert.equal(dp.delayDays, 5);
  assert.equal(dp.stages[1].tasks[0].done, false);
  const done = (await api.post(`development-projects/${dp.id}/complete`, { zip: '33101' }).expect(200)).body.data;
  assert.equal(done.property.unitCount, 2);
  await api.post(`development-projects/${dp.id}/complete`, {}).expect(409);

  await create('partners', { companyName: 'First Bank', kind: 'lender', companyEmail: 'loans@firstbank.com' });
  assert.equal((await api.get('partners')).body.data[0].linkedCount, 1);
  const sp = await create('service-providers', { companyName: 'Ledger CPA', kind: 'accounting', contractStart: addDays(T, -300), contractEnd: addDays(T, 30), fee: money(1200000) });
  assert.equal(sp.status, 'expiring');
  assert.equal('fee' in sp, false);
});

test('leasing funnel, tasks and suggestions', async () => {
  const p = await property();
  await unit(p.code, 'A-101', { vacantSince: addDays(T, -20) });
  const item = await create('leasing-funnel', { propertyCode: p.code, unitCode: 'A-101', step: 'vacant', listedRent: money(180000) });
  assert.equal(item.vacantDays, 20);
  assert.equal(item.stepEnteredAt, T);
  const moved = (await api.patch(`leasing-funnel/${item.id}`, { version: 1, step: 'inquiry', inquiryCount: 2 }).expect(200)).body.data;
  assert.equal(moved.step, 'inquiry');
  const f = (await api.get('reports/funnel').expect(200)).body.data;
  assert.equal(f.steps.find((s) => s.step === 'inquiry').count, 1);

  const t = await create('tasks', { title: 'Call broker', dueDate: addDays(T, -2), priority: 'high' });
  assert.equal(t.isOverdue, true);
  await create('work-orders', { propertyCode: p.code, category: 'other', title: 'Late job', dueDate: addDays(T, -3) });
  const sug = (await api.get('tasks/suggestions?types=maintenance').expect(200)).body.data;
  assert.equal(sug.length, 1);
  assert.equal(sug[0].relatedRef.resource, 'work-orders');
});

test('reports: dashboard, highlights, timeline, noi, catalog, export', async () => {
  const e = await entity();
  const p = await property({ entityCode: e.code });
  await unit(p.code, 'A-101', { status: 'leased' });
  await unit(p.code, 'A-102', { status: 'vacant' });
  await create('leases', { propertyCode: p.code, unitCode: 'A-101', startDate: addDays(T, -100), endDate: addDays(T, 20), monthlyRent: money(1) });
  await create('cash-flows', { entityCode: e.code, propertyCode: p.code, direction: 'income', category: 'rent', amount: money(1000000), date: `${YM}-02` });
  await create('cash-flows', { entityCode: e.code, propertyCode: p.code, direction: 'expense', category: 'utilities', amount: money(400000), date: `${YM}-03` });

  const d = (await api.get('reports/dashboard?period=month').expect(200)).body.data;
  assert.equal(d.structure.activeEntities, 1);
  assert.equal(d.realEstate.properties, 1);
  assert.equal(d.realEstate.units, 2);
  assert.equal(d.realEstate.vacantUnits, 1);
  assert.equal(d.realEstate.occupancyPct, 50);
  assert.equal(d.operations.noiMarginPct, 60);
  assert.equal(d.operations.opexRatioPct, 40);
  assert.equal(d.cashFlow.direction, 'positive');
  assert.equal(d.debt, null, 'no data -> null, not a fake zero');
  assert.equal(d.series.occupancyPct.length, 12);
  assert.equal(d.series.noiMarginPct[11], 60);
  assert.equal(d.queue.waitingByType.lease_renewal, 1);
  assert.equal(JSON.stringify(d).includes('amountMinor'), false);
  assert.equal((await api.get(`reports/dashboard?entityCode=${e.code}&propertyCode=${p.code}`).expect(200)).body.data.realEstate.units, 2);
  await api.get('reports/dashboard?period=decade').expect(400);

  const h = (await api.get('reports/highlights?period=month').expect(200)).body.data;
  assert.equal(h.topProperties[0].propertyCode, p.code);
  assert.equal(h.watchProperties[0].reason, 'vacancy_high');
  assert.ok(Array.isArray(h.upcomingMilestones));

  const tl = (await api.get(`timeline?from=${T}&to=${addDays(T, 30)}&kinds=lease`).expect(200)).body.data;
  assert.equal(tl.length, 1);
  assert.equal(tl[0].kind, 'lease');
  assert.equal(tl[0].resource, 'leases');
  await api.get(`timeline?from=${T}&to=${addDays(T, 200)}`).expect(400);

  const noi = (await api.get('reports/noi?period=month').expect(200)).body.data;
  assert.equal(noi.items[0].noiMarginPct, 60);
  assert.equal(noi.items[0].vacancyLossPct, 50);

  const cat = (await api.get('reports/catalog').expect(200)).body.data;
  assert.equal(cat.length, 4);
  const csv = await api.get('reports/export?type=occupancy&format=csv').expect(200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /overallPct,50/);
  assert.match(csv.text, /Không phải báo cáo tài chính chính thức/);
  const pdf = await api.get('reports/export?type=dashboard&format=pdf').expect(200).buffer(true).parse((res, cb) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  await api.get('reports/export?type=nope&format=csv').expect(400);
  assert.equal((await api.get('reports/cash-forecast').expect(200)).body.data.items.length, 12);
});

test('meta, public content, daily job', async () => {
  const meta = (await api.get('meta').expect(200)).body.data;
  assert.equal(meta.enums['Lease.status'].find((x) => x.value === 'expiring').label, 'Sắp hết hạn');
  assert.equal(meta.limits.note, 500);
  const co = await api.get('public/company').expect(200);
  assert.equal(co.body.data.name, 'EALING, LLC');
  assert.equal(co.body.data.scale, null, 'scale is hidden until EALING approves it');
  assert.equal(co.body.data.yearsActive, Number(T.slice(0, 4)) - 2016);
  assert.match(co.headers['cache-control'], /max-age=3600/);
  await api.get('public/company').set('If-None-Match', co.headers.etag).expect(304);
  assert.equal((await api.get('public/templates').expect(200)).body.data.length, 8);

  const p = await property();
  await create('pm-schedules', { propertyCode: p.code, task: 'hvac_clean', frequency: 'monthly', lastDoneAt: addDays(T, -45) });
  const job = (await api.get('jobs/daily').expect(200)).body.data;
  assert.equal(job.pmWorkOrdersCreated, 1);
  assert.equal((await api.get('work-orders?propertyCode=' + p.code)).body.data[0].sourceType, 'pm');
  assert.equal((await api.get('jobs/daily').expect(200)).body.data.pmWorkOrdersCreated, 0, 'idempotent');
  assert.equal((await api.get('pm-schedules')).body.data[0].status, 'in_progress');
});

test('bad JSON, oversized body', async () => {
  const bad = await request(app).post('/v1/entities').set('Content-Type', 'application/json').send('{oops').expect(400);
  assert.equal(bad.body.error.code, 'validation_failed');
  const big = await request(app).post('/v1/entities').send({ note: 'x'.repeat(2 * 1024 * 1024) }).expect(413);
  assert.equal(big.body.error.code, 'payload_too_large');
});

test('rate limit per IP: 429 with Retry-After, then the same IP stays limited while others are not', async () => {
  const config = require('../src/config');
  const keep = { ...config.rate };
  Object.assign(config.rate, { enabled: true, readPerMin: 3, writePerMin: 2, createPerDay: 100 });
  try {
    const get = (ip) => request(app).get('/v1/entities').set('X-Forwarded-For', ip);
    for (let i = 0; i < 3; i++) await get('9.9.9.9').expect(200);
    const limited = await get('9.9.9.9').expect(429);
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    await get('8.8.8.8').expect(200);
    const post = (ip) => request(app).post('/v1/entities').set('X-Forwarded-For', ip).send({});
    await post('7.7.7.7').expect(400);
    await post('7.7.7.7').expect(400);
    await post('7.7.7.7').expect(429);
  } finally {
    Object.assign(config.rate, keep);
  }
});
