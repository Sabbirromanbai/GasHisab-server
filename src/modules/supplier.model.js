import mongoose from 'mongoose';

const supplierBrandSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', required: true },
  },
  { _id: false },
);

const supplierSchema = new mongoose.Schema(
  {
    // This is the dealer's tenant-scoped record for an external LPG plant.
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    contact: {
      phone: { type: String, trim: true, maxlength: 32 },
      email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    },
    address: { type: String, trim: true, maxlength: 500 },
    brandAuthorizations: { type: [supplierBrandSchema], default: [] },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true },
  },
  { timestamps: true },
);

supplierSchema.index({ businessId: 1, name: 1 });
supplierSchema.index({ businessId: 1, 'brandAuthorizations.brand': 1, 'brandAuthorizations.status': 1 });

const Supplier = mongoose.models.Supplier || mongoose.model('Supplier', supplierSchema);

export default Supplier;
