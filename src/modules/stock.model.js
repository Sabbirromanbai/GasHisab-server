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
    fullQty: quantityField(),
    emptyQty: quantityField(),
    // Refill receipts keep rejected cylinders separate from damaged ones.
    rejectedQty: quantityField(),
    damagedQty: quantityField(),
  },
  { timestamps: true },
);

// One inventory balance is maintained for each product in each business.
stockSchema.index({ businessId: 1, productId: 1 }, { unique: true });

const Stock = mongoose.models.Stock || mongoose.model('Stock', stockSchema);

export default Stock;
