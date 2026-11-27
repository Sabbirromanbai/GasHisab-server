/**
 * Shared backend kernel (Phase 1).
 *
 * Single import surface for cross-cutting utilities. Re-exports the Phase 0
 * typed errors; does NOT redefine error types or reimplement money/tenant logic.
 */
export * from '../errors.js';

export * from './money.js';
export * from './transaction.js';
export * from './tenant-repo.js';
export * from './idempotency.js';
export * from './counter.js';
export * from './validation.js';
