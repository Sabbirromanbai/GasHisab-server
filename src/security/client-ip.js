const MAX_IP_LENGTH = 64;

/**
 * Resolve the IP address Better Auth uses for rate limiting.
 *
 * `trust proxy` (TRUST_PROXY_HOPS) is configured on the Express app, so
 * `req.ip` already accounts for the trusted proxy chain. A client-supplied
 * `x-gashisab-client-ip` header must never be trusted at runtime: rotating it
 * would reset the sign-in rate limiter per request.
 *
 * Only the `test` environment may override it, because the integration suites
 * need deterministic rate-limit buckets. `createAuthConfig` only permits the
 * `test` environment against the guarded `gashisab_test` database.
 */
export const resolveClientIp = (req, config) => {
  const override = req.headers?.['x-gashisab-client-ip'];
  if (config?.environment === 'test' && typeof override === 'string' && override.trim()) {
    return override.trim().slice(0, MAX_IP_LENGTH);
  }

  const derived = req.ip || req.socket?.remoteAddress || '';
  return typeof derived === 'string' ? derived.slice(0, MAX_IP_LENGTH) : '';
};
