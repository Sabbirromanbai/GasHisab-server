import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getTenantBusinessId,
  tenantFilter,
  assertTenantOwnership,
  stripUntrustedBusinessId,
  injectBusinessId,
} from '../../src/kernel/tenant-repo.js';
import { AuthenticationError, ForbiddenError, NotFoundError } from '../../src/errors.js';

const req = { auth: { userId: 'u1', businessId: 'b1', role: 'owner' } };
const OID = '507f1f77bcf86cd799439011';

test('tenant-repo: businessId comes only from verified req.auth', () => {
  assert.equal(getTenantBusinessId(req), 'b1');
  assert.deepEqual(tenantFilter(req), { businessId: 'b1' });

  // Unauthenticated.
  assert.throws(() => getTenantBusinessId({}), AuthenticationError);
  assert.throws(() => getTenantBusinessId({ auth: { businessId: 'b1' } }), AuthenticationError);
  // No tenant.
  assert.throws(() => getTenantBusinessId({ auth: { userId: 'u1' } }), ForbiddenError);
  assert.throws(() => getTenantBusinessId({ auth: { userId: 'u1', businessId: '' } }), ForbiddenError);
});

test('tenant-repo: client-supplied businessId is stripped and replaced', () => {
  assert.deepEqual(stripUntrustedBusinessId({ businessId: 'evil', name: 'x' }), { name: 'x' });
  assert.deepEqual(stripUntrustedBusinessId({ name: 'x' }), { name: 'x' });
  assert.deepEqual(stripUntrustedBusinessId(null), {});

  const injected = injectBusinessId({ businessId: 'evil', name: 'x', foo: 1 }, req);
  assert.deepEqual(injected, { name: 'x', foo: 1, businessId: 'b1' });
});

test('tenant-repo: cross-tenant records are indistinguishable from not-found', () => {
  assertTenantOwnership(req, { businessId: 'b1', _id: OID }); // ok
  assert.throws(() => assertTenantOwnership(req, { businessId: 'other', _id: OID }), NotFoundError);
  assert.throws(() => assertTenantOwnership(req, { _id: OID }), NotFoundError); // missing businessId
  assert.throws(() => assertTenantOwnership(req, null), NotFoundError);
  // Not Forbidden — must not reveal existence in another tenant.
  try {
    assertTenantOwnership(req, { businessId: 'other' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof NotFoundError);
    assert.ok(!(e instanceof ForbiddenError));
  }
});
