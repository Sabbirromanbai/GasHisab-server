import mongoose from 'mongoose';

const isWholeQuantity = (value) => Number.isSafeInteger(value) && value >= 0;
const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const refillBatchItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      immutable: true,
    },
    brand: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
    cylinderSizeKg: { type: Number, required: true, min: 0.01, max: 1000, immutable: true },
    dispatchedQty: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'Dispatch quantity must be a positive whole number.' },
      immutable: true,
    },
    receivedQty: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator(value) {
          return isWholeQuantity(value) && value <= this.dispatchedQty;
        },
        message: 'Received quantity cannot exceed the dispatched quantity.',
      },
    },
    rateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RefillRate',
      required: true,
      immutable: true,
    },
    unitRatePoisha: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: isPoisha, message: 'Rate snapshot must be integer poisha.' },
      immutable: true,
    },
  },
  { timestamps: false },
);

const refillBatchSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      immutable: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      immutable: true,
    },
    dispatchNumber: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
    brand: { type: String, required: true, trim: true, maxlength: 80, immutable: true },
    dispatchedAt: { type: Date, required: true, default: Date.now, immutable: true },
    items: {
      type: [refillBatchItemSchema],
      required: true,
      validate: [
        {
          validator: (items) => Array.isArray(items) && items.length > 0,
          message: 'A refill batch must contain at least one cylinder size.',
        },
        {
          validator: (items) => new Set(items.map((item) => String(item.productId))).size === items.length,
          message: 'A product may appear only once in a refill batch.',
        },
        {
          validator(items) {
            return new Set(items.map((item) => item.brand)).size === 1 &&
              items.every((item) => item.brand === this.brand);
          },
          message: 'A refill batch must contain only its registered brand.',
        },
      ],
    },
    status: {
      type: String,
      enum: ['dispatched', 'partially_received', 'received'],
      default: 'dispatched',
      required: true,
    },
    resolutionRevision: { type: Number, default: 0, min: 0, select: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
  },
  { timestamps: true, optimisticConcurrency: true },
);

refillBatchSchema.index({ businessId: 1, dispatchNumber: 1 }, { unique: true });
refillBatchSchema.index({ businessId: 1, supplierId: 1, status: 1, dispatchedAt: -1 });

const RefillBatch = mongoose.models.RefillBatch || mongoose.model('RefillBatch', refillBatchSchema);

export default RefillBatch;
