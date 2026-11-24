import mongoose from 'mongoose';

const isWholeQuantity = (value) => Number.isSafeInteger(value) && value >= 0;
const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const refillReceiptItemSchema = new mongoose.Schema(
  {
    batchItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    brand: { type: String, required: true, trim: true, maxlength: 80 },
    cylinderSizeKg: { type: Number, required: true, min: 0.01, max: 1000 },
    fullQty: { type: Number, required: true, default: 0, min: 0, validate: { validator: isWholeQuantity } },
    rejectedQty: { type: Number, required: true, default: 0, min: 0, validate: { validator: isWholeQuantity } },
    damagedQty: { type: Number, required: true, default: 0, min: 0, validate: { validator: isWholeQuantity } },
    unitRatePoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha } },
    chargePoisha: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          const expected = this.fullQty * this.unitRatePoisha;
          return isPoisha(value) && isPoisha(expected) && value === expected;
        },
        message: 'Only full cylinders received are charged at the saved rate.',
      },
    },
  },
  { timestamps: false },
);

const refillReceiptSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillBatch', required: true, immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
    receivedAt: { type: Date, required: true, default: Date.now, immutable: true },
    items: {
      type: [refillReceiptItemSchema],
      required: true,
      validate: [
        { validator: (items) => Array.isArray(items) && items.length > 0, message: 'A receipt must include at least one batch item.' },
        {
          validator: (items) => items.every((item) => item.fullQty + item.rejectedQty + item.damagedQty > 0),
          message: 'Each receipt item must record at least one received cylinder.',
        },
        {
          validator: (items) => new Set(items.map((item) => String(item.batchItemId))).size === items.length,
          message: 'A batch item may appear only once in a receipt.',
        },
      ],
    },
    note: { type: String, trim: true, maxlength: 1000, immutable: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true },
);

// Receipt records are immutable; later partial deliveries create separate receipt records.
refillReceiptSchema.pre('save', function preventReceiptEdits() {
  if (!this.isNew) throw new Error('Refill receipts cannot be overwritten. Create another receipt.');
});

refillReceiptSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventReceiptMutation() {
    throw new Error('Refill receipt history is append-only.');
  },
);

refillReceiptSchema.pre('deleteOne', { document: true, query: false }, function preventReceiptDelete() {
  throw new Error('Refill receipts cannot be deleted.');
});

refillReceiptSchema.pre('bulkWrite', function preventReceiptBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Refill receipt history only supports inserts.');
  }
});

refillReceiptSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
refillReceiptSchema.index({ businessId: 1, batchId: 1, receivedAt: 1 });
refillReceiptSchema.index({ businessId: 1, supplierId: 1, receivedAt: -1 });

const RefillReceipt =
  mongoose.models.RefillReceipt || mongoose.model('RefillReceipt', refillReceiptSchema);

export default RefillReceipt;
