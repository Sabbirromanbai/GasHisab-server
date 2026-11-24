import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const refillIssueResolutionSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillBatch', required: true, immutable: true },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillReceipt', required: true, immutable: true },
    receiptItemId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    supersedesResolutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RefillIssueResolution',
      immutable: true,
    },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
    condition: { type: String, enum: ['rejected', 'damaged'], required: true, immutable: true },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'Resolution quantity must be a positive whole number.' },
      immutable: true,
    },
    action: { type: String, enum: ['replace', 'return', 'hold'], required: true, immutable: true },
    // A replacement charge is optional and is kept separate from the original refill rate.
    replacementChargePoisha: { type: Number, min: 0, validate: { validator: isPoisha }, immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true },
);

refillIssueResolutionSchema.pre('save', function preventResolutionEdits() {
  if (!this.isNew) throw new Error('Issue resolutions are append-only.');
});

refillIssueResolutionSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventResolutionMutation() {
    throw new Error('Issue resolution history is append-only.');
  },
);

refillIssueResolutionSchema.pre('deleteOne', { document: true, query: false }, function preventResolutionDelete() {
  throw new Error('Issue resolutions cannot be deleted.');
});

refillIssueResolutionSchema.pre('bulkWrite', function preventResolutionBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Issue resolution history only supports inserts.');
  }
});

refillIssueResolutionSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
refillIssueResolutionSchema.index({ businessId: 1, receiptId: 1, receiptItemId: 1, condition: 1, createdAt: 1 });

const RefillIssueResolution = mongoose.models.RefillIssueResolution ||
  mongoose.model('RefillIssueResolution', refillIssueResolutionSchema);

export default RefillIssueResolution;
