import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeIdempotencyKey,
  generateRequestHash,
  stableStringify,
  assertIdempotentMatch,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from '../../src/kernel/idempotency.js';
import { ValidationError, ConflictError } from '../../src/errors.js';

test('idempotency: normalizeIdempotencyKey trims and validates', () => {
  assert.equal(normalizeIdempotencyKey('  abc  '), 'abc');
  assert.throws(() => normalizeIdempotencyKey(''), ValidationError);
  assert.throws(() => normalizeIdempotencyKey('   '), ValidationError);
  assert.throws(() => normalizeIdempotencyKey(null), ValidationError);
  assert.throws(() => normalizeIdempotencyKey(undefined), ValidationError);
  assert.throws(() => normalizeIdempotencyKey(123), ValidationError);
  assert.equal(normalizeIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH)), 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH));
  assert.throws(() => normalizeIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)), ValidationError);
});

test('idempotency: stableStringify is order-independent and handles Date/ObjectId-like values', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ a: { x: 1, y: 2 }, b: 3 }), stableStringify({ b: 3, a: { y: 2, x: 1 } }));
  assert.equal(stableStringify({ a: [1, 2, 3] }), '{"a":[1,2,3]}');
  // undefined keys dropped like JSON.stringify.
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
  // Date -> ISO.
  const d = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(stableStringify({ when: d }), `{"when":"${d.toISOString()}"}`);
  // ObjectId-like with toJSON.
  const oid = { toJSON: () => '507f1f77bcf86cd799439011', extra: 'ignored' };
  assert.equal(stableStringify({ id: oid }), '{"id":"507f1f77bcf86cd799439011"}');
});

test('idempotency: generateRequestHash is deterministic and key-order independent', () => {
  const h1 = generateRequestHash({ amount: 100, key: 'x' });
  const h2 = generateRequestHash({ key: 'x', amount: 100 });
  assert.equal(h1, h2);
  assert.notEqual(h1, generateRequestHash({ amount: 101, key: 'x' }));
  assert.match(h1, /^[a-f0-9]{64}$/); // sha256 hex
  // Nested key order also irrelevant.
  assert.equal(
    generateRequestHash({ a: { b: 1, c: 2 }, d: 3 }),
    generateRequestHash({ d: 3, a: { c: 2, b: 1 } }),
  );
});

test('idempotency: assertIdempotentMatch — same key+payload ok, same key+different payload conflict', () => {
  const h = generateRequestHash({ x: 1 });
  assert.equal(assertIdempotentMatch(null, h), null);
  assert.equal(assertIdempotentMatch({ requestHash: h }, h).requestHash, h);
  assert.throws(() => assertIdempotentMatch({ requestHash: 'other' }, h), ConflictError);
  try {
    assertIdempotentMatch({ requestHash: 'other' }, h);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.code, 'IDEMPOTENCY_CONFLICT');
  }
});
