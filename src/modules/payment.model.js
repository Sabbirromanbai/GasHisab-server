import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sale',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    // Amounts are integer poisha so payment records stay exact.
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Payment amount must be a positive whole number of poisha.',
      },
    },
    method: {
      type: String,
      enum: ['cash', 'bkash', 'nagad', 'bank', 'other'],
      required: true,
    },
    reference: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 1000 },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

// Payments are append-only: corrections should be recorded as new entries, not edits.
paymentSchema.pre('save', function preventPaymentEdits() {
  if (!this.isNew) {
    throw new Error('Payment records cannot be overwritten. Create a new payment entry.');
  }
});

paymentSchema.pre('deleteOne', { document: true, query: false }, function preventDocumentDelete() {
  throw new Error('Payment records cannot be deleted.');
});

paymentSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  function preventPaymentMutation() {
    throw new Error('Payment history is append-only. Create a new payment entry.');
  },
);

// Permit bulk inserts, but block bulk updates and deletes to preserve payment history.
paymentSchema.pre('bulkWrite', function preventBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Bulk payment changes may only insert new payment entries.');
  }
});

paymentSchema.index({ businessId: 1, saleId: 1, createdAt: 1 });
paymentSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });

const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

export default Payment;
