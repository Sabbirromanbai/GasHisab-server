import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Normalize email before the unique index so casing cannot create duplicate accounts.
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      required: true,
    },
    // These fields are written by Better Auth into this same users collection.
    emailVerified: { type: Boolean, default: false },
    image: { type: String, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

export default User;
