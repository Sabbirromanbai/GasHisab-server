import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { after, before, test } from 'node:test';
import { inTransaction, runIdempotently, generateRequestHash, ConflictError } from '../../src/kernel/index.js';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from '../support/test-database.js';

// Test-only append-only model matching the shared idempotency contract.
const ledgerSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, required: true },
    idempotencyKey: { type: String, required: true, maxlength: 120 },
    requestHash: { type: String, required: true, select: false }, // select:false
    payload: { type: Number, default: 0 },
  },
  { timestamps: true },
);
ledgerSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });

let Ledger;
let businessId;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();
  Ledger = mongoose.models.TestIdempotentLedger || mongoose.model('TestIdempotentLedger', ledgerSchema);
  businessId = new mongoose.Types.ObjectId();
  // Build unique index before running.
  await Ledger.syncIndexes();
});

after(async () => {
  if (mongoose.connection.readyState === 1) await Ledger.collection.deleteMany({});
  await disconnectTestDatabase();
});

test('idempotency: same key + same payload retries return existing, no duplicate', async () => {
  const key = 'retry-1';
  const requestHash = generateRequestHash({ amount: 100, key });
  const filter = { businessId, idempotencyKey: key };

  const make = (session) =>
    Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 100 }], { session }).then((r) => r[0]);

  const first = await runIdempotently({ model: Ledger, filter, requestHash, work: make });
  const retry = await runIdempotently({ model: Ledger, filter, requestHash, work: make });

  assert.equal(String(first._id), String(retry._id));
  assert.equal(await Ledger.countDocuments({ businessId, idempotencyKey: key }), 1);
  // requestHash is select:false — not returned on normal reads.
  const read = await Ledger.findOne({ businessId, idempotencyKey: key });
  assert.equal(read.requestHash, undefined);
  // ...but still stored.
  const withHash = await Ledger.findOne({ businessId, idempotencyKey: key }).select('+requestHash');
  assert.equal(withHash.requestHash, requestHash);
});

test('idempotency: same key + different payload is a conflict', async () => {
  const key = 'retry-2';
  const filter = { businessId, idempotencyKey: key };
  const requestHash = generateRequestHash({ amount: 100 });

  await runIdempotently({
    model: Ledger, filter, requestHash,
    work: (session) => Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 100 }], { session }).then((r) => r[0]),
  });

  await assert.rejects(
    runIdempotently({
      model: Ledger,
      filter,
      requestHash: generateRequestHash({ amount: 200 }), // different payload
      work: (session) => Ledger.create([{ businessId, idempotencyKey: key, requestHash: generateRequestHash({ amount: 200 }), payload: 200 }], { session }).then((r) => r[0]),
    }),
    (e) => e instanceof ConflictError && e.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await Ledger.countDocuments({ businessId, idempotencyKey: key }), 1);
});

test('idempotency: concurrent duplicate requests safely produce one record', async () => {
  const key = 'retry-concurrent';
  const requestHash = generateRequestHash({ amount: 5 });
  const filter = { businessId, idempotencyKey: key };

  const make = (session) =>
    Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 5 }], { session }).then((r) => r[0]);

  const results = await Promise.allSettled([
    runIdempotently({ model: Ledger, filter, requestHash, work: make }),
    runIdempotently({ model: Ledger, filter, requestHash, work: make }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 2, `both concurrent retries should succeed: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(await Ledger.countDocuments({ businessId, idempotencyKey: key }), 1);

  // Both callers see the same persisted record.
  const ids = new Set(fulfilled.map((r) => String(r.value._id)));
  assert.equal(ids.size, 1);
});

test('idempotency: authorize runs before any cached result is returned', async () => {
  const key = 'retry-3';
  const requestHash = generateRequestHash({ x: 1 });
  const filter = { businessId, idempotencyKey: key };

  await runIdempotently({
    model: Ledger, filter, requestHash,
    work: (session) => Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 1 }], { session }).then((r) => r[0]),
  });

  let authorized = false;
  await assert.rejects(
    runIdempotently({
      model: Ledger, filter, requestHash,
      authorize: async () => { throw new Error('NOT_AUTHORIZED'); },
      work: async () => { throw new Error('should not run'); },
    }),
    /NOT_AUTHORIZED/,
  );
  assert.equal(authorized, false);
});

test('idempotency: transaction failure does not persist a partial idempotent record', async () => {
  const key = `rollback-${Date.now()}`;
  const requestHash = generateRequestHash({ x: 1 });
  const filter = { businessId, idempotencyKey: key };

  await assert.rejects(
    runIdempotently({
      model: Ledger, filter, requestHash,
      work: async (session) => {
        await Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 1 }], { session });
        throw new Error('abort');
      },
    }),
    /abort/,
  );
  assert.equal(await Ledger.countDocuments({ businessId, idempotencyKey: key }), 0);

  // Retry with same key works because nothing was persisted.
  const ok = await runIdempotently({
    model: Ledger, filter, requestHash,
    work: (session) => Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 1 }], { session }).then((r) => r[0]),
  });
  assert.equal(ok.payload, 1);
});

test('idempotency: can run inside an existing transaction (nested session)', async () => {
  const key = `nested-${Date.now()}`;
  const requestHash = generateRequestHash({ x: 1 });
  const filter = { businessId, idempotencyKey: key };

  await inTransaction(async (session) => {
    await runIdempotently({
      model: Ledger, filter, requestHash, session,
      work: (s) => Ledger.create([{ businessId, idempotencyKey: key, requestHash, payload: 1 }], { session: s }).then((r) => r[0]),
    });
  });
  assert.equal(await Ledger.countDocuments({ businessId, idempotencyKey: key }), 1);
});
