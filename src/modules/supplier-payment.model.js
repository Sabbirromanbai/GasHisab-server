import mongoose from 'mongoose';

const supplierPaymentSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true },
    // OPTIONAL. Previously required for refill; keep populated for refill_batch
    // payments. Existing refill payments always have it; new sources may not.
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillBatch', immutable: true },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillReceipt', immutable: true },
    // Backward-compatible source fields for future Purchase support. Additive;
    // append-only so existing rows are never rewritten. `businessId`+`supplierId`
    // must match the source; services re-validate, `ref` alone does not.
    sourceType: {
      type: String,
      enum: ['refill_batch', 'purchase', 'opening_balance', 'advance'],
      default: 'refill_batch',
      required: true,
      immutable: true,
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, // batchId for refill, purchaseId for purchase
    purchaseId: { type: mongoose.Schema.Types.ObjectId, immutable: true }, // nullable; future Purchase
    type: { type: String, enum: ['payment', 'refund'], default: 'payment', required: true, immutable: true },
    paidAt: { type: Date, immutable: true }, // optional; `createdAt` remains available
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
    amountPoisha: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Supplier payment must be a positive whole number of poisha.',
      },
      immutable: true,
    },
    method: { type: String, enum: ['cash', 'bkash', 'nagad', 'bank', 'other'], required: true, immutable: true },
    // `timing` is refill-specific; kept required + unchanged for backward compatibility.
    timing: { type: String, enum: ['dispatch', 'receiving', 'later'], required: true, immutable: true },
    reference: { type: String, trim: true, maxlength: 120, immutable: true },
    note: { type: String, trim: true, maxlength: 1000, immutable: true },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  },
  { timestamps: true },
);

// Supplier payments have their own append-only ledger, separate from customer payments.
supplierPaymentSchema.pre('save', function preventPaymentEdits() {
  if (!this.isNew) throw new Error('Supplier payment history is append-only.');
});
supplierPaymentSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventPaymentMutation() {
    throw new Error('Supplier payment history is append-only.');
  },
);
supplierPaymentSchema.pre('deleteOne', { document: true, query: false }, function preventPaymentDelete() {
  throw new Error('Supplier payment records cannot be deleted.');
});
supplierPaymentSchema.pre('bulkWrite', function preventPaymentBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Supplier payment history only supports inserts.');
  }
});

supplierPaymentSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
supplierPaymentSchema.index({ businessId: 1, supplierId: 1, createdAt: -1 });
supplierPaymentSchema.index({ businessId: 1, batchId: 1, createdAt: -1 });
supplierPaymentSchema.index({ businessId: 1, receiptId: 1, createdAt: -1 });
supplierPaymentSchema.index({ businessId: 1, sourceType: 1, sourceId: 1, createdAt: -1 });

const SupplierPayment = mongoose.models.SupplierPayment ||
  mongoose.model('SupplierPayment', supplierPaymentSchema);

export default SupplierPayment;
