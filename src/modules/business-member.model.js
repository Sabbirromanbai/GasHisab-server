import mongoose from 'mongoose';

const businessMemberSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'staff'],
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      required: true,
    },
  },
  { timestamps: true },
);

// Enforce one membership per user/business pair and support tenant-scoped member lookups.
businessMemberSchema.index({ businessId: 1, userId: 1 }, { unique: true });
businessMemberSchema.index({ businessId: 1, status: 1 });
businessMemberSchema.index({ userId: 1, status: 1 });

const BusinessMember =
  mongoose.models.BusinessMember || mongoose.model('BusinessMember', businessMemberSchema);

export default BusinessMember;
