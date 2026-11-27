import mongoose from 'mongoose';

/**
 * Optional warehouse (location) for multi-warehouse tenants.
 *
 * This is an ADDITIVE architecture hook, NOT a warehouse-management feature.
 * No routes/UI are provided. `multiWarehouse` on Business defaults to false.
 *
 * Default single-warehouse mode: omit `warehouseId` everywhere -> `null`, which
 * refers to the implicit default warehouse and requires NO Warehouse document
 * and NO setup. When a caller passes a `warehouseId`, ownership is validated
 * (`Warehouse.businessId === businessId`, active). Cross-business references are
 * rejected and read as not-found.
 */
const warehouseSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    code: { type: String, required: true, trim: true, lowercase: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
  },
  { timestamps: true },
);

warehouseSchema.index({ businessId: 1, code: 1 }, { unique: true });
warehouseSchema.index({ businessId: 1, status: 1 });
// At most one default warehouse per business.
warehouseSchema.index({ businessId: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

const Warehouse = mongoose.models.Warehouse || mongoose.model('Warehouse', warehouseSchema);

export default Warehouse;
