import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import Business from '../../src/modules/business.model.js';
import BusinessMember from '../../src/modules/business-member.model.js';
import { inTransaction, TRANSACTION_OPTIONS } from '../../src/kernel/index.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from '../support/test-database.js';

let db;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  db = mongoose.connection.db;
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await Business.collection.deleteMany({});
    await BusinessMember.collection.deleteMany({});
  }
  await disconnectTestDatabase();
});

test('transaction: TRANSACTION_OPTIONS preserves snapshot/majority/primary', () => {
  assert.deepEqual(TRANSACTION_OPTIONS, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
  });
});

test('transaction: success commits, error rolls back all documents', async () => {
  const slug = `tx-commit-${Date.now()}`;
  const memberCountBefore = await BusinessMember.countDocuments({});

  // Success: business + member both persisted.
  const created = await inTransaction(async (session) => {
    const [business] = await Business.create([{ name: 'Tx', slug }], { session });
    await BusinessMember.create([{ businessId: business._id, userId: new mongoose.Types.ObjectId(), role: 'owner' }], { session });
    return business;
  });
  assert.ok(await Business.exists({ _id: created._id }));
  assert.equal(await BusinessMember.countDocuments({}), memberCountBefore + 1);

  // Error: nothing from the rolled-back transaction persists.
  const badSlug = `tx-rollback-${Date.now()}`;
  await assert.rejects(
    inTransaction(async (session) => {
      await Business.create([{ name: 'Rolled back', slug: badSlug }], { session });
      await BusinessMember.create([{ businessId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), role: 'owner' }], { session });
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await Business.countDocuments({ slug: badSlug }), 0);
  assert.equal(await BusinessMember.countDocuments({}), memberCountBefore + 1);
});

test('transaction: errors propagate to the caller and roll back', async () => {
  const before = await Business.countDocuments({});
  await assert.rejects(
    inTransaction(async (session) => {
      await Business.create([{ name: 'x', slug: `err-${Date.now()}` }], { session });
      throw new Error('sentinel');
    }),
    (err) => err.message === 'sentinel',
  );
  assert.equal(await Business.countDocuments({}), before);
});

test('transaction: accidental nesting is avoided by joining an active session', async () => {
  const slug = `tx-nested-${Date.now()}`;
  const before = await BusinessMember.countDocuments({});

  await inTransaction(async (session) => {
    const [business] = await Business.create([{ name: 'Nested', slug }], { session });

    // Inner call receives the SAME session and joins; it must not start a nested transaction.
    await inTransaction(async (innerSession) => {
      assert.strictEqual(innerSession, session, 'nested call must reuse the outer session');
      await BusinessMember.create(
        [{ businessId: business._id, userId: new mongoose.Types.ObjectId(), role: 'owner' }],
        { session: innerSession },
      );
    }, { session });
  });

  assert.equal(await Business.countDocuments({ slug }), 1);
  assert.equal(await BusinessMember.countDocuments({}), before + 1);
});

test('transaction: nested work that throws rolls back the outer transaction', async () => {
  const slug = `tx-nested-rollback-${Date.now()}`;
  await assert.rejects(
    inTransaction(async (session) => {
      await Business.create([{ name: 'Outer', slug }], { session });
      await inTransaction(async (innerSession) => {
        await BusinessMember.create(
          [{ businessId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId(), role: 'owner' }],
          { session: innerSession },
        );
        throw new Error('inner boom');
      }, { session });
    }),
    /inner boom/,
  );
  assert.equal(await Business.countDocuments({ slug }), 0);
});

test('transaction: session lifecycle is always closed (no leaked sessions)', async () => {
  // Must not throw "session ended" or leak; connection stays usable.
  await inTransaction(async () => 'ok');
  await assert.rejects(inTransaction(async () => { throw new Error('x'); }), /x/);
  assert.equal(mongoose.connection.readyState, 1);
  // A subsequent transaction still works after rollbacks.
  const r = await inTransaction(async (session) => {
    await Business.countDocuments({}).session(session);
    return 'ok';
  });
  assert.equal(r, 'ok');
});
