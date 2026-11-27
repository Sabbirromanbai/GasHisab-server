import mongoose from 'mongoose';

/**
 * Tenant-scoped monotonic sequence counter.
 *
 * One document per `{ businessId, key }` (e.g. key = 'sale'|'purchase'|...).
 * `seq` is incremented atomically with `$inc`, inside the same transaction that
 * creates the referencing document, so concurrent requests cannot receive the
 * same number for the same business/sequence. Unique `{ businessId, key }`.
 */
const counterSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    key: { type: String, required: true, trim: true, maxlength: 64 },
    seq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

counterSchema.index({ businessId: 1, key: 1 }, { unique: true });

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

export default Counter;
