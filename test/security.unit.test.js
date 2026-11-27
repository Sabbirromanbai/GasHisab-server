import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, ForbiddenError, ValidationError, toHttpError } from '../src/errors.js';
import { resolveClientIp } from '../src/security/client-ip.js';
import { isAllowedUnsafeRequest } from '../src/security/request-origin.js';

const makeRequest = ({ method = 'POST', headers = {}, ip = '203.0.113.9', remoteAddress = '198.51.100.7' } = {}) => ({
  method,
  headers,
  ip,
  socket: { remoteAddress },
  get(name) {
    return this.headers[name.toLowerCase()];
  },
});

test('toHttpError preserves the error field and adds a stable code', () => {
  const conflict = toHttpError(new ConflictError('A business must keep at least one active owner.', 'LAST_OWNER'));
  assert.deepEqual(conflict, {
    status: 409,
    body: { error: 'A business must keep at least one active owner.', code: 'LAST_OWNER' },
  });

  const forbidden = toHttpError(new ForbiddenError());
  assert.deepEqual(forbidden, { status: 403, body: { error: 'Forbidden.', code: 'FORBIDDEN' } });

  const validation = toHttpError(new ValidationError('Bad input.'));
  assert.deepEqual(validation, { status: 400, body: { error: 'Bad input.', code: 'VALIDATION_ERROR' } });
});

test('toHttpError maps Mongoose validation and cast errors to 400', () => {
  const mongooseValidation = toHttpError({
    name: 'ValidationError',
    errors: { name: { message: 'Path `name` is longer than the maximum allowed length.' } },
  });
  assert.deepEqual(mongooseValidation, {
    status: 400,
    body: { error: 'Path `name` is longer than the maximum allowed length.', code: 'VALIDATION_ERROR' },
  });

  const cast = toHttpError({ name: 'CastError' });
  assert.deepEqual(cast, { status: 400, body: { error: 'Invalid request.', code: 'VALIDATION_ERROR' } });
});

test('toHttpError maps duplicate keys to 409 with a slug-specific message', () => {
  const slug = toHttpError({ code: 11000, keyPattern: { slug: 1 } });
  assert.deepEqual(slug, {
    status: 409,
    body: { error: 'A business with this slug already exists.', code: 'CONFLICT' },
  });

  const other = toHttpError({ code: 11000, keyPattern: { email: 1 } });
  assert.deepEqual(other, {
    status: 409,
    body: { error: 'A record with these values already exists.', code: 'CONFLICT' },
  });
});

test('toHttpError keeps the legacy shape for transport-level 4xx and hides unknown failures', () => {
  assert.deepEqual(toHttpError({ status: 400, type: 'entity.parse.failed' }), {
    status: 400,
    body: { error: 'Invalid request.' },
  });
  assert.deepEqual(toHttpError({ statusCode: 413 }), {
    status: 413,
    body: { error: 'Invalid request.' },
  });
  assert.deepEqual(toHttpError(new Error('secret internals')), {
    status: 500,
    body: { error: 'Internal server error.', code: 'INTERNAL_ERROR' },
  });
});

test('resolveClientIp never trusts a client-supplied header outside tests', () => {
  const spoofed = { 'x-gashisab-client-ip': '1.2.3.4' };

  assert.equal(
    resolveClientIp(makeRequest({ headers: spoofed }), { environment: 'production' }),
    '203.0.113.9',
  );
  assert.equal(
    resolveClientIp(makeRequest({ headers: spoofed }), { environment: 'development' }),
    '203.0.113.9',
  );
});

test('resolveClientIp allows deterministic overrides only in the test environment', () => {
  const req = makeRequest({ headers: { 'x-gashisab-client-ip': '  10.9.8.7  ' } });
  assert.equal(resolveClientIp(req, { environment: 'test' }), '10.9.8.7');

  const blank = makeRequest({ headers: { 'x-gashisab-client-ip': '   ' } });
  assert.equal(resolveClientIp(blank, { environment: 'test' }), '203.0.113.9');

  const tooLong = makeRequest({ headers: { 'x-gashisab-client-ip': 'a'.repeat(120) } });
  assert.equal(resolveClientIp(tooLong, { environment: 'test' }).length, 64);
});

test('resolveClientIp falls back to the socket address when req.ip is unavailable', () => {
  const req = makeRequest({ headers: {}, ip: '' });
  assert.equal(resolveClientIp(req, { environment: 'production' }), '198.51.100.7');
});

test('isAllowedUnsafeRequest lets safe methods through and validates Origin', () => {
  const allowed = ['https://app.example.test'];
  assert.equal(isAllowedUnsafeRequest(makeRequest({ method: 'GET' }), allowed), true);
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { origin: 'https://app.example.test' } }), allowed),
    true,
  );
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { origin: 'https://attacker.example.test' } }), allowed),
    false,
  );
});

test('isAllowedUnsafeRequest uses Referer and Fetch Metadata when Origin is missing', () => {
  const allowed = ['https://app.example.test'];

  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { referer: 'https://app.example.test/sales' } }), allowed),
    true,
  );
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { referer: 'https://attacker.example.test/sales' } }), allowed),
    false,
  );
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { referer: 'not a url' } }), allowed),
    false,
  );

  // A cross-site redirect must not leave an allow-listed Referer acceptable
  // when Fetch Metadata says the request is cross-site.
  assert.equal(
    isAllowedUnsafeRequest(
      makeRequest({ headers: { referer: 'https://app.example.test/sales', 'sec-fetch-site': 'cross-site' } }),
      allowed,
    ),
    false,
  );
  assert.equal(
    isAllowedUnsafeRequest(
      makeRequest({ headers: { referer: 'https://app.example.test/sales', 'sec-fetch-site': 'same-origin' } }),
      allowed,
    ),
    true,
  );
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), allowed),
    false,
  );
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), allowed),
    true,
  );

  // Sibling subdomains report `same-site`; they must not pass the fallback.
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { 'sec-fetch-site': 'same-site' } }), allowed),
    false,
  );
  // `none` is a user-initiated navigation, never a legitimate unsafe API call.
  assert.equal(
    isAllowedUnsafeRequest(makeRequest({ headers: { 'sec-fetch-site': 'none' } }), allowed),
    false,
  );
});

test('isAllowedUnsafeRequest fails closed for headerless requests carrying a session cookie', () => {
  const allowed = ['https://app.example.test'];
  const withCookie = (cookie) => makeRequest({ headers: { cookie } });

  assert.equal(isAllowedUnsafeRequest(withCookie('better-auth.session_token=abc'), allowed), false);
  assert.equal(isAllowedUnsafeRequest(withCookie('__Secure-better-auth.session_token=abc'), allowed), false);
  assert.equal(isAllowedUnsafeRequest(withCookie('better-auth.session_token.0=abc'), allowed), false);
  assert.equal(isAllowedUnsafeRequest(withCookie('better-auth-session_token=abc'), allowed), false);
  assert.equal(isAllowedUnsafeRequest(withCookie('theme=dark; better-auth.session_data=abc'), allowed), false);

  // Unrelated cookies do not imply an ambient session.
  assert.equal(isAllowedUnsafeRequest(withCookie('theme=dark; locale=bn'), allowed), true);

  // Completely headerless, cookie-less clients (CLI/server-to-server) stay allowed.
  assert.equal(isAllowedUnsafeRequest(makeRequest({ headers: {} }), allowed), true);
});

test('an allow-listed Origin is authoritative even with hostile Fetch Metadata', () => {
  const allowed = ['https://app.example.test'];
  const req = makeRequest({
    headers: { origin: 'https://app.example.test', 'sec-fetch-site': 'same-site' },
  });
  assert.equal(isAllowedUnsafeRequest(req, allowed), true);
});
