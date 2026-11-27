/**
 * Money and quantity primitives for the GasHisab domain.
 *
 * Design rules:
 *   - Money is stored and computed exclusively in integer poisha (1 poisha = 1/100 BDT).
 *   - Floating-point is never used for money; taka conversion happens only at the edge.
 *   - Quantities (cylinders) and capacities (grams) are whole integers.
 *   - All arithmetic validates safe-integer bounds before returning.
 *   - Invalid or unsafe values throw ValidationError; nothing is silently rounded.
 */
import { ValidationError } from '../errors.js';

const POISHA_PER_TAKA = 100;
const MAX_SAFE_POISHA = Number.MAX_SAFE_INTEGER;
const MAX_TAKA_DECIMAL_PLACES = 2;

// Recognised `fromTaka` rounding modes (see doc below).
const ROUNDING_MODES = new Set(['reject', 'round', 'floor', 'ceil']);

// Plain signed decimal only — no exponent, no NaN/Infinity. Exact digit capture.
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

const toCanonicalString = (value) => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'string') return value.trim();
  return String(value);
};

/**
 * Parse and validate an integer poisha value from a number or string.
 *
 * @param {number|string|bigint} value - Poisha amount.
 * @param {object} [options]
 * @param {boolean} [options.allowNegative=false] - Allow negative poisha (e.g. refunds/adjustments).
 * @returns {number} Validated integer poisha.
 */
export const toPoisha = (value, { allowNegative = false } = {}) => {
  if (value === null || value === undefined) {
    throw new ValidationError('A numeric amount is required.', 'INVALID_AMOUNT');
  }

  // Reject non-numeric inputs instead of coercing (e.g. a single-element array).
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') {
    throw new ValidationError('Amount must be a number, numeric string, or bigint.', 'INVALID_AMOUNT');
  }

  const raw = toCanonicalString(value);

  // Reject non-numeric strings early instead of coercing them to NaN/0.
  if (!/^-?\d+$/.test(raw)) {
    throw new ValidationError('Amount must be a whole number of poisha.', 'INVALID_AMOUNT');
  }

  const parsed = BigInt(raw);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError('Amount exceeds the safe-integer range.', 'AMOUNT_OUT_OF_RANGE');
  }

  const poisha = Number(parsed);
  if (!allowNegative && poisha < 0) {
    throw new ValidationError('Amount must be zero or positive.', 'AMOUNT_NEGATIVE');
  }

  return poisha;
};

/**
 * Convert a taka decimal to integer poisha using exact decimal-string / BigInt arithmetic.
 *
 * The input is interpreted as taka (e.g. 12.50 → 1250 poisha). No binary
 * floating-point is used: the raw string is parsed digit-by-digit and poisha is
 * computed with BigInt, so `1.005`, `1.015`, `10.999`, negatives, and values
 * near the safe-integer limit are handled exactly. The result must be a safe
 * integer poisha or `AMOUNT_OUT_OF_RANGE` is thrown.
 *
 * Rounding modes (applied only when the taka value has >2 decimal places):
 *   - `reject` (default): throw `TAKA_PRECISION_ERROR`. Safe default.
 *   - `round`:  round half **away from zero** (`1.005`→`101`, `-1.005`→`-101`, `1.236`→`124`, `1.234`→`123`).
 *   - `floor`:  round **toward −∞** (`1.239`→`123`, `-1.231`→`-124`).
 *   - `ceil`:   round **toward +∞** (`1.231`→`124`, `-1.239`→`-123`).
 * `reject` requires at most two decimal places. Unknown modes throw `INVALID_ROUNDING_MODE`.
 * Plain signed decimal only; exponent/NaN/Infinity inputs are rejected.
 *
 * @param {number|string} taka - Taka amount (finite number or plain decimal string).
 * @param {object} [options]
 * @param {'reject'|'round'|'floor'|'ceil'} [options.rounding='reject']
 * @param {boolean} [options.allowNegative=false] - Allow negative poisha output.
 * @returns {number} Integer poisha.
 */
export const fromTaka = (taka, { rounding = 'reject', allowNegative = false } = {}) => {
  if (!ROUNDING_MODES.has(rounding)) {
    throw new ValidationError('Unknown rounding mode.', 'INVALID_ROUNDING_MODE');
  }
  if (taka === null || taka === undefined) {
    throw new ValidationError('A taka amount is required.', 'INVALID_TAKA');
  }
  if (typeof taka !== 'number' && typeof taka !== 'string') {
    throw new ValidationError('Taka amount must be a number or numeric string.', 'INVALID_TAKA');
  }

  let raw;
  if (typeof taka === 'number') {
    if (!isFiniteNumber(taka)) {
      throw new ValidationError('Taka amount must be a finite number.', 'INVALID_TAKA');
    }
    raw = taka.toString(); // shortest round-trip decimal; plain form expected
  } else {
    raw = taka.trim();
  }

  // Capture exact digits; reject exponent/NaN/empty. No Number() coercion.
  const match = DECIMAL_PATTERN.exec(raw);
  if (!match) {
    throw new ValidationError('Taka amount must be a plain decimal number.', 'INVALID_TAKA');
  }
  const negative = match[1] === '-';
  const whole = match[2];
  const fraction = match[3] ?? '';

  // Digits beyond the 2nd fractional place drive rounding/rejection.
  const extra = fraction.length > 2 ? fraction.slice(2) : '';
  const hasExtraDigits = extra.length > 0; // any digit past 2dp, incl. trailing zeros
  const hasNonZeroRemainder = /[1-9]/.test(extra);
  const firstExtraDigit = extra.length > 0 ? extra[0] : '0';

  if (rounding === 'reject' && hasExtraDigits) {
    throw new ValidationError('Taka amount must have at most two decimal places.', 'TAKA_PRECISION_ERROR');
  }

  // Base poisha truncated toward zero: keep first two fractional digits.
  const twoFrac = (fraction + '00').slice(0, 2); // exactly two digits, e.g. '05'
  let magnitude = BigInt(whole) * 100n + BigInt(twoFrac);

  if (rounding === 'round') {
    // round half away from zero: a 3rd digit >= 5 bumps the magnitude up by one poisha.
    if (hasExtraDigits && firstExtraDigit >= '5') magnitude += 1n;
  } else if (rounding === 'floor') {
    // toward -Infinity: extra magnitude on the negative side rounds outward.
    if (negative && hasNonZeroRemainder) magnitude += 1n;
  } else if (rounding === 'ceil') {
    // toward +Infinity: extra magnitude on the positive side rounds outward.
    if (!negative && hasNonZeroRemainder) magnitude += 1n;
  }

  const result = negative ? -magnitude : magnitude;
  return toPoisha(result, { allowNegative });
};

/**
 * Format integer poisha as a taka decimal string with exactly two decimal places.
 * Language-neutral (no locale digits); formatting for display happens at the UI edge.
 *
 * @param {number|string|bigint} poisha
 * @returns {string} e.g. '125.00'
 */
export const poishaToTaka = (poisha) => {
  const p = toPoisha(poisha, { allowNegative: true });
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  const whole = Math.floor(abs / POISHA_PER_TAKA);
  const cents = abs % POISHA_PER_TAKA;
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
};

/**
 * Sum one or more poisha values, validating safe-integer bounds.
 *
 * @param {...(number|string|bigint)} values
 * @returns {number} Total integer poisha.
 */
export const addPoisha = (...values) => {
  if (values.length === 0) return 0;
  let total = 0n;
  for (const value of values) {
    total += BigInt(toPoisha(value, { allowNegative: true }));
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ValidationError('Money sum exceeds the safe-integer range.', 'AMOUNT_OUT_OF_RANGE');
  }
  return Number(total);
};

/**
 * Subtract poisha: `minuend - subtrahend`. Result may be negative; bounds are validated.
 *
 * @param {number|string|bigint} minuend
 * @param {number|string|bigint} subtrahend
 * @returns {number} Integer poisha difference.
 */
export const subtractPoisha = (minuend, subtrahend) =>
  addPoisha(minuend, -toPoisha(subtrahend, { allowNegative: true }));

/**
 * Validate that a value is a whole, safe-integer poisha amount.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {boolean} [options.allowNegative=false]
 * @returns {number} The validated poisha integer.
 */
export const validatePoisha = (value, options = {}) => toPoisha(value, options);

/**
 * Validate a whole quantity (e.g. cylinder count).
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.min=0]
 * @param {number} [options.max]
 * @returns {number} Validated integer quantity.
 */
export const validateQuantity = (value, { min = 0, max } = {}) => {
  const q = toPoisha(value, { allowNegative: min < 0 });
  if (q < min) {
    throw new ValidationError(`Quantity must be at least ${min}.`, 'QUANTITY_BELOW_MIN');
  }
  if (max !== undefined && q > max) {
    throw new ValidationError(`Quantity must be at most ${max}.`, 'QUANTITY_ABOVE_MAX');
  }
  return q;
};

/**
 * Validate a cylinder capacity in grams.
 *
 * @param {unknown} value
 * @returns {number} Validated integer grams.
 */
export const validateCapacityGrams = (value) =>
  validateQuantity(value, { min: 0 });

export { POISHA_PER_TAKA, MAX_SAFE_POISHA, MAX_TAKA_DECIMAL_PLACES };
