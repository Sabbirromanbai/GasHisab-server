import mongoose from 'mongoose';

const supplierPaymentSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillBatch', required: true, immutable: true },
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'RefillReceipt', immutable: true },
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

const SupplierPayment = mongoose.models.SupplierPayment ||
  mongoose.model('SupplierPayment', supplierPaymentSchema);

export default SupplierPayment;
