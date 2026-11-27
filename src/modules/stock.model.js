import mongoose from 'mongoose';

const quantityField = () => ({
  type: Number,
  required: true,
  default: 0,
  min: 0,
  validate: {
    validator: Number.isSafeInteger,
    message: 'Stock quantity must be a non-negative whole number.',
  },
});

const stockSchema = new mongoose.Schema(
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
    // Optional multi-warehouse. `null` = implicit default single warehouse (no Warehouse doc needed).
    // Ownership is validated in inventory.service; never trusted from request input. Additive.
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    fullQty: quantityField(),
    emptyQty: quantityField(),
    // Refill receipts keep rejected cylinders separate from damaged ones.
    rejectedQty: quantityField(),
    damagedQty: quantityField(),
    // NEW CYLINDER inventory (new filled cylinders bought via Purchase). Separate from full/empty/damaged/rejected.
    // Additive; min0; NOT required + NOT assumed so existing rows + refill upserts aren't broken; treated as 0 when absent.
    newQty: { type: Number, default: 0, min: 0, validate: { validator: Number.isSafeInteger, message: 'newQty must be a non-negative whole number.' } },
    // Optimistic-concurrency version. Optional/additive; existing stock rows
    // without it are unaffected. Atomic $inc/$gte updates remain primary; a
    // caller may read-modify-write with a version filter when needed.
    version: { type: Number, default: 0, min: 0, validate: { validator: Number.isSafeInteger } },
  },
  { timestamps: true, optimisticConcurrency: true },
);

// One inventory balance per product per warehouse in each business.
// `warehouseId: null` = default single warehouse. In single-warehouse mode this is
// equivalent to `{businessId,productId}`; multi-warehouse adds per-warehouse rows.
// Existing single-warehouse data (warehouseId absent/null) migrates non-destructively.
stockSchema.index({ businessId: 1, productId: 1, warehouseId: 1 }, { unique: true });

const Stock = mongoose.models.Stock || mongoose.model('Stock', stockSchema);

export default Stock;
