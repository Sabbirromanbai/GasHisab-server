export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Only `same-origin` is safe when Origin and Referer are both unavailable.
//
// `same-site` must NOT be accepted: it includes hostile sibling subdomains
// (e.g. evil.example.com -> api.example.com). Cookies are sent based on the
// destination host, so a sibling can still ride a SameSite=Lax/None session.
//
// `none` describes a user-initiated top-level navigation (address bar,
// bookmark). Unsafe API calls never legitimately originate that way, so it is
// rejected for mutating requests.
const SAFE_FETCH_SITES = new Set(['same-origin']);

// Better Auth cookie names: `better-auth.session_token` (and `session_data`),
// `__Secure-` prefixed in production, optionally chunked as `...session_token.0`.
const BETTER_AUTH_SESSION_COOKIE =
  /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth[.-]session_(?:token|data)(?:\.\d+)?=/i;

const originFrom = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

export const hasBetterAuthSessionCookie = (req) => {
  const cookie = req.headers?.cookie;
  return typeof cookie === 'string' && BETTER_AUTH_SESSION_COOKIE.test(cookie);
};

/**
 * Decide whether an unsafe (mutating) request may proceed past the CSRF barrier.
 *
 * Every modern browser sends an Origin header on writes, so an allow-listed
 * Origin is the primary signal. When Origin is missing we fall back to Referer
 * and then to Fetch Metadata. A browser request that stripped Origin cannot
 * downgrade to `same-site`/`none` and slip through.
 *
 * When none of those headers are present we must distinguish a non-browser
 * client from a browser that stripped every provenance header. A request that
 * carries a Better Auth session cookie is treated as browser-originated and
 * fails closed; a cookie-less request has no ambient credentials and therefore
 * no CSRF exposure, so legitimate server-to-server/CLI flows keep working.
 */
export const isAllowedUnsafeRequest = (req, allowedOrigins) => {
  if (SAFE_METHODS.has(req.method)) return true;

  const origin = req.get?.('origin');
  if (origin) return allowedOrigins.includes(origin);

  const referer = req.get?.('referer');
  if (referer) {
    const refererOrigin = originFrom(referer);
    if (refererOrigin === null || !allowedOrigins.includes(refererOrigin)) return false;
    // Fetch Metadata, when present, must agree with the Referer. This blocks a
    // cross-site redirect that leaves an allow-listed Referer behind.
    const fetchSite = req.get?.('sec-fetch-site');
    return !fetchSite || SAFE_FETCH_SITES.has(fetchSite.toLowerCase());
  }

  const fetchSite = req.get?.('sec-fetch-site');
  if (fetchSite) return SAFE_FETCH_SITES.has(fetchSite.toLowerCase());

  return !hasBetterAuthSessionCookie(req);
};
