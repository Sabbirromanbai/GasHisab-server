/**
 * Shared MongoDB/Mongoose transaction utility.
 *
 * Consolidates the transaction options and session lifecycle previously
 * duplicated in `src/modules/business.service.js` and `src/modules/refill.service.js`.
 * All multi-document writes that move money or stock must run through this wrapper.
 *
 * Behavior:
 *   - Snapshot read concern + majority write concern + primary read preference.
 *   - Uses `session.withTransaction`, which commits, rolls back on error, and retries
 *     transient transaction errors — exactly as the pre-existing code did.
 *   - Session is always ended in `finally`, even on success or error.
 *   - Errors from `work` propagate to the caller.
 *   - Accidental nesting is avoided: passing an already-active transaction session
 *     joins it instead of starting a new one.
 */
import mongoose from 'mongoose';

export const TRANSACTION_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
});

/**
 * Whether a Mongoose session already has a transaction started.
 * Defensive: `ClientSession.inTransaction()` exists in recent Mongoose versions;
 * fall back to checking `session.transaction` when unavailable.
 */
const sessionHasTransaction = (session) => {
  if (typeof session.inTransaction === 'function') {
    return session.inTransaction();
  }
  return Boolean(session.transaction);
};

/**
 * Run `work` inside a MongoDB transaction.
 *
 * @param {Function} work - Async function receiving the Mongoose session.
 * @param {object} [options]
 * @param {import('mongoose').ClientSession} [options.session] - Existing session to join.
 * @returns {Promise<*>} The result of `work`.
 */
export const inTransaction = async (work, { session: providedSession } = {}) => {
  // Join an in-progress transaction instead of starting a nested one.
  if (providedSession && sessionHasTransaction(providedSession)) {
    return work(providedSession);
  }

  const session = providedSession ?? await mongoose.startSession();
  const ownsSession = !providedSession;

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    }, TRANSACTION_OPTIONS);
    return result;
  } finally {
    if (ownsSession) await session.endSession().catch(() => {});
  }
};
