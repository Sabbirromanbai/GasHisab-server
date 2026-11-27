/**
 * Shared domain validation and stable constants.
 *
 * All database values are language-neutral (codes only); English/Bangla labels live
 * in the UI layer. Validators throw ValidationError so services never guess status
 * codes from message text.
 */
import mongoose from 'mongoose';
import { ValidationError } from '../errors.js';

export const ROLES = Object.freeze(['owner', 'admin', 'staff']);
export const BUSINESS_STATUSES = Object.freeze(['active', 'suspended']);
export const MEMBER_STATUSES = Object.freeze(['active', 'suspended']);

const MAX_STRING_LENGTH = 1000;

/**
 * Parse and validate a MongoDB ObjectId.
 *
 * @param {unknown} value
 * @param {string} field - Field name for the error message.
 * @returns {mongoose.Types.ObjectId}
 */
export const requireObjectId = (value, field) => {
  if (!mongoose.isValidObjectId(value)) {
    throw new ValidationError(`A valid ${field} is required.`, 'VALIDATION_ERROR');
  }
  return new mongoose.Types.ObjectId(value);
};

export const isObjectId = (value) => mongoose.isValidObjectId(value);

/**
 * Validate a non-empty string, trimmed, with an optional max length.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {object} [options]
 * @param {number} [options.max=MAX_STRING_LENGTH]
 * @returns {string}
 */
export const requireNonEmptyString = (value, field, { max = MAX_STRING_LENGTH } = {}) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required.`, 'INVALID_STRING');
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters.`, 'STRING_TOO_LONG');
  }
  return trimmed;
};

/**
 * Validate a business role.
 *
 * @param {unknown} role
 * @returns {string}
 */
export const requireRole = (role) => {
  if (!ROLES.includes(role)) {
    throw new ValidationError(`Role must be one of: ${ROLES.join(', ')}.`, 'INVALID_ROLE');
  }
  return role;
};

/**
 * Validate a business/member status.
 *
 * @param {unknown} status
 * @param {'business'|'member'} [scope='business']
 * @returns {string}
 */
export const requireStatus = (status, scope = 'business') => {
  const allowed = scope === 'member' ? MEMBER_STATUSES : BUSINESS_STATUSES;
  if (!allowed.includes(status)) {
    throw new ValidationError(
      `${scope} status must be one of: ${allowed.join(', ')}.`,
      'INVALID_STATUS',
    );
  }
  return status;
};
