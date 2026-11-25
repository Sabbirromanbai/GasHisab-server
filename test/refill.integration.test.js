import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { assertTestDatabaseIsEmpty, connectTestDatabase, disconnectTestDatabase } from './support/test-database.js';

let fixture;
let Stock;
let RefillBatch;
let RefillIssueResolution;
let RefillReceipt;
let RefillReplacementReceipt;
let SupplierPayment;
let createRefillRate;
let dispatchRefillBatch;
let getSupplierAccountSummary;
let recordRefillReceipt;
let recordReplacementReceipt;
let recordSupplierPayment;
let resolveRefillIssue;
let cleanupRefillFixture;
let createRefillFixture;

before(async () => {
  await connectTestDatabase();
  await assertTestDatabaseIsEmpty();

  // Defer model imports until the pre-connection emptiness check has passed.
  const [models, refillService, refillFixtures] = await Promise.all([
    Promise.all([
      import('../src/modules/stock.model.js'),
      import('../src/modules/refill-batch.model.js'),
      import('../src/modules/refill-issue-resolution.model.js'),
      import('../src/modules/refill-receipt.model.js'),
      import('../src/modules/refill-replacement-receipt.model.js'),
      import('../src/modules/supplier-payment.model.js'),
    ]),
    import('../src/modules/refill.service.js'),
    import('./support/refill-fixtures.js'),
  ]);
  [Stock, RefillBatch, RefillIssueResolution, RefillReceipt, RefillReplacementReceipt, SupplierPayment] = models.map((model) => model.default);
  ({ createRefillRate, dispatchRefillBatch, getSupplierAccountSummary, recordRefillReceipt, recordReplacementReceipt, recordSupplierPayment, resolveRefillIssue } = refillService);
  ({ cleanupRefillFixture, createRefillFixture } = refillFixtures);
});

beforeEach(async () => {
  fixture = await createRefillFixture();
});

afterEach(async () => {
  if (fixture) await cleanupRefillFixture(fixture);
  fixture = undefined;
});

after(async () => {
  await disconnectTestDatabase();
});

const summary = () => getSupplierAccountSummary({
  businessId: fixture.business._id,
  supplierId: fixture.supplier._id,
  requestedBy: fixture.user._id,
});

const createRates = async () => {
  const [smallProduct, largeProduct] = fixture.products;
  await createRefillRate({ businessId: fixture.business._id, supplierId: fixture.supplier._id, productId: smallProduct._id, unitRatePoisha: 1000, createdBy: fixture.user._id });
  await createRefillRate({ businessId: fixture.business._id, supplierId: fixture.supplier._id, productId: largeProduct._id, unitRatePoisha: 2000, createdBy: fixture.user._id });
};

const createBatch = async (dispatchNumber = 'dispatch-full-flow', quantity = [5, 3]) => {
  const [smallProduct, largeProduct] = fixture.products;
  return dispatchRefillBatch({
    businessId: fixture.business._id,
    supplierId: fixture.supplier._id,
    dispatchNumber,
    items: [{ productId: smallProduct._id, quantity: quantity[0] }, { productId: largeProduct._id, quantity: quantity[1] }],
    createdBy: fixture.user._id,
  });
};

test('persists the complete refill, replacement, payment, and balance workflow', async () => {
  const [smallProduct] = fixture.products;
  await createRates();
  const batch = await createBatch();
  assert.equal(batch.brand, 'brand-a');
  assert.deepEqual(batch.items.map((item) => item.unitRatePoisha), [1000, 2000]);

  const dispatchRetry = await createBatch();
  assert.equal(String(dispatchRetry._id), String(batch._id));
  const smallStockAfterDispatch = await Stock.findOne({ businessId: fixture.business._id, productId: smallProduct._id }).lean();
  const largeStockAfterDispatch = await Stock.findOne({ businessId: fixture.business._id, productId: fixture.products[1]._id }).lean();
  assert.equal(smallStockAfterDispatch.emptyQty, 5);
  assert.equal(largeStockAfterDispatch.emptyQty, 3);

  const firstReceipt = await recordRefillReceipt({
    businessId: fixture.business._id,
    batchId: batch._id,
    idempotencyKey: 'receipt-1',
    items: [
      { batchItemId: batch.items[0]._id, fullQty: 2, rejectedQty: 1 },
      { batchItemId: batch.items[1]._id, fullQty: 1, damagedQty: 1 },
    ],
    receivedBy: fixture.user._id,
  });
  assert.equal(await RefillReceipt.countDocuments({ businessId: fixture.business._id, batchId: batch._id }), 1);
  assert.equal((await summary()).refillChargesPoisha, 4000);

  await assert.rejects(recordRefillReceipt({ businessId: fixture.business._id, batchId: batch._id, idempotencyKey: 'receipt-over', items: [{ batchItemId: batch.items[0]._id, fullQty: 4 }], receivedBy: fixture.user._id }));
  await recordRefillReceipt({
    businessId: fixture.business._id,
    batchId: batch._id,
    idempotencyKey: 'receipt-2',
    items: [{ batchItemId: batch.items[0]._id, fullQty: 2 }, { batchItemId: batch.items[1]._id, fullQty: 1 }],
    receivedBy: fixture.user._id,
  });
  const persistedBatch = await RefillBatch.findById(batch._id).lean();
  assert.equal(persistedBatch.status, 'received');
  assert.deepEqual(persistedBatch.items.map((item) => item.receivedQty), [5, 3]);
  assert.equal((await summary()).refillChargesPoisha, 8000);

  const replacementResolution = await resolveRefillIssue({
    businessId: fixture.business._id,
    receiptId: firstReceipt._id,
    receiptItemId: firstReceipt.items[0]._id,
    condition: 'rejected',
    quantity: 1,
    action: 'replace',
    idempotencyKey: 'resolution-replace',
    resolvedBy: fixture.user._id,
  });
  assert.equal(await RefillIssueResolution.countDocuments({ _id: replacementResolution._id }), 1);
  let stock = await Stock.findOne({ businessId: fixture.business._id, productId: smallProduct._id }).lean();
  assert.equal(stock.rejectedQty, 1);
  assert.equal(stock.fullQty, 4);

  await recordReplacementReceipt({ businessId: fixture.business._id, resolutionId: replacementResolution._id, idempotencyKey: 'replacement-receipt-1', quantity: 1, chargePoisha: 300, receivedBy: fixture.user._id });
  stock = await Stock.findOne({ businessId: fixture.business._id, productId: smallProduct._id }).lean();
  assert.equal(stock.rejectedQty, 0);
  assert.equal(stock.fullQty, 5);
  assert.equal(await RefillReplacementReceipt.countDocuments({ businessId: fixture.business._id, resolutionId: replacementResolution._id }), 1);
  assert.equal((await summary()).replacementChargesPoisha, 300);

  await recordSupplierPayment({ businessId: fixture.business._id, supplierId: fixture.supplier._id, batchId: batch._id, idempotencyKey: 'payment-1', amountPoisha: 3000, method: 'bank', timing: 'later', paidBy: fixture.user._id });
  assert.equal((await summary()).balancePoisha, 5300);
  await recordSupplierPayment({ businessId: fixture.business._id, supplierId: fixture.supplier._id, batchId: batch._id, idempotencyKey: 'payment-2', amountPoisha: 5300, method: 'cash', timing: 'later', paidBy: fixture.user._id });
  assert.equal(await SupplierPayment.countDocuments({ businessId: fixture.business._id, batchId: batch._id }), 2);
  assert.equal((await summary()).balancePoisha, 0);

  await createRefillRate({ businessId: fixture.business._id, supplierId: fixture.supplier._id, productId: smallProduct._id, unitRatePoisha: 1200, effectiveFrom: new Date(Date.now() + 60_000), createdBy: fixture.user._id });
  const unchangedBatch = await RefillBatch.findById(batch._id).lean();
  assert.equal(unchangedBatch.items[0].unitRatePoisha, 1000);
});

test('verifies idempotency, tenant isolation, brand authorization, and invalid input', async () => {
  const [smallProduct, largeProduct] = fixture.products;
  await createRates();
  const batch = await createBatch();
  const payload = { businessId: fixture.business._id, batchId: batch._id, idempotencyKey: 'receipt-retry', items: [{ batchItemId: batch.items[0]._id, fullQty: 2 }, { batchItemId: batch.items[1]._id, fullQty: 1 }], receivedBy: fixture.user._id };
  const first = await recordRefillReceipt(payload);
  const retry = await recordRefillReceipt(payload);
  const persisted = await RefillReceipt.findOne({ businessId: fixture.business._id, idempotencyKey: 'receipt-retry' }).lean();
  assert.equal(String(first._id), String(retry._id));
  assert.equal(String(retry._id), String(persisted._id));
  assert.equal(await RefillReceipt.countDocuments({ businessId: fixture.business._id, idempotencyKey: 'receipt-retry' }), 1);

  await assert.rejects(recordRefillReceipt({ ...payload, items: [{ batchItemId: batch.items[0]._id, fullQty: 1 }] }));
  await assert.rejects(recordRefillReceipt({ ...payload, idempotencyKey: 'receipt-invalid-quantity', items: [{ batchItemId: batch.items[0]._id, fullQty: -1 }] }));
  await assert.rejects(dispatchRefillBatch({ businessId: fixture.business._id, supplierId: fixture.supplier._id, dispatchNumber: 'invalid-dispatch', items: [{ productId: smallProduct._id, quantity: 0 }], createdBy: fixture.user._id }));
  await assert.rejects(dispatchRefillBatch({ businessId: fixture.otherBusiness._id, supplierId: fixture.supplier._id, dispatchNumber: 'cross-tenant', items: [{ productId: smallProduct._id, quantity: 1 }], createdBy: fixture.otherUser._id }));
  await assert.rejects(createRefillRate({ businessId: fixture.business._id, supplierId: fixture.unauthorizedSupplier._id, productId: smallProduct._id, unitRatePoisha: 1000, createdBy: fixture.user._id }));
  await assert.rejects(createRefillRate({ businessId: fixture.business._id, supplierId: fixture.supplier._id, productId: largeProduct._id, unitRatePoisha: -1, createdBy: fixture.user._id }));
});

test('verifies rollback and concurrent receipt protection using persisted state', async () => {
  const [smallProduct, largeProduct] = fixture.products;
  await createRates();
  const beforeSmall = await Stock.findOne({ businessId: fixture.business._id, productId: smallProduct._id }).lean();
  await assert.rejects(dispatchRefillBatch({ businessId: fixture.business._id, supplierId: fixture.supplier._id, dispatchNumber: 'rollback-dispatch', items: [{ productId: smallProduct._id, quantity: 1 }, { productId: largeProduct._id, quantity: 100 }], createdBy: fixture.user._id }));
  assert.equal(await RefillBatch.countDocuments({ businessId: fixture.business._id, dispatchNumber: 'rollback-dispatch' }), 0);
  const afterSmall = await Stock.findOne({ businessId: fixture.business._id, productId: smallProduct._id }).lean();
  assert.equal(afterSmall.emptyQty, beforeSmall.emptyQty);

  const concurrentBatch = await createBatch('concurrent-dispatch', [2, 1]);
  const results = await Promise.allSettled([
    recordRefillReceipt({ businessId: fixture.business._id, batchId: concurrentBatch._id, idempotencyKey: 'concurrent-a', items: [{ batchItemId: concurrentBatch.items[0]._id, fullQty: 2 }], receivedBy: fixture.user._id }),
    recordRefillReceipt({ businessId: fixture.business._id, batchId: concurrentBatch._id, idempotencyKey: 'concurrent-b', items: [{ batchItemId: concurrentBatch.items[0]._id, fullQty: 2 }], receivedBy: fixture.user._id }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const persistedConcurrentBatch = await RefillBatch.findById(concurrentBatch._id).lean();
  assert.equal(persistedConcurrentBatch.items[0].receivedQty, 2);
  assert.equal(await RefillReceipt.countDocuments({ businessId: fixture.business._id, batchId: concurrentBatch._id }), 1);
});
