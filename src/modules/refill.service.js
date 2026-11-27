import mongoose from 'mongoose';
import { inTransaction, generateRequestHash, runIdempotently } from '../kernel/index.js';
import Business from './business.model.js';
import BusinessMember from './business-member.model.js';
import Product from './product.model.js';
import User from './user.model.js';
import RefillBatch from './refill-batch.model.js';
import RefillIssueResolution from './refill-issue-resolution.model.js';
import RefillRate from './refill-rate.model.js';
import RefillReceipt from './refill-receipt.model.js';
import Stock from './stock.model.js';
import StockMovement from './stock-movement.model.js';
import SupplierPayment from './supplier-payment.model.js';
import Supplier from './supplier.model.js';
import RefillReplacementReceipt from './refill-replacement-receipt.model.js';

const toId = (value) => new mongoose.Types.ObjectId(value);
const idString = (value) => String(value);
const isWholeQuantity = (value) => Number.isSafeInteger(value) && value >= 0;
const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;
const fingerprint = generateRequestHash;

const requireValue = (value, message) => {
  if (value === undefined || value === null || value === '') throw new Error(message);
};

const assertTenantBusiness = async (businessId, session) => {
  const business = await Business.findOne({ _id: businessId, status: 'active' })
    .select('_id')
    .session(session);
  if (!business) throw new Error('Active business was not found.');
};

const assertSupplier = async (supplierId, businessId, session) => {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId, status: 'active' })
    .select('_id businessId brandAuthorizations')
    .session(session);
  if (!supplier) throw new Error('Active supplier was not found.');
  return supplier;
};

// Backward compatible: `target` may be a legacy brand string or a Product.
// Matches an authorized `brand` string, or an optional `brandId` reference.
const assertSupplierBrand = (supplier, target) => {
  const brand = typeof target === 'string' ? target : target?.brand;
  const brandId = typeof target === 'string' ? undefined : target?.brandId;
  const authorized = supplier.brandAuthorizations.some(
    (entry) => entry.status === 'active' && (
      entry.brand === brand ||
      (brandId && entry.brandId && String(entry.brandId) === String(brandId))
    ),
  );
  if (!authorized) throw new Error('This supplier is not authorized to refill the requested LPG brand.');
};

const assertActor = async (actorId, businessId, session) => {
  const actor = await User.exists({ _id: actorId, status: 'active' }).session(session);
  const membership = await BusinessMember.exists({ businessId, userId: actorId, status: 'active' }).session(session);
  if (!actor || !membership) throw new Error('An active business member was not found.');
};

const addStockMovement = (movement) => ({
  businessId: movement.businessId,
  productId: movement.productId,
  movementType: movement.movementType,
  quantity: movement.quantity,
  stockBucket: movement.stockBucket,
  direction: movement.direction,
  reference: movement.reference,
  note: movement.note,
  createdBy: movement.createdBy,
});

const updateStockForReceipt = async ({ businessId, productId, receivedBy, receiptId, item, session }) => {
  const quantities = {
    fullQty: item.fullQty,
    rejectedQty: item.rejectedQty,
    damagedQty: item.damagedQty,
  };
  const increments = Object.fromEntries(Object.entries(quantities).filter(([, quantity]) => quantity > 0));

  if (Object.keys(increments).length > 0) {
    const initialStock = {
      businessId,
      productId,
      fullQty: 0,
      emptyQty: 0,
      rejectedQty: 0,
      damagedQty: 0,
    };
    for (const field of Object.keys(increments)) delete initialStock[field];

    await Stock.updateOne(
      { businessId, productId },
      { $setOnInsert: initialStock, $inc: increments },
      { upsert: true, session, runValidators: true, setDefaultsOnInsert: false },
    );
  }

  const movements = [
    ['full', item.fullQty],
    ['rejected', item.rejectedQty],
    ['damaged', item.damagedQty],
  ]
    .filter(([, quantity]) => quantity > 0)
    .map(([stockBucket, quantity]) => addStockMovement({
      businessId,
      productId,
      movementType: 'refill_receipt',
      quantity,
      stockBucket,
      direction: 'in',
      reference: `refill:${receiptId}:${stockBucket}`,
      note: 'Received in a refill delivery.',
      createdBy: receivedBy,
    }));

  if (movements.length > 0) await StockMovement.create(movements, { session, ordered: true });
};

export const createRefillRate = async ({
  businessId,
  supplierId,
  productId,
  unitRatePoisha,
  effectiveFrom = new Date(),
  createdBy,
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(supplierId, 'supplierId is required.');
  requireValue(productId, 'productId is required.');
  requireValue(createdBy, 'createdBy is required.');
  if (!isPoisha(unitRatePoisha)) throw new Error('Rate must be a non-negative safe integer amount in poisha.');

  const tenantId = toId(businessId);
  const supplierBusinessId = toId(supplierId);
  const productObjectId = toId(productId);
  const actorId = toId(createdBy);
  const startsAt = new Date(effectiveFrom);
  if (Number.isNaN(startsAt.getTime())) throw new Error('effectiveFrom must be a valid date.');

  return inTransaction(async (session) => {
    await assertTenantBusiness(tenantId, session);
    const supplier = await assertSupplier(supplierBusinessId, tenantId, session);
    await assertActor(actorId, tenantId, session);

    // A refill rate can only be registered for an active product owned by this plant.
    const product = await Product.findOne({
      _id: productObjectId,
      businessId: tenantId,
      status: 'active',
    }).session(session);
    if (!product) throw new Error('Active product was not found in this business.');
    assertSupplierBrand(supplier, product);

    const rate = new RefillRate({
      businessId: tenantId,
      supplierId: supplierBusinessId,
      productId: product._id,
      brand: product.brand,
      cylinderSizeKg: product.cylinderSizeKg,
      unitRatePoisha,
      effectiveFrom: startsAt,
      createdBy: actorId,
    });
    await rate.save({ session });
    return rate;
  });
};

export const dispatchRefillBatch = async ({
  businessId,
  supplierId,
  dispatchNumber,
  items,
  createdBy,
  dispatchedAt = new Date(),
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(supplierId, 'supplierId is required.');
  requireValue(dispatchNumber?.trim(), 'dispatchNumber is required.');
  requireValue(createdBy, 'createdBy is required.');
  if (!Array.isArray(items) || items.length === 0) throw new Error('At least one product is required.');

  const tenantId = toId(businessId);
  const supplierBusinessId = toId(supplierId);
  const actorId = toId(createdBy);
  const dispatchedDate = new Date(dispatchedAt);
  if (Number.isNaN(dispatchedDate.getTime())) throw new Error('dispatchedAt must be a valid date.');

  const requestedItems = items.map(({ productId, quantity }) => {
    requireValue(productId, 'Every batch item requires a productId.');
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('Dispatch quantities must be positive whole numbers.');
    }
    return { productId: toId(productId), quantity };
  });
  if (new Set(requestedItems.map(({ productId }) => idString(productId))).size !== requestedItems.length) {
    throw new Error('A product may appear only once in a refill batch.');
  }

  const requestHash = fingerprint({
    businessId: idString(tenantId),
    supplierId: idString(supplierBusinessId),
    dispatchNumber: dispatchNumber.trim(),
    createdBy: idString(actorId),
    items: requestedItems
      .map(({ productId, quantity }) => ({ productId: idString(productId), quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId)),
  });
  const filter = { businessId: tenantId, dispatchNumber: dispatchNumber.trim() };

  return runIdempotently({
    model: RefillBatch,
    filter,
    requestHash,
    authorize: async () => {
      await assertTenantBusiness(tenantId);
      await assertSupplier(supplierBusinessId, tenantId);
      await assertActor(actorId, tenantId);
    },
    work: async (session) => {
      await assertTenantBusiness(tenantId, session);
      const supplier = await assertSupplier(supplierBusinessId, tenantId, session);
      await assertActor(actorId, tenantId, session);

      const products = await Product.find({
        _id: { $in: requestedItems.map(({ productId }) => productId) },
        businessId: tenantId,
        status: 'active',
      }).session(session);
      if (products.length !== requestedItems.length) {
        throw new Error('Every refill product must be active and owned by this business.');
      }

      const productById = new Map(products.map((product) => [idString(product._id), product]));
      const brandSet = new Set(products.map((product) => product.brand));
      if (brandSet.size !== 1) throw new Error('A refill batch can contain only one registered LPG brand.');
      assertSupplierBrand(supplier, products[0]);

      const snapshots = [];
      for (const requested of requestedItems) {
        const product = productById.get(idString(requested.productId));
        const rate = await RefillRate.findOne({
          businessId: tenantId,
          supplierId: supplierBusinessId,
          productId: product._id,
          brand: product.brand,
          cylinderSizeKg: product.cylinderSizeKg,
          effectiveFrom: { $lte: dispatchedDate },
        })
          .sort({ effectiveFrom: -1 })
          .session(session);
        if (!rate) throw new Error('No effective refill rate exists for a batch product and supplier.');

        snapshots.push({
          productId: product._id,
          brand: product.brand,
          cylinderSizeKg: product.cylinderSizeKg,
          dispatchedQty: requested.quantity,
          receivedQty: 0,
          rateId: rate._id,
          unitRatePoisha: rate.unitRatePoisha,
        });
      }

      const batch = new RefillBatch({
        ...filter,
        supplierId: supplierBusinessId,
        requestHash,
        brand: [...brandSet][0],
        dispatchedAt: dispatchedDate,
        items: snapshots,
        status: 'dispatched',
        createdBy: actorId,
      });
      await batch.save({ session });

      // Empty cylinders leave saleable stock when they are physically dispatched for refill.
      const dispatchMovements = [];
      for (const item of batch.items) {
        const stockUpdate = await Stock.updateOne(
          { businessId: tenantId, productId: item.productId, emptyQty: { $gte: item.dispatchedQty } },
          { $inc: { emptyQty: -item.dispatchedQty } },
          { session, runValidators: true },
        );
        if (stockUpdate.matchedCount !== 1) {
          throw new Error('Insufficient empty-cylinder stock to dispatch the refill batch.');
        }
        dispatchMovements.push(addStockMovement({
          businessId: tenantId,
          productId: item.productId,
          movementType: 'refill_dispatch',
          quantity: item.dispatchedQty,
          stockBucket: 'empty',
          direction: 'out',
          reference: `refill-batch:${idString(batch._id)}:dispatch`,
          note: 'Empty cylinders dispatched for refill.',
          createdBy: actorId,
        }));
      }
      await StockMovement.create(dispatchMovements, { session, ordered: true });
      return batch;
    },
  });
};

export const recordRefillReceipt = async ({
  businessId,
  batchId,
  idempotencyKey,
  items,
  receivedBy,
  receivedAt = new Date(),
  note,
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(batchId, 'batchId is required.');
  requireValue(idempotencyKey?.trim(), 'idempotencyKey is required.');
  requireValue(receivedBy, 'receivedBy is required.');
  if (!Array.isArray(items) || items.length === 0) throw new Error('At least one receipt item is required.');

  const tenantId = toId(businessId);
  const refillBatchId = toId(batchId);
  const actorId = toId(receivedBy);
  const receivedDate = new Date(receivedAt);
  if (Number.isNaN(receivedDate.getTime())) throw new Error('receivedAt must be a valid date.');

  const requestedItems = items.map(({ batchItemId, fullQty = 0, rejectedQty = 0, damagedQty = 0 }) => {
    requireValue(batchItemId, 'Every receipt item requires a batchItemId.');
    if (![fullQty, rejectedQty, damagedQty].every(isWholeQuantity)) {
      throw new Error('Received, rejected, and damaged quantities must be non-negative whole numbers.');
    }
    if (fullQty + rejectedQty + damagedQty === 0) {
      throw new Error('Every receipt item must contain at least one cylinder.');
    }
    return { batchItemId: toId(batchItemId), fullQty, rejectedQty, damagedQty };
  });
  if (new Set(requestedItems.map(({ batchItemId }) => idString(batchItemId))).size !== requestedItems.length) {
    throw new Error('A batch item may appear only once in a receipt.');
  }

  const requestHash = fingerprint({
    businessId: idString(tenantId),
    batchId: idString(refillBatchId),
    receivedBy: idString(actorId),
    note: note?.trim() ?? '',
    items: requestedItems
      .map((item) => ({ ...item, batchItemId: idString(item.batchItemId) }))
      .sort((a, b) => a.batchItemId.localeCompare(b.batchItemId)),
  });
  const filter = { businessId: tenantId, idempotencyKey: idempotencyKey.trim() };

  return runIdempotently({
    model: RefillReceipt,
    filter,
    requestHash,
    authorize: async () => {
      await assertTenantBusiness(tenantId);
      await assertActor(actorId, tenantId);
    },
    work: async (session) => {
      const prior = await RefillReceipt.findOne(filter).select('+requestHash').session(session);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Idempotency key was reused with different receipt data.');
        return RefillReceipt.findOne(filter).session(session);
      }

      await assertTenantBusiness(tenantId, session);
      await assertActor(actorId, tenantId, session);
      const batch = await RefillBatch.findOne({ _id: refillBatchId, businessId: tenantId }).session(session);
      if (!batch || batch.status === 'received') {
        throw new Error('An open refill batch was not found for this business.');
      }

      const receiptItems = [];
      for (const requested of requestedItems) {
        const batchItem = batch.items.id(requested.batchItemId);
        if (!batchItem) throw new Error('Receipt item does not belong to the selected batch.');

        const totalQty = requested.fullQty + requested.rejectedQty + requested.damagedQty;
        if (!Number.isSafeInteger(totalQty) || totalQty > batchItem.dispatchedQty - batchItem.receivedQty) {
          throw new Error('Receipt quantity exceeds the remaining dispatch quantity.');
        }
        const chargePoisha = requested.fullQty * batchItem.unitRatePoisha;
        if (!isPoisha(chargePoisha)) throw new Error('Receipt charge exceeds the safe integer range.');

        batchItem.receivedQty += totalQty;
        receiptItems.push({
          batchItemId: batchItem._id,
          productId: batchItem.productId,
          brand: batchItem.brand,
          cylinderSizeKg: batchItem.cylinderSizeKg,
          ...requested,
          unitRatePoisha: batchItem.unitRatePoisha,
          chargePoisha,
        });
      }

      batch.status = batch.items.every((item) => item.receivedQty === item.dispatchedQty)
        ? 'received'
        : 'partially_received';
      await batch.save({ session });

      const [receipt] = await RefillReceipt.create(
        [{
          businessId: tenantId,
          supplierId: batch.supplierId,
          batchId: batch._id,
          idempotencyKey: idempotencyKey.trim(),
          requestHash,
          receivedAt: receivedDate,
          items: receiptItems,
          note,
          receivedBy: actorId,
        }],
        { session, ordered: true },
      );

      for (const item of receipt.items) {
        await updateStockForReceipt({
          businessId: tenantId,
          productId: item.productId,
          receivedBy: actorId,
          receiptId: receipt._id,
          item,
          session,
        });
      }

      return receipt;
    },
  });
};

export const resolveRefillIssue = async ({
  businessId,
  receiptId,
  receiptItemId,
  condition,
  quantity,
  action,
  supersedesResolutionId,
  replacementChargePoisha,
  idempotencyKey,
  resolvedBy,
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(receiptId, 'receiptId is required.');
  requireValue(receiptItemId, 'receiptItemId is required.');
  requireValue(idempotencyKey?.trim(), 'idempotencyKey is required.');
  requireValue(resolvedBy, 'resolvedBy is required.');
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Resolution quantity must be a positive whole number.');
  if (!['rejected', 'damaged'].includes(condition)) throw new Error('Issue condition must be rejected or damaged.');
  if (!['replace', 'return', 'hold'].includes(action)) throw new Error('Issue action must be replace, return, or hold.');
  if (replacementChargePoisha !== undefined && (!isPoisha(replacementChargePoisha) || action !== 'replace')) {
    throw new Error('An optional replacement charge must be safe integer poisha and apply only to replacements.');
  }

  const tenantId = toId(businessId);
  const refillReceiptId = toId(receiptId);
  const itemId = toId(receiptItemId);
  const actorId = toId(resolvedBy);
  const requestHash = fingerprint({
    businessId: idString(tenantId),
    receiptId: idString(refillReceiptId),
    receiptItemId: idString(itemId),
    supersedesResolutionId: supersedesResolutionId ? idString(toId(supersedesResolutionId)) : null,
    condition,
    quantity,
    action,
    replacementChargePoisha: replacementChargePoisha ?? null,
    resolvedBy: idString(actorId),
  });
  const filter = { businessId: tenantId, idempotencyKey: idempotencyKey.trim() };

  return runIdempotently({
    model: RefillIssueResolution,
    filter,
    requestHash,
    authorize: async () => {
      await assertTenantBusiness(tenantId);
      await assertActor(actorId, tenantId);
    },
    work: async (session) => {
      const prior = await RefillIssueResolution.findOne(filter).select('+requestHash').session(session);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Idempotency key was reused with different resolution data.');
        return RefillIssueResolution.findOne(filter).session(session);
      }

      await assertTenantBusiness(tenantId, session);
      await assertActor(actorId, tenantId, session);
      const receipt = await RefillReceipt.findOne({ _id: refillReceiptId, businessId: tenantId }).session(session);
      if (!receipt) throw new Error('Receipt was not found in this business.');
      const receiptItem = receipt.items.id(itemId);
      if (!receiptItem) throw new Error('Receipt item was not found.');

      const defectQty = receiptItem[`${condition}Qty`];
      const priorResolutions = await RefillIssueResolution.find({
        businessId: tenantId,
        receiptId: receipt._id,
        receiptItemId: itemId,
        condition,
      }).session(session);
      const childQuantities = new Map();
      for (const priorResolution of priorResolutions) {
        if (priorResolution.supersedesResolutionId) {
          const parentId = idString(priorResolution.supersedesResolutionId);
          childQuantities.set(parentId, (childQuantities.get(parentId) ?? 0) + priorResolution.quantity);
        }
      }
      const remainingFor = (resolution) =>
        resolution.quantity - (childQuantities.get(idString(resolution._id)) ?? 0);
      const currentlyAllocated = priorResolutions.reduce(
        (sum, resolution) => sum + remainingFor(resolution),
        0,
      );
      const superseded = supersedesResolutionId
        ? priorResolutions.find((resolution) => idString(resolution._id) === idString(toId(supersedesResolutionId)))
        : undefined;

      if (supersedesResolutionId) {
        if (!superseded || superseded.action !== 'hold' || remainingFor(superseded) < quantity) {
          throw new Error('Only currently held cylinders can be reclassified, up to their held quantity.');
        }
      } else if (quantity > defectQty - currentlyAllocated) {
        throw new Error('Resolution quantity exceeds the remaining rejected or damaged cylinders.');
      }

      // This shared write makes concurrent resolutions re-check the same receipt quantities.
      const batchUpdate = await RefillBatch.updateOne(
        { _id: receipt.batchId, businessId: tenantId },
        { $inc: { resolutionRevision: 1 } },
        { session },
      );
      if (batchUpdate.matchedCount !== 1) throw new Error('The receipt batch was not found in this business.');

      const stockBucket = condition;
      if (action === 'return') {
        const decrement = condition === 'rejected' ? 'rejectedQty' : 'damagedQty';

        const stockUpdate = await Stock.updateOne(
          { businessId: tenantId, productId: receiptItem.productId, [decrement]: { $gte: quantity } },
          { $inc: { [decrement]: -quantity } },
          { session, runValidators: true },
        );
        if (stockUpdate.matchedCount !== 1) {
          throw new Error('Tracked rejected or damaged stock is insufficient for this resolution.');
        }

        const movements = [addStockMovement({
          businessId: tenantId,
          productId: receiptItem.productId,
          movementType: 'supplier_return',
          quantity,
          stockBucket,
          direction: 'out',
          reference: `issue:${idString(refillReceiptId)}:${idString(itemId)}:${condition}:out`,
          note: 'Returned to the supplier.',
          createdBy: actorId,
        })];
        await StockMovement.create(movements, { session, ordered: true });
      }

      const resolution = new RefillIssueResolution({
        businessId: tenantId,
        supplierId: receipt.supplierId,
        batchId: receipt.batchId,
        receiptId: receipt._id,
        receiptItemId: receiptItem._id,
        supersedesResolutionId: superseded?._id,
        productId: receiptItem.productId,
        condition,
        quantity,
        action,
        replacementChargePoisha,
        idempotencyKey: idempotencyKey.trim(),
        requestHash,
        resolvedBy: actorId,
      });
      await resolution.save({ session });
      return resolution;
    },
  });
};

export const recordReplacementReceipt = async ({
  businessId,
  resolutionId,
  idempotencyKey,
  quantity,
  chargePoisha = 0,
  receivedBy,
  receivedAt = new Date(),
  note,
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(resolutionId, 'resolutionId is required.');
  requireValue(idempotencyKey?.trim(), 'idempotencyKey is required.');
  requireValue(receivedBy, 'receivedBy is required.');
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Replacement quantity must be a positive whole number.');
  if (!isPoisha(chargePoisha)) throw new Error('Replacement charge must be a non-negative safe integer in poisha.');

  const tenantId = toId(businessId);
  const replacementResolutionId = toId(resolutionId);
  const actorId = toId(receivedBy);
  const receivedDate = new Date(receivedAt);
  if (Number.isNaN(receivedDate.getTime())) throw new Error('receivedAt must be a valid date.');
  const requestHash = fingerprint({
    businessId: idString(tenantId),
    resolutionId: idString(replacementResolutionId),
    quantity,
    chargePoisha,
    receivedBy: idString(actorId),
    note: note?.trim() ?? '',
  });
  const filter = { businessId: tenantId, idempotencyKey: idempotencyKey.trim() };

  return runIdempotently({
    model: RefillReplacementReceipt,
    filter,
    requestHash,
    authorize: async () => {
      await assertTenantBusiness(tenantId);
      await assertActor(actorId, tenantId);
    },
    work: async (session) => {
      const prior = await RefillReplacementReceipt.findOne(filter).select('+requestHash').session(session);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Idempotency key was reused with different replacement data.');
        return RefillReplacementReceipt.findOne(filter).session(session);
      }
      await assertTenantBusiness(tenantId, session);
      await assertActor(actorId, tenantId, session);
      const resolution = await RefillIssueResolution.findOne({
        _id: replacementResolutionId,
        businessId: tenantId,
        action: 'replace',
      }).session(session);
      if (!resolution) throw new Error('A replacement resolution was not found in this business.');

      const existing = await RefillReplacementReceipt.aggregate([
        { $match: { businessId: tenantId, resolutionId: replacementResolutionId } },
        { $group: { _id: null, quantity: { $sum: '$quantity' } } },
      ]).session(session);
      const receivedQty = existing[0]?.quantity ?? 0;
      if (quantity > resolution.quantity - receivedQty) throw new Error('Replacement quantity exceeds the unresolved replacement quantity.');

      const decrement = resolution.condition === 'rejected' ? 'rejectedQty' : 'damagedQty';
      const stockUpdate = await Stock.updateOne(
        { businessId: tenantId, productId: resolution.productId, [decrement]: { $gte: quantity } },
        { $inc: { [decrement]: -quantity, fullQty: quantity } },
        { session, runValidators: true },
      );
      if (stockUpdate.matchedCount !== 1) throw new Error('Tracked defective stock is insufficient for this replacement receipt.');

      const [replacementReceipt] = await RefillReplacementReceipt.create([{
        businessId: tenantId,
        supplierId: resolution.supplierId,
        batchId: resolution.batchId,
        resolutionId: resolution._id,
        productId: resolution.productId,
        condition: resolution.condition,
        quantity,
        chargePoisha,
        idempotencyKey: idempotencyKey.trim(),
        requestHash,
        receivedAt: receivedDate,
        receivedBy: actorId,
        note,
      }], { session, ordered: true });

      await StockMovement.create([
        addStockMovement({
          businessId: tenantId,
          productId: resolution.productId,
          movementType: 'replacement',
          quantity,
          stockBucket: resolution.condition,
          direction: 'out',
          reference: `replacement:${idString(replacementReceipt._id)}:out`,
          note: 'Defective cylinder removed when physical replacement was received.',
          createdBy: actorId,
        }),
        addStockMovement({
          businessId: tenantId,
          productId: resolution.productId,
          movementType: 'replacement',
          quantity,
          stockBucket: 'full',
          direction: 'in',
          reference: `replacement:${idString(replacementReceipt._id)}:in`,
          note: 'Replacement full cylinder physically received.',
          createdBy: actorId,
        }),
      ], { session, ordered: true });
      return replacementReceipt;
    },
  });
};

export const recordSupplierPayment = async ({
  businessId,
  supplierId,
  batchId,
  receiptId,
  idempotencyKey,
  amountPoisha,
  method,
  timing,
  reference,
  note,
  paidBy,
}) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(supplierId, 'supplierId is required.');
  requireValue(batchId, 'batchId is required.');
  requireValue(idempotencyKey?.trim(), 'idempotencyKey is required.');
  requireValue(paidBy, 'paidBy is required.');
  if (!Number.isSafeInteger(amountPoisha) || amountPoisha < 1) {
    throw new Error('Supplier payment must be a positive safe integer amount in poisha.');
  }
  if (!['cash', 'bkash', 'nagad', 'bank', 'other'].includes(method)) throw new Error('Unsupported supplier payment method.');
  if (!['dispatch', 'receiving', 'later'].includes(timing)) throw new Error('Payment timing must be dispatch, receiving, or later.');
  if (timing === 'receiving' && !receiptId) throw new Error('A receiving-time supplier payment must reference its receipt.');

  const tenantId = toId(businessId);
  const supplierBusinessId = toId(supplierId);
  const refillBatchId = toId(batchId);
  const receiptObjectId = receiptId ? toId(receiptId) : undefined;
  const actorId = toId(paidBy);
  const requestHash = fingerprint({
    businessId: idString(tenantId),
    supplierId: idString(supplierBusinessId),
    batchId: idString(refillBatchId),
    receiptId: receiptObjectId ? idString(receiptObjectId) : null,
    amountPoisha,
    method,
    timing,
    reference: reference?.trim() ?? '',
    note: note?.trim() ?? '',
    paidBy: idString(actorId),
  });
  const filter = { businessId: tenantId, idempotencyKey: idempotencyKey.trim() };

  return runIdempotently({
    model: SupplierPayment,
    filter,
    requestHash,
    authorize: async () => {
      await assertTenantBusiness(tenantId);
      await assertSupplier(supplierBusinessId, tenantId);
      await assertActor(actorId, tenantId);
    },
    work: async (session) => {
      const prior = await SupplierPayment.findOne(filter).select('+requestHash').session(session);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Idempotency key was reused with different payment data.');
        return SupplierPayment.findOne(filter).session(session);
      }

      await assertTenantBusiness(tenantId, session);
      await assertSupplier(supplierBusinessId, tenantId, session);
      await assertActor(actorId, tenantId, session);
      const batch = await RefillBatch.findOne({
        _id: refillBatchId,
        businessId: tenantId,
        supplierId: supplierBusinessId,
      }).session(session);
      if (!batch) throw new Error('Refill batch was not found for this supplier and business.');

      if (receiptObjectId) {
        const receipt = await RefillReceipt.findOne({
          _id: receiptObjectId,
          businessId: tenantId,
          supplierId: supplierBusinessId,
          batchId: refillBatchId,
        }).session(session);
        if (!receipt) throw new Error('Receipt was not found for this supplier batch.');
      }

      const payment = new SupplierPayment({
        businessId: tenantId,
        supplierId: supplierBusinessId,
        batchId: refillBatchId,
        receiptId: receiptObjectId,
        idempotencyKey: idempotencyKey.trim(),
        requestHash,
        amountPoisha,
        method,
        timing,
        reference,
        note,
        paidBy: actorId,
      });
      await payment.save({ session });
      return payment;
    },
  });
};

export const getSupplierAccountSummary = async ({ businessId, supplierId, requestedBy }) => {
  requireValue(businessId, 'businessId is required.');
  requireValue(supplierId, 'supplierId is required.');
  requireValue(requestedBy, 'requestedBy is required.');
  const tenantId = toId(businessId);
  const supplierBusinessId = toId(supplierId);
  const actorId = toId(requestedBy);

  return inTransaction(async (session) => {
    await assertTenantBusiness(tenantId, session);
    await assertSupplier(supplierBusinessId, tenantId, session);
    await assertActor(actorId, tenantId, session);
    const match = { businessId: tenantId, supplierId: supplierBusinessId };
    const receipts = await RefillReceipt.aggregate([
      { $match: match },
      { $unwind: '$items' },
      { $group: { _id: null, total: { $sum: '$items.chargePoisha' } } },
    ]).session(session);
    const replacements = await RefillReplacementReceipt.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$chargePoisha' } } },
    ]).session(session);
    const payments = await SupplierPayment.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amountPoisha' } } },
    ]).session(session);

    const refillChargesPoisha = receipts[0]?.total ?? 0;
    const replacementChargesPoisha = replacements[0]?.total ?? 0;
    const paymentsPoisha = payments[0]?.total ?? 0;
    const totals = [refillChargesPoisha, replacementChargesPoisha, paymentsPoisha];
    if (!totals.every(Number.isSafeInteger)) {
      throw new Error('Supplier account total exceeds the safe integer poisha range.');
    }
    const balancePoisha = refillChargesPoisha + replacementChargesPoisha - paymentsPoisha;
    if (!Number.isSafeInteger(balancePoisha)) {
      throw new Error('Supplier balance exceeds the safe integer poisha range.');
    }
    return {
      refillChargesPoisha,
      replacementChargesPoisha,
      paymentsPoisha,
      balancePoisha,
    };
  });
};
