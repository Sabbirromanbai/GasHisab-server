import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    brand: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    cylinderSizeKg: {
      type: Number,
      required: true,
      min: 0.01,
      max: 1000,
      validate: {
        validator: Number.isFinite,
        message: 'Cylinder size must be a finite number.',
      },
    },
    // Prices are integer poisha, not decimal taka, to avoid floating-point rounding.
    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Purchase price must be a safe integer amount in poisha.',
      },
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Selling price must be a safe integer amount in poisha.',
      },
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      required: true,
    },
  },
  { timestamps: true },
);

// Case-normalized brand and size identify one product within a business.
productSchema.index({ businessId: 1, brand: 1, cylinderSizeKg: 1 }, { unique: true });
productSchema.index({ businessId: 1, status: 1 });

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

export default Product;
