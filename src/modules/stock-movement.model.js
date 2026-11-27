import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * StockMovement is an append-only ledger.
 *
 * Historical documents predate the new optional fields; every field added in
 * Phase 2 Step 1 is optional so existing rows and existing refill inserts keep
 * working. `reference` (free-form, non-unique) is preserved untouched.
 */
const stockMovementSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      immutable: true, // a movement can never change tenant
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
    },
    // Optional multi-warehouse location. `null` = default single warehouse. Additive; immutable.
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null, immutable: true },
    movementType: {
      type: String,
      enum: [
        'purchase',
        'sale',
        'exchange',
        'return',
        'adjustment',
        'refill_dispatch',
        'refill_receipt',
        'supplier_return',
        'replacement',
      ],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Movement quantity must be a positive whole number.',
      },
    },
    stockBucket: {
      type: String,
      enum: ['full', 'empty', 'rejected', 'damaged', 'new'], // 'new' = separate new-cylinder inventory
    },
    direction: { type: String, enum: ['in', 'out'] },
    // Source references (optional; additive). Never trusted from request input;
    // services must verify `businessId`/`productId` match `req.auth`.
    sourceType: { type: String, trim: true, maxlength: 64, immutable: true }, // e.g. 'purchase','sale','refill_receipt',...
    sourceId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, // source document id
    sourceLineId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, // embedded line id
    movementGroupId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, // one logical op => one group
    unitCostPoisha: { type: Number, min: 0, validate: { validator: isPoisha }, immutable: true }, // integer poisha; optional
    reference: { type: String, trim: true, maxlength: 120 }, // preserved; not unique
    note: { type: String, trim: true, maxlength: 1000 },
    // Manual-adjustment / opening-stock justification. Append-only; part of immutable audit history.
    reason: { type: String, trim: true, maxlength: 500 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Optional caller-supplied idempotency key. When present it is unique per
    // business. NOT required, and NOT backfilled on historical rows, so existing
    // append-only refill data is untouched.
    idempotencyKey: { type: String, trim: true, maxlength: 120, immutable: true },
  },
  { timestamps: true },
);

// Tenant-first indexes support product history and movement reports within one business.
stockMovementSchema.index({ businessId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ businessId: 1, productId: 1, warehouseId: 1, createdAt: -1 });
stockMovementSchema.index({ businessId: 1, movementType: 1, createdAt: -1 });
// Partial unique: only protect rows that actually carry an idempotency key.
// Historical rows (no key) are excluded, so index creation can't collide on them.
stockMovementSchema.index(
  { businessId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } } },
);
// Source tracing (no uniqueness here; source-level idempotency lives on source docs).
stockMovementSchema.index({ businessId: 1, sourceType: 1, sourceId: 1, sourceLineId: 1 });
stockMovementSchema.index({ businessId: 1, movementGroupId: 1 });

// Append-only enforcement, mirroring Payment/SupplierPayment. Corrections are new movements.
stockMovementSchema.pre('save', function preventMovementEdits() {
  if (!this.isNew) throw new Error('Stock movement history is append-only.');
});
stockMovementSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventMovementMutation() {
    throw new Error('Stock movement history is append-only.');
  },
);
stockMovementSchema.pre('deleteOne', { document: true, query: false }, function preventMovementDelete() {
  throw new Error('Stock movement records cannot be deleted.');
});
stockMovementSchema.pre('bulkWrite', function preventMovementBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Stock movement history only supports inserts.');
  }
});

const StockMovement =
  mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);

export default StockMovement;
