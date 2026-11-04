/**
 * Sign-in, sessions, and account recovery. Rules are in docs/architecture/security.md. Responses are
 * identical whether or not an account exists, which is why reset emails are built in a background job.
 */
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  isUsableHash,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  signAccessToken,
  verifyAccessToken,
  verifyAgainstDummy,
  verifyPassword,
  ACCESS_TOKEN_TTL_SECONDS,
  type SigningKey,
  type VerificationKeys,
} from '@openchat/auth';
import {
  confirmEmailVerification,
  confirmPasswordReset,
  createSession,
  deleteAccount,
  findActiveUserId,
  findUserForLogin,
  getUserContact,
  isAuthTokenUsable,
  issueAuthToken,
  listMemberships,
  loadPrincipal,
  revokeSession,
  rotateRefreshToken,
  upgradePasswordHash,
  type ClientType,
  type Database,
  type Principal,
} from '@openchat/database';
import type { EmailProvider } from '@openchat/email';
import { AppError, DEFAULT_ABUSE_LIMITS, newId, toIso, type AbuseLimits, type JobEnvelope } from '@openchat/shared';
import type { JobQueue } from './index';

export interface RateLimiter {
  /** Counts one attempt against `key`, and reports whether it is within the limit. */
  consume(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  reset(key: string): Promise<void>;
}

export interface AuthDeps {
  db: Database;
  installationId: string;
  signingKey: SigningKey;
  verificationKeys: VerificationKeys;
  limiter: RateLimiter;
  limits: AbuseLimits;
  emailJobs: JobQueue;
  /** Absent unless this installation was deployed with Turnstile keys. */
  turnstile?: TurnstileVerifier;
}

/** Throws if the answer could not be found out, which is not the same as a token being wrong. */
export interface TurnstileVerifier {
  siteKey: string;
  verify(token: string, ip: string): Promise<boolean>;
}

export const LIMITS = {
  loginAccount: { limit: 10, windowSeconds: 15 * 60 },
  loginIp: { limit: 50, windowSeconds: 15 * 60 },
  resetEmail: { limit: 3, windowSeconds: 60 * 60 },
  resetIp: { limit: 20, windowSeconds: 60 * 60 },
  confirmIp: { limit: 20, windowSeconds: 15 * 60 },
  invitationsPerWorkspace: { limit: 30, windowSeconds: 60 * 60 },
  visitorSessionIp: { limit: 30, windowSeconds: 60 * 60 },
  visitorSessionWebsite: { limit: 3000, windowSeconds: 60 * 60 },
  visitorMessage: { limit: 20, windowSeconds: 60 },
  websiteVisitorMessages: { limit: 600, windowSeconds: 60 },
  /** Everything a visitor can ask for. Well above a chat, and well below hurting a database with a ceiling of about 45 writes a second. */
  visitorRequests: { limit: 120, windowSeconds: 60 },
  /** The writes with no limit of their own. Added to the limit on messages, one website stays under that ceiling. */
  websiteVisitorWrites: { limit: 1200, windowSeconds: 60 },
  visitorUpload: { limit: 20, windowSeconds: 60 * 60 },
  websiteVisitorUploads: { limit: 500, windowSeconds: 60 * 60 },
} as const;

export const PASSWORD_RESET_JOB = 'auth.password_reset_email';
const RESET_TTL_MS = 60 * 60 * 1000;

const invalidCredentials = () => new AppError(401, 'invalid_credentials', 'The email or password is incorrect');
const unauthorized = () => new AppError(401, 'unauthorized', 'Sign in again');
export const invalidToken = () => new AppError(400, 'invalid_token', 'This link is invalid or has expired');

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Limiter keys are hashed, so that emails and IP addresses do not appear in Durable Object names.
export const limitKey = async (kind: string, value: string) => `${kind}:${await sha256Hex(value.toLowerCase())}`;

const ipv6Words = (part: string | undefined): string[] =>
  !part
    ? []
    : part.split(':').flatMap((word) => {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(word)) return [word];
        const [a, b, c, d] = word.split('.').map(Number) as [number, number, number, number];
        return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
      });

/**
 * What counts as one address for a limit. One connection usually holds a whole IPv6 /64, which is billions of
 * addresses, so a limit on the full address would limit nothing. Different spellings of an address must also
 * count as one. Anything that cannot be parsed is used as it stands, so it still counts against something.
 */
export function ipLimitValue(ip: string, ipv6Prefix: number = DEFAULT_ABUSE_LIMITS.ipv6Prefix): string {
  const address = ip.trim().toLowerCase().split('%')[0]!;
  if (!address.includes(':')) return address;
  const parts = address.split('::');
  if (parts.length > 2) return address;
  const head = ipv6Words(parts[0]);
  const tail = ipv6Words(parts[1]);
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? missing !== 0 : missing < 1) return address;
  const words = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return address;
  const numbers = words.map((word) => parseInt(word, 16));
  // An IPv4 address written as IPv6 is that IPv4 address.
  if (numbers.slice(0, 5).every((n) => n === 0) && numbers[5] === 0xffff) {
    return [numbers[6]! >> 8, numbers[6]! & 255, numbers[7]! >> 8, numbers[7]! & 255].join('.');
  }
  const kept = numbers.slice(0, Math.ceil(ipv6Prefix / 16)).map((n, i) => {
    const bits = Math.min(16, ipv6Prefix - i * 16);
    return (n & (0xffff << (16 - bits)) & 0xffff).toString(16);
  });
  return `${kept.join(':')}::/${ipv6Prefix}`;
}

/** Every limit on an address goes through this, so that none of them can miss the rule above. */
export const limitKeyForIp = (deps: Pick<AuthDeps, 'limits'>, kind: string, ip: string) => limitKey(kind, ipLimitValue(ip, deps.limits.ipv6Prefix));

export async function enforce(limiter: RateLimiter, key: string, rule: { limit: number; windowSeconds: number }): Promise<void> {
  const result = await limiter.consume(key, rule.limit, rule.windowSeconds);
  if (!result.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many attempts. Try again later', { retryAfterSeconds: result.retryAfterSeconds });
  }
}

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  clientType: ClientType;
}

async function issueAccess(deps: AuthDeps, userId: string, sessionId: string) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await signAccessToken(deps.signingKey, { userId, sessionId, installationId: deps.installationId }, now);
  return { accessToken, accessTokenExpiresAt: toIso((now + ACCESS_TOKEN_TTL_SECONDS) * 1000) };
}

export async function login(
  deps: AuthDeps,
  input: { email: string; password: string; clientType: ClientType; clientLabel: string | null; ip: string },
): Promise<IssuedTokens> {
  // The account key is hashed from the submitted email, so limits behave the same for unknown accounts.
  const accountKey = await limitKey('login-account', input.email);
  await enforce(deps.limiter, await limitKeyForIp(deps, 'login-ip', input.ip), LIMITS.loginIp);
  await enforce(deps.limiter, accountKey, LIMITS.loginAccount);

  const user = await findUserForLogin(deps.db, input.email);
  const verified = user && isUsableHash(user.passwordHash) ? await verifyPassword(input.password, user.passwordHash) : await verifyAgainstDummy(input.password);
  // A disabled account gets the same answer as a wrong password, after the same work.
  if (!user || !verified || user.disabledAt !== null) throw invalidCredentials();

  if (needsRehash(user.passwordHash)) {
    await upgradePasswordHash(deps.db, user.id, user.passwordHash, await hashPassword(input.password));
  }
  await deps.limiter.reset(accountKey);

  const refreshToken = generateOpaqueToken();
  const sessionId = await createSession(deps.db, {
    userId: user.id,
    refreshTokenHash: await hashOpaqueToken(refreshToken),
    clientType: input.clientType,
    clientLabel: input.clientLabel,
  });
  return { ...(await issueAccess(deps, user.id, sessionId)), refreshToken, clientType: input.clientType };
}

export async function refresh(deps: AuthDeps, presentedToken: string): Promise<IssuedTokens> {
  const refreshToken = generateOpaqueToken();
  const result = await rotateRefreshToken(deps.db, await hashOpaqueToken(presentedToken), await hashOpaqueToken(refreshToken));
  // Reuse and an unknown token look the same to the caller. The session is already revoked.
  if (result.outcome !== 'rotated') throw unauthorized();
  return { ...(await issueAccess(deps, result.userId, result.sessionId)), refreshToken, clientType: result.clientType };
}

export const logout = (deps: Pick<AuthDeps, 'db'>, sessionId: string): Promise<void> => revokeSession(deps.db, sessionId);

/** Signature first, then a read, so that a revoked session or disabled user stops working at once. */
export async function authenticate(deps: Pick<AuthDeps, 'db' | 'installationId' | 'verificationKeys'>, bearerToken: string): Promise<Principal> {
  const verified = await verifyAccessToken(bearerToken, deps.verificationKeys, deps.installationId);
  if (!verified.ok) throw unauthorized();
  const principal = await loadPrincipal(deps.db, verified.claims.sub, verified.claims.sid);
  if (!principal) throw unauthorized();
  return principal;
}

export async function getMe(deps: Pick<AuthDeps, 'db'>, principal: Principal) {
  const memberships = await listMemberships(deps.db, principal.userId);
  return {
    id: principal.userId,
    email: principal.email,
    name: principal.name,
    memberships: memberships.map((m) => ({
      memberId: m.memberId,
      role: m.role,
      workspace: { id: m.workspaceId, name: m.workspaceName, slug: m.workspaceSlug, createdAt: toIso(m.workspaceCreatedAt) },
    })),
  };
}

/**
 * The password is checked first because deleting cannot be undone, and an access token alone can be stolen.
 * Attempts use the login limits, so that the token gives no extra way to guess the password.
 */
export async function deleteMe(deps: Pick<AuthDeps, 'db' | 'limiter' | 'limits'>, principal: Principal, input: { password: string; ip: string }): Promise<void> {
  const accountKey = await limitKey('login-account', principal.email);
  await enforce(deps.limiter, await limitKeyForIp(deps, 'login-ip', input.ip), LIMITS.loginIp);
  await enforce(deps.limiter, accountKey, LIMITS.loginAccount);

  const user = await findUserForLogin(deps.db, principal.email);
  const verified = user && isUsableHash(user.passwordHash) ? await verifyPassword(input.password, user.passwordHash) : await verifyAgainstDummy(input.password);
  if (!user || user.id !== principal.userId || !verified) throw new AppError(403, 'password_incorrect', 'The password is incorrect');
  await deps.limiter.reset(accountKey);

  if (!(await deleteAccount(deps.db, principal.userId))) {
    throw new AppError(409, 'last_owner', 'Transfer or delete the workspaces you are the only owner of first');
  }
}

export function passwordResetJob(userId: string): JobEnvelope<{ userId: string }> {
  const id = newId('job');
  return {
    v: 1,
    type: PASSWORD_RESET_JOB,
    id,
    idempotencyKey: id,
    workspaceId: null,
    occurredAt: new Date().toISOString(),
    notAfter: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    payload: { userId },
  };
}

/**
 * The caller answers 202 before this finishes, by way of waitUntil, so that timing does not reveal whether
 * the account exists. The job carries only the user ID: the reset token is created when the email is sent,
 * so it never sits in a queue or a dead-letter record.
 */
export async function requestPasswordReset(deps: AuthDeps, input: { email: string; ip: string }): Promise<void> {
  const [byIp, byEmail] = await Promise.all([
    deps.limiter.consume(await limitKeyForIp(deps, 'reset-ip', input.ip), LIMITS.resetIp.limit, LIMITS.resetIp.windowSeconds),
    deps.limiter.consume(await limitKey('reset-email', input.email), LIMITS.resetEmail.limit, LIMITS.resetEmail.windowSeconds),
  ]);
  // Silently, because an error would reveal which addresses are being limited.
  if (!byIp.allowed || !byEmail.allowed) return;
  const userId = await findActiveUserId(deps.db, input.email);
  if (userId) await deps.emailJobs.send(passwordResetJob(userId));
}

export const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/**
 * A failed send throws, so the job retries. Each attempt has its own token and so a different body, and
 * providers reject a reused idempotency key with a changed body, so the key follows the token. A crash after
 * sending can therefore send two emails, each with a working link, which is harmless.
 */
export async function sendPasswordResetEmail(
  deps: { db: Database; email: EmailProvider; publicBaseUrl: string; installationName: string; fromEmail: string },
  userId: string,
): Promise<void> {
  const contact = await getUserContact(deps.db, userId);
  if (!contact) return;
  const token = generateOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  await issueAuthToken(deps.db, { tokenHash, userId, purpose: 'password_reset', ttlMs: RESET_TTL_MS });
  // In the fragment, which browsers do not send to servers, so the token stays out of access logs.
  const link = `${deps.publicBaseUrl.replace(/\/+$/, '')}/reset-password#token=${token}`;
  await deps.email.send({
    to: contact.email,
    from: { name: deps.installationName, email: deps.fromEmail },
    subject: `Reset your ${deps.installationName} password`,
    text: `Use this link to choose a new password. It expires in one hour.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`,
    html: `<p>Hello ${escapeHtml(contact.name)},</p><p>Use this link to choose a new password. It expires in one hour.</p><p><a href="${escapeHtml(link)}">Reset your password</a></p><p>If you did not ask for this, you can ignore this email.</p>`,
    idempotencyKey: `password-reset:${tokenHash}`,
  });
}

export async function completePasswordReset(deps: AuthDeps, input: { token: string; password: string; ip: string }): Promise<void> {
  await enforce(deps.limiter, await limitKeyForIp(deps, 'confirm-ip', input.ip), LIMITS.confirmIp);
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AppError(400, 'password_too_short', 'Choose a longer password');
  const tokenHash = await hashOpaqueToken(input.token);
  // Hashing is costly, so an invalid token is turned away first. The batch still makes the real decision.
  if (!(await isAuthTokenUsable(deps.db, tokenHash, 'password_reset'))) throw invalidToken();
  if (!(await confirmPasswordReset(deps.db, tokenHash, await hashPassword(input.password)))) throw invalidToken();
}

export async function completeEmailVerification(deps: AuthDeps, input: { token: string; ip: string }): Promise<void> {
  await enforce(deps.limiter, await limitKeyForIp(deps, 'confirm-ip', input.ip), LIMITS.confirmIp);
  if (!(await confirmEmailVerification(deps.db, await hashOpaqueToken(input.token)))) throw invalidToken();
}
