import mongoose from 'mongoose';

const addressSchema = new mongoose.Schema(
  {
    addressLine1: { type: String, trim: true, maxlength: 160 },
    addressLine2: { type: String, trim: true, maxlength: 160 },
    city: { type: String, trim: true, maxlength: 100 },
    region: { type: String, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 24 },
    country: { type: String, trim: true, maxlength: 100 },
  },
  { _id: false },
);

const contactSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    phone: { type: String, trim: true, maxlength: 32 },
  },
  { _id: false },
);

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Slugs are global so each business has one unambiguous public identifier.
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 120,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    },
    contact: { type: contactSchema, default: () => ({}) },
    address: { type: addressSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      required: true,
    },
    // Bumped on every membership mutation. Concurrent owner changes write this
    // same document so MongoDB raises a write conflict instead of letting two
    // requests both pass the last-owner check and orphan the business.
    membershipRevision: { type: Number, default: 0, min: 0 },
    // Optional multi-warehouse mode. Default false = single (implicit default) warehouse; no setup required.
    // Additive; existing businesses are unaffected. No warehouse-management feature is implemented here.
    multiWarehouse: { type: Boolean, default: false, required: true },
  },
  { timestamps: true },
);

businessSchema.index({ slug: 1 }, { unique: true });

const Business = mongoose.models.Business || mongoose.model('Business', businessSchema);

export default Business;
