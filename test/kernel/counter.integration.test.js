import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../../src/modules/business.model.js';
import Counter from '../../src/modules/counter.model.js';
import { inTransaction, nextSequence, formatDocumentNumber } from '../../src/kernel/index.js';
import { ValidationError } from '../../src/errors.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from '../support/test-database.js';

let businessA;
let businessB;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  [businessA, businessB] = await Business.create([
    { name: 'Counter A', slug: `counter-a-${Date.now()}` },
    { name: 'Counter B', slug: `counter-b-${Date.now()}` },
  ]);
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Counter.collection.deleteMany({});
    await Business.collection.deleteMany({});
  }
  await disconnectTestDatabase();
});

test('counter: nextSequence starts at 1 and increments per business + key', async () => {
  const seqs = await inTransaction(async (session) => {
    const a = await nextSequence(businessA._id, 'sale', session);
    const b = await nextSequence(businessA._id, 'sale', session);
    const c = await nextSequence(businessA._id, 'purchase', session); // different key
    return [a, b, c];
  });
  assert.deepEqual(seqs, [1, 2, 1]);

  // Continues across transactions.
  const next = await inTransaction((session) => nextSequence(businessA._id, 'sale', session));
  assert.equal(next, 3);
});

test('counter: tenant isolation — sequences are independent per business', async () => {
  const aSeq = await inTransaction((s) => nextSequence(businessA._id, 'expense', s));
  const bSeq = await inTransaction((s) => nextSequence(businessB._id, 'expense', s));
  assert.equal(aSeq, 1);
  assert.equal(bSeq, 1); // business B has its own independent counter
});

test('counter: safe under concurrency — no duplicate numbers for same business/key', async () => {
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      inTransaction((s) => nextSequence(businessA._id, 'concurrent', s)),
    ),
  );
  const sorted = [...results].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: N }, (_, i) => i + 1)); // 1..N, no duplicates
  const count = await Counter.countDocuments({ businessId: businessA._id, key: 'concurrent' });
  assert.equal(count, 1); // a single counter doc
  assert.equal(await Counter.findOne({ businessId: businessA._id, key: 'concurrent' }).then((c) => c.seq), N);
});

test('counter: transaction rollback returns the sequence number', async () => {
  const key = `rollback-${Date.now()}`;
  await assert.rejects(
    inTransaction(async (session) => {
      await nextSequence(businessA._id, key, session);
      throw new Error('fail after sequence');
    }),
    /fail after sequence/,
  );
  // The increment rolled back; next call starts at 1.
  const seq = await inTransaction((s) => nextSequence(businessA._id, key, s));
  assert.equal(seq, 1);
});

test('counter: nextSequence requires a session and valid key', async () => {
  await assert.rejects(
    inTransaction(async () => nextSequence(businessA._id, 'x', undefined)),
    ValidationError,
  );
  await assert.rejects(
    inTransaction(async (s) => nextSequence(businessA._id, '', s)),
    ValidationError,
  );
});

test('counter: formatDocumentNumber is language-neutral and padded', () => {
  assert.equal(formatDocumentNumber('INV', 42), 'INV-000042');
  assert.equal(formatDocumentNumber('SAL', 1, { width: 4 }), 'SAL-0001');
  assert.throws(() => formatDocumentNumber('INV', 0), ValidationError);
  assert.throws(() => formatDocumentNumber('INV', -1), ValidationError);
});
