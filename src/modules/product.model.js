import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      immutable: true, // a product can never move tenant
    },
    // ---- Catalog v2 (additive; optional; shared-or-owned reference) ----
    kind: { type: String, enum: ['lpg_cylinder', 'accessory', 'service'], default: 'lpg_cylinder', required: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand' }, // shared OR this business's custom; never cross-business
    cylinderSizeId: { type: mongoose.Schema.Types.ObjectId, ref: 'CylinderSize' }, // shared OR owned
    sku: { type: String, trim: true, maxlength: 64 }, // per-business optional; unique when present
    nameEn: { type: String, trim: true, maxlength: 160 }, // optional override; else catalog name
    nameBn: { type: String, trim: true, maxlength: 160 },
    // ---- Legacy fields preserved (not removed; not renamed) ----
    brand: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    cylinderSizeKg: {
      type: Number,
      required: true,
      min: 0.01,
      max: 1000,
      validate: { validator: Number.isFinite, message: 'Cylinder size must be a finite number.' },
    },
    // Prices are integer poisha, not decimal taka, to avoid floating-point rounding.
    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'Purchase price must be a safe integer amount in poisha.' },
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'Selling price must be a safe integer amount in poisha.' },
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
  },
  { timestamps: true },
);

// ---- Uniqueness ----
// Legacy (preserved): case-normalized brand + size identify one product within a business.
productSchema.index({ businessId: 1, brand: 1, cylinderSizeKg: 1 }, { unique: true });
// Catalog v2: one LPG cylinder per business + brand + size. Partial; only when brandId+cylinderSizeId present.
productSchema.index(
  { businessId: 1, brandId: 1, cylinderSizeId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { kind: 'lpg_cylinder', brandId: { $type: 'objectId' }, cylinderSizeId: { $type: 'objectId' } } },
);
// Per-business optional SKU. Partial; only when `sku` is a string.
productSchema.index(
  { businessId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $exists: true, $type: 'string' } } },
);
productSchema.index({ businessId: 1, status: 1 });
productSchema.index({ businessId: 1, brandId: 1, status: 1 });

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

export default Product;
