/**
 * Atomic, tenant-scoped sequence generation for server-generated document numbers.
 *
 * `nextSequence` atomically increments a per-`{ businessId, key }` counter using
 * `$inc` with upsert, **within the caller's transaction session**. If the
 * surrounding transaction rolls back, the counter increment rolls back too, so
 * numbers are never consumed by a failed operation. Concurrent transactions on
 * the same `{ businessId, key }` conflict on the single Counter document; MongoDB
 * serializes them and `withTransaction` retries, so no two documents share a number.
 */
import Counter from '../modules/counter.model.js';
import { ValidationError } from '../errors.js';
import { requireObjectId } from './validation.js';

/**
 * Atomically reserve the next sequence number for a tenant + key.
 *
 * @param {string|mongoose.Types.ObjectId} businessId - Tenant; never trusted from user input.
 * @param {string} key - Sequence name, e.g. 'sale', 'purchase', 'expense'.
 * @param {import('mongoose').ClientSession} session - Active transaction session. Required.
 * @returns {Promise<number>} The new sequence number (starts at 1).
 */
export const nextSequence = async (businessId, key, session) => {
  if (!session) {
    throw new ValidationError('nextSequence must run inside a transaction session.', 'SESSION_REQUIRED');
  }
  const tenantId = requireObjectId(businessId, 'business id');
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError('A sequence key is required.', 'INVALID_SEQUENCE_KEY');
  }

  const updated = await Counter.findOneAndUpdate(
    { businessId: tenantId, key: key.trim() },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, session },
  ).lean();

  const seq = updated?.seq;
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new ValidationError('Sequence generation failed.', 'SEQUENCE_ERROR');
  }
  return seq;
};

/**
 * Format a document number from a prefix + sequence.
 * `formatDocumentNumber('INV', 42)` → `'INV-000042'`. Language-neutral.
 */
export const formatDocumentNumber = (prefix, seq, { width = 6 } = {}) => {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new ValidationError('Sequence number must be a positive integer.', 'INVALID_SEQUENCE');
  }
  return `${prefix}-${String(seq).padStart(width, '0')}`;
};
