import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  requireObjectId,
  requireNonEmptyString,
  requireRole,
  requireStatus,
  ROLES,
  BUSINESS_STATUSES,
} from '../../src/kernel/validation.js';
import { ValidationError } from '../../src/errors.js';

const VALID_OID = '507f1f77bcf86cd799439011';

test('validation: requireObjectId accepts valid ObjectIds and rejects the rest', () => {
  assert.equal(requireObjectId(VALID_OID, 'id').toString(), VALID_OID);
  assert.throws(() => requireObjectId('not-an-id', 'id'), ValidationError);
  assert.throws(() => requireObjectId('', 'id'), ValidationError);
  assert.throws(() => requireObjectId(null, 'id'), ValidationError);
  assert.throws(() => requireObjectId(undefined, 'id'), ValidationError);
  assert.throws(() => requireObjectId(123, 'id'), ValidationError);
});

test('validation: requireNonEmptyString trims and enforces length', () => {
  assert.equal(requireNonEmptyString('  hello ', 'field'), 'hello');
  assert.throws(() => requireNonEmptyString('', 'field'), ValidationError);
  assert.throws(() => requireNonEmptyString('   ', 'field'), ValidationError);
  assert.throws(() => requireNonEmptyString(null, 'field'), ValidationError);
  assert.throws(() => requireNonEmptyString(5, 'field'), ValidationError);
  assert.throws(() => requireNonEmptyString('x'.repeat(1001), 'field'), ValidationError);
  assert.equal(requireNonEmptyString('x'.repeat(1000), 'field'), 'x'.repeat(1000));
});

test('validation: requireRole and requireStatus validate closed sets', () => {
  assert.deepEqual([...ROLES], ['owner', 'admin', 'staff']);
  assert.deepEqual([...BUSINESS_STATUSES], ['active', 'suspended']);
  assert.equal(requireRole('owner'), 'owner');
  assert.throws(() => requireRole('super_admin'), ValidationError);
  assert.throws(() => requireRole('superuser'), ValidationError);
  assert.throws(() => requireRole(null), ValidationError);
  assert.equal(requireStatus('active'), 'active');
  assert.throws(() => requireStatus('inactive'), ValidationError);
  assert.equal(requireStatus('suspended', 'member'), 'suspended');
});
