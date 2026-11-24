import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const replacementReceiptSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillBatch', required: true, immutable: true },
    resolutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillIssueResolution', required: true, immutable: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
    condition: { type: String, enum: ['rejected', 'damaged'], required: true, immutable: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'Replacement quantity must be a positive whole number.' },
      immutable: true,
    },
    chargePoisha: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: { validator: isPoisha, message: 'Replacement charge must be integer poisha.' },
      immutable: true,
    },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
    receivedAt: { type: Date, required: true, default: Date.now, immutable: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    note: { type: String, trim: true, maxlength: 1000, immutable: true },
  },
  { timestamps: true },
);

// Replacement receipts are append-only: each physical receipt is auditable.
replacementReceiptSchema.pre('save', function preventReceiptEdits() {
  if (!this.isNew) throw new Error('Replacement receipt history is append-only.');
});

replacementReceiptSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventReceiptMutation() {
    throw new Error('Replacement receipt history is append-only.');
  },
);

replacementReceiptSchema.pre('deleteOne', { document: true, query: false }, function preventReceiptDelete() {
  throw new Error('Replacement receipt history cannot be deleted.');
});

replacementReceiptSchema.pre('bulkWrite', function preventReceiptBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Replacement receipt history only supports inserts.');
  }
});

replacementReceiptSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
replacementReceiptSchema.index({ businessId: 1, resolutionId: 1, receivedAt: 1 });
replacementReceiptSchema.index({ businessId: 1, supplierId: 1, receivedAt: -1 });

const RefillReplacementReceipt = mongoose.models.RefillReplacementReceipt ||
  mongoose.model('RefillReplacementReceipt', replacementReceiptSchema);

export default RefillReplacementReceipt;
