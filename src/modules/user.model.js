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
    // Keep stored hashes out of ordinary query results; authentication is added separately.
    passwordHash: { type: String, required: true, minlength: 1, select: false },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      required: true,
    },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

export default User;
