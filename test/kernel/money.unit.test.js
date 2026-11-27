import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  toPoisha,
  fromTaka,
  poishaToTaka,
  addPoisha,
  subtractPoisha,
  validateQuantity,
  validateCapacityGrams,
  POISHA_PER_TAKA,
} from '../../src/kernel/money.js';
import { ValidationError } from '../../src/errors.js';

test('money: toPoisha validates whole safe integers and rejects invalid input', () => {
  assert.equal(toPoisha(0), 0);
  assert.equal(toPoisha(100), 100);
  assert.equal(toPoisha('250'), 250);
  assert.equal(toPoisha(' 250 '), 250);
  assert.equal(toPoisha(BigInt('250')), 250);

  assert.throws(() => toPoisha(-1), ValidationError); // negative rejected by default
  assert.equal(toPoisha(-1, { allowNegative: true }), -1);
  assert.throws(() => toPoisha(1.5), ValidationError); // non-integer
  assert.throws(() => toPoisha(Number.MAX_SAFE_INTEGER + 1), ValidationError); // unsafe
  assert.throws(() => toPoisha(NaN), ValidationError);
  assert.throws(() => toPoisha(Infinity), ValidationError);
  assert.throws(() => toPoisha('abc'), ValidationError);
  assert.throws(() => toPoisha('1.5'), ValidationError);
  assert.throws(() => toPoisha(''), ValidationError);
  assert.throws(() => toPoisha(null), ValidationError);
  assert.throws(() => toPoisha(undefined), ValidationError);
  assert.throws(() => toPoisha([1]), ValidationError); // no array coercion
  assert.throws(() => toPoisha({}), ValidationError);
});

test('money: fromTaka converts decimal taka to integer poisha with explicit precision', () => {
  assert.equal(fromTaka(0), 0);
  assert.equal(fromTaka(12.5), 1250);
  assert.equal(fromTaka(12.5, {}), 1250);
  assert.equal(fromTaka('1.23'), 123);
  assert.equal(fromTaka('1.2'), 120);
  assert.equal(fromTaka('1'), 100);
  assert.equal(POISHA_PER_TAKA, 100);

  // More than two decimal places rejected by default.
  assert.throws(() => fromTaka(1.234), ValidationError);
  assert.throws(() => fromTaka('1.234'), ValidationError);
  // Explicit rounding modes.
  assert.equal(fromTaka(1.234, { rounding: 'round' }), 123);
  assert.equal(fromTaka(1.236, { rounding: 'round' }), 124);
  assert.equal(fromTaka(1.239, { rounding: 'floor' }), 123);
  assert.equal(fromTaka(1.231, { rounding: 'ceil' }), 124);
  assert.throws(() => fromTaka('x'), ValidationError);
  assert.throws(() => fromTaka(Infinity), ValidationError);
  assert.throws(() => fromTaka([1.5]), ValidationError); // no array coercion
  assert.throws(() => fromTaka('1.234', { rounding: 'bogus' }), ValidationError);
});

test('money: fromTaka uses exact decimal/BigInt arithmetic (no float * 100), preserving modes', () => {
  // Cases that break with `Number * 100`, as both string and number inputs.
  for (const input of ['1.005', '1.015']) {
    assert.throws(() => fromTaka(input), ValidationError, `${input} reject default`);
  }
  assert.equal(fromTaka('1.005', { rounding: 'round' }), 101); // half away from zero, not 100
  assert.equal(fromTaka(1.005, { rounding: 'round' }), 101);
  assert.equal(fromTaka('1.015', { rounding: 'round' }), 102); // not 101
  assert.equal(fromTaka(1.015, { rounding: 'round' }), 102);
  assert.equal(fromTaka('10.999', { rounding: 'round' }), 1100);
  assert.equal(fromTaka(10.999, { rounding: 'round' }), 1100);
  assert.throws(() => fromTaka('10.999'), ValidationError); // reject default

  // `round` = half away from zero.
  assert.equal(fromTaka('1.235', { rounding: 'round' }), 124);
  assert.equal(fromTaka('1.2349', { rounding: 'round' }), 123);
  assert.equal(fromTaka('1.2350', { rounding: 'round' }), 124);
  assert.equal(fromTaka('1.2351', { rounding: 'round' }), 124);

  // `floor` = toward -Infinity; `ceil` = toward +Infinity.
  assert.equal(fromTaka('1.231', { rounding: 'floor' }), 123);
  assert.equal(fromTaka('1.239', { rounding: 'floor' }), 123);
  assert.equal(fromTaka('1.231', { rounding: 'ceil' }), 124);
  assert.equal(fromTaka('1.239', { rounding: 'ceil' }), 124);
  assert.equal(fromTaka('1.230', { rounding: 'floor' }), 123); // trailing zero, no effect
  assert.equal(fromTaka('1.230', { rounding: 'ceil' }), 123);

  // `reject` rejects any digit past two decimals, even trailing zeros.
  assert.throws(() => fromTaka('1.230'), ValidationError);
  assert.equal(fromTaka('1.230', { rounding: 'round' }), 123);
  assert.throws(() => fromTaka('1.234'), ValidationError);
});

test('money: fromTaka handles negatives (when allowed) with correct rounding', () => {
  // Negative output requires allowNegative.
  assert.throws(() => fromTaka('-1.23'), ValidationError);
  assert.equal(fromTaka('-1.23', { allowNegative: true }), -123);

  // round = half away from zero (symmetric with positives).
  assert.equal(fromTaka('-1.005', { rounding: 'round', allowNegative: true }), -101);
  assert.equal(fromTaka(-1.005, { rounding: 'round', allowNegative: true }), -101);
  assert.equal(fromTaka('-1.015', { rounding: 'round', allowNegative: true }), -102);
  assert.equal(fromTaka('-10.999', { rounding: 'round', allowNegative: true }), -1100);
  assert.equal(fromTaka('-1.234', { rounding: 'round', allowNegative: true }), -123);
  assert.equal(fromTaka('-1.236', { rounding: 'round', allowNegative: true }), -124);

  // floor toward -Infinity, ceil toward +Infinity.
  assert.equal(fromTaka('-1.231', { rounding: 'floor', allowNegative: true }), -124);
  assert.equal(fromTaka('-1.239', { rounding: 'floor', allowNegative: true }), -124);
  assert.equal(fromTaka('-1.231', { rounding: 'ceil', allowNegative: true }), -123);
  assert.equal(fromTaka('-1.239', { rounding: 'ceil', allowNegative: true }), -123);
  assert.equal(fromTaka('-1.23', { rounding: 'floor', allowNegative: true }), -123);
  assert.equal(fromTaka('-1.23', { rounding: 'ceil', allowNegative: true }), -123);
  assert.equal(fromTaka('-0.001', { rounding: 'floor', allowNegative: true }), -1);
  assert.equal(fromTaka('-0.001', { rounding: 'ceil', allowNegative: true }), 0);

  // reject default still applies for negatives.
  assert.throws(() => fromTaka('-1.234', { allowNegative: true }), ValidationError);
  assert.equal(fromTaka('-1.234', { rounding: 'round', allowNegative: true }), -123);
});

test('money: fromTaka is exact near the safe-integer poisha limit', () => {
  const MAX_SAFE_TAKA = '90071992547409.91'; // -> 9007199254740991 poisha == MAX_SAFE_INTEGER
  assert.equal(fromTaka(MAX_SAFE_TAKA), Number.MAX_SAFE_INTEGER);
  assert.equal(fromTaka('90071992547409.91', { allowNegative: true }), Number.MAX_SAFE_INTEGER);
  assert.equal(fromTaka('-90071992547409.91', { allowNegative: true }), -Number.MAX_SAFE_INTEGER);

  // One poisha past the limit must throw, not silently lose precision.
  assert.throws(() => fromTaka('90071992547409.92'), ValidationError);
  assert.throws(() => fromTaka('-90071992547409.92', { allowNegative: true }), ValidationError);
  // Rounding that would push past the limit is rejected too.
  assert.throws(() => fromTaka('90071992547409.915', { rounding: 'round' }), ValidationError);
  // Exponent / non-plain-decimal forms are rejected.
  assert.throws(() => fromTaka('1e-7', { rounding: 'round' }), ValidationError);
  assert.throws(() => fromTaka('1e3'), ValidationError);
});

test('money: poishaToTaka formats exactly two decimals, language-neutral', () => {
  assert.equal(poishaToTaka(0), '0.00');
  assert.equal(poishaToTaka(1250), '12.50');
  assert.equal(poishaToTaka(123), '1.23');
  assert.equal(poishaToTaka(1), '0.01');
  assert.equal(poishaToTaka(-123), '-1.23');
  assert.equal(poishaToTaka('100'), '1.00');
});

test('money: addPoisha/subtractPoisha validate safe integers and bounds', () => {
  assert.equal(addPoisha(), 0);
  assert.equal(addPoisha(1, 2, 3), 6);
  assert.equal(addPoisha('10', 5, BigInt(5)), 20);
  assert.equal(addPoisha(100, -50), 50); // internal negative allowed for composition
  assert.equal(subtractPoisha(100, 30), 70);
  assert.equal(subtractPoisha(10, 50), -40);
  assert.throws(() => addPoisha(Number.MAX_SAFE_INTEGER, 1), ValidationError); // overflow
  assert.throws(() => addPoisha(1, NaN), ValidationError);
  assert.throws(() => subtractPoisha('x', 1), ValidationError);
});

test('money: quantity and capacity require whole safe integers', () => {
  assert.equal(validateQuantity(0), 0);
  assert.equal(validateQuantity(5), 5);
  assert.equal(validateQuantity(3, { min: 1 }), 3);
  assert.throws(() => validateQuantity(1.5), ValidationError);
  assert.throws(() => validateQuantity(-1), ValidationError);
  assert.throws(() => validateQuantity(0, { min: 1 }), ValidationError);
  assert.throws(() => validateQuantity(11, { max: 10 }), ValidationError);
  assert.throws(() => validateQuantity('x'), ValidationError);

  assert.equal(validateCapacityGrams(12000), 12000);
  assert.equal(validateCapacityGrams(0), 0);
  assert.throws(() => validateCapacityGrams(0.5), ValidationError);
  assert.throws(() => validateCapacityGrams(-1), ValidationError);
});
