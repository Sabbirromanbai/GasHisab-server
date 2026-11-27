/**
 * Reusable idempotency for mutating commands.
 *
 * Pattern (matches the existing append-only refill model):
 *   - Caller supplies `businessId` (from `req.auth`, not user input), a stable
 *     `idempotencyKey`, and a `requestHash`.
 *   - `requestHash` is a deterministic SHA-256 of the canonical request payload.
 *   - Same key + same payload → return the existing record (no duplicate work).
 *   - Same key + different payload → ConflictError (IDEMPOTENCY_CONFLICT).
 *   - Concurrent duplicates are made safe by a unique index `{ businessId, idempotencyKey }`;
 *     a `11000` write conflict is reconciled by re-reading and checking the hash.
 *   - `requestHash` fields are `select:false` in Mongoose; reads use `+requestHash`.
 */
import { createHash } from 'node:crypto';
import { ConflictError, ValidationError } from '../errors.js';
import { inTransaction } from './transaction.js';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 120;

/** Stable canonical JSON stringify (object keys sorted recursively; Date/ObjectId handled). */
export const stableStringify = (value) => {
  const seen = new WeakSet();
  const sort = (input) => {
    if (input === null || typeof input !== 'object') return input;
    if (input instanceof Date) return input.toISOString();
    if (seen.has(input)) throw new ValidationError('Cannot hash circular structure.', 'INVALID_HASH_INPUT');
    seen.add(input);
    if (Array.isArray(input)) return input.map(sort);
    // Delegate non-plain objects (Mongoose ObjectId, etc.) to their JSON form.
    if (typeof input.toJSON === 'function') {
      const json = input.toJSON();
      return json === input ? null : sort(json);
    }
    const out = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue; // match JSON.stringify which drops undefined
      out[key] = sort(v);
    }
    return out;
  };
  return JSON.stringify(sort(value));
};

/**
 * Normalize and validate an idempotency key.
 *
 * @param {unknown} key
 * @returns {string} Trimmed non-empty key.
 * @throws {ValidationError}
 */
export const normalizeIdempotencyKey = (key) => {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError('An idempotency key is required.', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const trimmed = key.trim();
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new ValidationError(
      `Idempotency key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
      'IDEMPOTENCY_KEY_TOO_LONG',
    );
  }
  return trimmed;
};

/**
 * Deterministic request hash for idempotency matching.
 *
 * @param {*} payload - Serializable request payload. Object key order does not matter.
 * @returns {string} SHA-256 hex digest.
 */
export const generateRequestHash = (payload) =>
  createHash('sha256').update(stableStringify(payload)).digest('hex');

/**
 * Find an existing idempotent record, explicitly selecting the hidden requestHash.
 *
 * @param {import('mongoose').Model} Model
 * @param {object} filter - Must include `businessId` and `idempotencyKey`.
 * @returns {Promise<object|null>}
 */
export const findIdempotentRecord = (Model, filter) =>
  Model.findOne(filter).select('+requestHash').lean();

/**
 * Reconcile an existing idempotent record against the current requestHash.
 * Same key + same payload → return existing; same key + different payload → ConflictError.
 *
 * @param {object|null} existing
 * @param {string} requestHash
 * @returns {object|null}
 * @throws {ConflictError}
 */
export const assertIdempotentMatch = (existing, requestHash) => {
  if (existing && existing.requestHash !== requestHash) {
    throw new ConflictError(
      'This idempotency key was already used for a different request.',
      'IDEMPOTENCY_CONFLICT',
    );
  }
  return existing ?? null;
};

/**
 * Run `work` once for a given `{ businessId, idempotencyKey }`, deduplicating retries
 * and concurrent duplicate requests. `authorize` runs before any cache lookup so a
 * duplicate retry cannot bypass authorization.
 *
 * @param {object} args
 * @param {import('mongoose').Model} args.model - Append-only model with unique `{businessId,idempotencyKey}` + `requestHash(select:false)`.
 * @param {object} args.filter - Must contain `businessId` and `idempotencyKey`.
 * @param {string} args.requestHash - generateRequestHash(payload).
 * @param {Function} [args.authorize] - Async re-check run before returning cached results.
 * @param {Function} args.work - Async `(session) => result` performing writes inside a transaction.
 * @param {import('mongoose').ClientSession} [args.session] - Existing session to join.
 * @returns {Promise<*>}
 */
export const runIdempotently = async ({
  model,
  filter,
  requestHash,
  authorize,
  work,
  session: providedSession,
}) => {
  if (authorize) await authorize();

  const filterWithHash = { ...filter };
  const findVisible = () => model.findOne(filter);

  const existing = await findIdempotentRecord(model, filterWithHash);
  if (existing) {
    assertIdempotentMatch(existing, requestHash);
    return findVisible();
  }

  const executeWork = async (session) => {
    // Re-check inside the transaction: a prior attempt in the same call chain may
    // have already created the record, and `withTransaction` may retry the callback.
    const recheck = await findIdempotentRecord(model, filterWithHash).session(session);
    if (recheck) {
      assertIdempotentMatch(recheck, requestHash);
      return recheck;
    }
    return work(session);
  };

  try {
    return await inTransaction(executeWork, { session: providedSession });
  } catch (error) {
    // A concurrent retry can win the unique-index race; return its result only for the same request.
    if (error?.code !== 11000) throw error;
    const duplicate = await findIdempotentRecord(model, filterWithHash);
    if (!duplicate) throw error;
    assertIdempotentMatch(duplicate, requestHash);
    return findVisible();
  }
};
