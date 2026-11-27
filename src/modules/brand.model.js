import mongoose from 'mongoose';

/**
 * Brand catalog (hybrid scope).
 *
 * `scope: 'shared'`  -> platform reference data, `businessId: null`. Readable by
 *                       all tenants; managed by platform admins. NOT tenant-owned.
 * `scope: 'business'` -> dealer-owned custom entry. `businessId` is the owning
 *                       tenant; it must match `Product.businessId`. Cross-business
 *                       custom references are forbidden.
 *
 * No pre-seeded list. `code` is a stable lowercase key, not the display name.
 * `nameEn`/`nameBn` are display labels; DB keys stay language-neutral.
 */
const brandSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ['shared', 'business'], required: true, default: 'business', index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, immutable: true },
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    nameEn: { type: String, required: true, trim: true, maxlength: 120 },
    nameBn: { type: String, trim: true, maxlength: 120 },
    logoUrl: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// `scope` consistency is also enforced in catalog.service; schema keeps data shape safe.
brandSchema.index({ businessId: 1, status: 1, nameEn: 1 });

// Partial unique: shared entries unique by code among shared; custom entries unique per business.
brandSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { scope: 'shared' } },
);
brandSchema.index(
  { businessId: 1, code: 1 },
  { unique: true, partialFilterExpression: { scope: 'business' } },
);

const Brand = mongoose.models.Brand || mongoose.model('Brand', brandSchema);

export default Brand;
