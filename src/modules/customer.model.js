import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      immutable: true, // a customer can never move tenant
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // `phone` preserved. Requirement `mobile`: `mobile` additive alias; households may share; blank handled safely; not unique.
    phone: { type: String, trim: true, maxlength: 32 }, // preserved; not required (name is the only required field)
    mobile: { type: String, trim: true, maxlength: 32 },
    address: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      required: true,
    },
  },
  { timestamps: true },
);

// Phone numbers are indexed for tenant lookups but are not unique; households may share one.
customerSchema.index({ businessId: 1, status: 1, name: 1 });
customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ businessId: 1, mobile: 1 });

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);

export default Customer;
