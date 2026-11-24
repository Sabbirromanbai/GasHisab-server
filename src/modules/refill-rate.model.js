import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const refillRateSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    brand: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    cylinderSizeKg: {
      type: Number,
      required: true,
      min: 0.01,
      max: 1000,
      validate: { validator: Number.isFinite, message: 'Cylinder size must be a finite number.' },
    },
    unitRatePoisha: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isPoisha,
        message: 'Refill rate must be a safe integer amount in poisha.',
      },
    },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

// New rate records preserve every previous rate for historical dispatches.
refillRateSchema.pre('save', function preventRateEdits() {
  if (!this.isNew) throw new Error('Refill rates are versioned; create a new rate instead.');
});

refillRateSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function preventRateMutation() {
    throw new Error('Refill rate history is append-only. Create a new rate version.');
  },
);

refillRateSchema.pre('deleteOne', { document: true, query: false }, function preventRateDelete() {
  throw new Error('Refill rate history cannot be deleted.');
});

refillRateSchema.pre('bulkWrite', function preventRateBulkMutation(operations) {
  if (operations.some((operation) => !operation.insertOne)) {
    throw new Error('Refill rate history only supports inserts.');
  }
});

refillRateSchema.index(
  { businessId: 1, supplierId: 1, brand: 1, cylinderSizeKg: 1, effectiveFrom: 1 },
  { unique: true },
);

const RefillRate = mongoose.models.RefillRate || mongoose.model('RefillRate', refillRateSchema);

export default RefillRate;
