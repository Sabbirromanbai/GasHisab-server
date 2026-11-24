import mongoose from 'mongoose';

const stockMovementSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
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
      enum: ['full', 'empty', 'rejected', 'damaged'],
    },
    direction: { type: String, enum: ['in', 'out'] },
    reference: { type: String, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 1000 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

// Tenant-first indexes support product history and movement reports within one business.
stockMovementSchema.index({ businessId: 1, productId: 1, createdAt: -1 });
stockMovementSchema.index({ businessId: 1, movementType: 1, createdAt: -1 });

const StockMovement =
  mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);

export default StockMovement;
