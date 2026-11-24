import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
    address: { type: String, trim: true, maxlength: 500 },
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

const Customer = mongoose.models.Customer || mongoose.model('Customer', customerSchema);

export default Customer;
