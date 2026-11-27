import mongoose from 'mongoose';

/**
 * Cylinder size catalog (hybrid scope). See brand.model.js for scope rules.
 *
 * `capacityGrams` replaces the legacy `Product.cylinderSizeKg` float for
 * references, but the legacy field is preserved. No hardcoded size list.
 * `segment`/`label*` are optional and not assigned any business rule here.
 */
const cylinderSizeSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['shared', 'business'], required: true, default: 'business', index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, immutable: true },
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    capacityGrams: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'Capacity must be a whole number of grams.' } },
    tareWeightGrams: { type: Number, min: 0, validate: { validator: Number.isSafeInteger } },
    segment: { type: String, enum: ['domestic', 'commercial', 'autogas', 'industrial', 'other'], trim: true },
    labelEn: { type: String, required: true, trim: true, maxlength: 120 },
    labelBn: { type: String, trim: true, maxlength: 120 },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

cylinderSizeSchema.index({ businessId: 1, status: 1, sortOrder: 1 });

// Partial unique on `code`, NOT on `capacityGrams` (multiple segments may share grams).
cylinderSizeSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { scope: 'shared' } },
);
cylinderSizeSchema.index(
  { businessId: 1, code: 1 },
  { unique: true, partialFilterExpression: { scope: 'business' } },
);

const CylinderSize = mongoose.models.CylinderSize || mongoose.model('CylinderSize', cylinderSizeSchema);

export default CylinderSize;
