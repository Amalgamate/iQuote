# iQuote Security Audit

**Audit date:** 18 November 2026  
**Method:** static source/config review, TypeScript checks, lint, and npm advisory checks. No destructive tests, production changes, secret reads, live DB access, or customer-data access were performed.

## Executive assessment

The app has useful baseline controls: bcrypt password hashes, signed/expiring JWTs checked against revocable database sessions, HttpOnly/SameSite cookies, server-side tenant scoping on most workspace routes, random public quote tokens, OTP HMAC storage/expiry/attempt cap, server-side quote validation, tenant email-key encryption, and basic security headers in the internal Nginx config.

The security baseline is not ready for broad public SaaS use. The highest-priority issues are permissive credentialed CORS without a CSRF token, same-origin serving of unsanitized user SVG files, and a known default JWT signing secret if the runtime omits configuration. Production configuration currently requires a JWT secret in Compose/deploy scripts, but the API itself fails open to the development value. Rate limiting is incomplete and process-local. Automated tenant/security tests are absent.

## Findings

### HIGH — Credentialed CORS reflects arbitrary Origin; cookie mutations lack CSRF protection

**Evidence:** `api/src/index.ts:75-80` configures `cors({ origin: true, credentials: true })`. Session cookies use `SameSite=Lax` (`api/src/index.ts:100-105`), and state-changing routes authenticate that cookie without a CSRF token or Origin/Referer allowlist.

**Impact:** the server reflects the requesting origin and allows credentialed CORS responses. `SameSite=Lax` limits many cross-site cases but does not isolate sibling subdomains that are same-site; this matters in a wildcard `*.trendscore.co.ke` deployment. A hostile or compromised sibling origin could attempt authenticated actions and, depending on browser request context, read responses. Current code has no explicit allowlist or anti-CSRF proof.

**Recommendation:** define exact trusted origins from environment/config; add CSRF tokens or robust Origin/Referer validation for cookie-authenticated writes; keep cross-origin access only where explicitly required; add integration tests for cross-origin requests from both unrelated and sibling origins.

### HIGH — User-uploaded SVG is served unsanitized from the app origin

**Evidence:** SVG is an accepted image type (`api/src/index.ts:1321-1323`); `detectImageType` accepts text containing `<svg` within the first kilobyte (`api/src/index.ts:1333-1340`); bytes are written unchanged under `/uploads` (`api/src/index.ts:1382-1397`); `/uploads` is served as static content from the API origin (`api/src/index.ts:84-86`).

**Impact:** a tenant can upload SVG markup containing active content. Browsers generally suppress script execution when SVG is embedded as an `<img>`, but the uploaded file is also directly navigable under the same origin. A victim who opens a crafted logo URL can execute stored same-origin script. The logo URL is used on public quote pages, increasing distribution opportunities.

**Recommendation:** safest initial policy is to reject SVG and accept raster formats only. If SVG support is required, sanitize using a maintained allowlist sanitizer and/or rasterize it server-side, and serve user media from an isolated origin with restrictive content headers.

### MEDIUM — API falls back to a public, known JWT secret

**Evidence:** `api/src/index.ts:53-55` sets `jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me'`. Compose production and deployment templates require `JWT_SECRET`, which reduces but does not eliminate the risk for alternate runtime configurations.

**Impact:** if a production process starts without the variable, an attacker who knows the repository default can forge JWTs. Sessions also require a matching row, but the attacker can potentially use a leaked/guessed database session or create a forged JWT matching an existing user's `sub` if the opaque token/session implementation is not changed.

**Recommendation:** fail process startup outside explicit local-development mode if the secret is missing, placeholder, or below an entropy/length requirement. Remove the known fallback from production-capable execution.

### MEDIUM — Session bearer JWTs are stored in plaintext in the database

**Evidence:** `issueSession` signs the JWT and writes the complete token to `Session.token` (`api/src/index.ts:117-125`); the schema declares that field unique plaintext (`api/prisma/schema.prisma:133-140`).

**Impact:** a read-only database compromise exposes live replayable bearer tokens until expiry/revocation. The database session check is revocable, which is a useful control, but raw token storage makes a database read more powerful than necessary.

**Recommendation:** use random opaque session secrets and store only a cryptographic hash, or store a hash of the JWT token and verify by hash while retaining user/expiry/revocation metadata.

### MEDIUM — Rate limits are incomplete and do not scale across API replicas

**Evidence:** login attempts are kept in a process-local `Map` (`api/src/index.ts:19-52`, `641-673`). OTP resend throttling is a 30-second check by email (`api/src/index.ts:489-499`); OTP attempts are capped at five for one email record (`api/src/index.ts:628-638`). Public quote GET/decision routes have no rate limiter (`1068-1168`).

**Impact:** login limits reset on restart and are not shared by multiple instances; an attacker can distribute OTP requests across addresses/IPs or abuse public endpoints. OTP has useful per-email controls but no shared IP/global budget or abuse monitoring.

**Recommendation:** use a shared rate-limit store such as Redis; add per-IP, per-account, and global budgets for auth and public-decision endpoints; add abuse metrics and retry-after behavior. Do not lock legitimate users indefinitely based only on an attacker-controlled IP.

### MEDIUM — Tenant relationship consistency is enforced in handlers, not by database constraints or tests

**Evidence:** `Quote` stores `organisationId`, `customerId`, and `ownerId` as independent foreign keys (`schema.prisma:168-195`). The API checks customer organisation when creating/editing quotes (`api/src/index.ts:945-950`, `1008-1013`), but no composite FK/RLS exists. No automated test suite is present.

**Impact:** a future route, import, script, or direct DB write can create a quote referencing a different tenant's customer while satisfying ordinary foreign keys. Broad tenant leakage is not demonstrated in current inspected routes, but defense-in-depth is absent.

**Recommendation:** add composite tenant-consistency constraints and cross-tenant negative tests for every tenant-owned route. Keep super-admin access explicitly separated and audited.

### MEDIUM — Super-admin privilege use is not audited or protected by stronger authentication

**Evidence:** `requireSuperadmin` checks only the role (`api/src/index.ts:329-345`). The promote endpoint can promote an arbitrary existing account for any current super-admin (`api/src/index.ts:1541-1549`). There is no audit-event model, MFA, approval workflow, or admin action log in the schema.

**Impact:** compromise of a super-admin session allows platform-wide data viewing and promotion of additional global administrators, with little evidence for incident review.

**Recommendation:** add MFA for platform administrators, immutable audit events for reads/changes with elevated impact, and a controlled bootstrap/recovery mechanism. Require reason/confirmation for high-impact actions.

### LOW — Public email-template preview is enabled without an environment guard

**Evidence:** `GET /api/email-preview/:template` is public and returns test templates/data (`api/src/index.ts:370-413`). Internal Nginx comments call it development-only, but the API route itself does not check `NODE_ENV`.

**Impact:** current response uses static sample information and does not reveal credentials; it increases public surface and could expose future template content or unsafe interpolation if changed.

**Recommendation:** disable it in production or put it behind administrator authentication and development-only configuration.

### LOW — Security headers are incomplete at the application proxy

**Evidence:** the web Dockerfile's Nginx config sets `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` but no Content-Security-Policy or HSTS (`web/Dockerfile`). The source deployment Nginx config listens on HTTP; Certbot is expected to alter/extend the host config.

**Impact:** there is no repository-level CSP baseline, and the checked-in proxy does not prove that HTTPS/HSTS is active at the public edge.

**Recommendation:** set a tested CSP and HSTS at the actual TLS terminator after validating all app assets/integrations. Confirm redirect and TLS configuration on the live host.

## Positive controls observed

- Passwords are stored as bcrypt hashes with work factor 10 (`api/src/index.ts:440`). Password length minimum is 8 characters at signup (`415-428`).
- JWT expiry is 7 days and every protected route checks a live Session row (`117-125`, `298-327`); logout deletes that row.
- Cookie is HttpOnly, SameSite=Lax, and `Secure` in production (`100-115`).
- OTP codes are generated with `randomInt`, HMACed with the JWT secret, expire after 10 minutes, are capped at five attempts, and resend is throttled for 30 seconds (`489-525`, `628-638`).
- Public quote tokens use 24 random bytes in base64url form (`api/src/index.ts:1060-1064`). Decision writes only apply while status is SENT/VIEWED and not expired (`1111-1129`).
- Tenant API routes generally derive organisation identity from the session rather than request body IDs.
- Email credentials are stored encrypted with AES-256-GCM, random IV, and authentication tag; a separate environment key is required (`api/src/index.ts:56-73`).
- Uploaded image content is checked beyond declared MIME for common raster formats; there is a 5 MB ceiling (`1321-1353`). The SVG exception is the finding above.
- Production error handling hides stack/internal messages (`api/src/index.ts:1557-1573`).
- Npm advisory audit reported zero known vulnerabilities for both packages, including development dependencies, on 18 November 2026. This is point-in-time advisory output, not a guarantee against future issues.

## Security checks and limitations

- API TypeScript no-emit check: passed.
- Web TypeScript no-emit checks: passed.
- Web lint: zero errors, nine warnings.
- `npm audit` for `api` and `web`: 0 vulnerabilities each at audit time.
- No test/spec files or test scripts were found. No dynamic penetration tests were performed.
- No real environment files, secret values, customer rows, or production database were inspected.
- Live hostname DNS lookup failed from this environment; current production headers, TLS, build SHA, and runtime configuration are unverified.
