import { randomBytes, createHash } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { eq, and, gt, lt } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { config } from './config.js';

const COOKIE = 'mp_session';

// --- passwords (argon2id, OWASP-ish params) ---
export async function hashPassword(password) {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 19456, // 19 MiB
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// --- sessions ---
export async function createSession(userId, userAgent) {
  const db = getDb();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400_000);
  await db.insert(schema.sessions).values({
    userId,
    tokenHash: sha256(token),
    userAgent: (userAgent || '').slice(0, 400),
    expiresAt,
  });
  return { token, expiresAt };
}

export async function destroySession(token) {
  if (!token) return;
  const db = getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
}

async function userForToken(token) {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ? { user: rows[0].users, session: rows[0].sessions } : null;
}

/** Best-effort sweep of expired rows. */
export async function sweepSessions() {
  try {
    await getDb().delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  } catch {
    /* ignore */
  }
}

// --- cookie plumbing (framework-agnostic strings) ---
export function sessionCookie(token, expiresAt) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`;
}
export function readToken(c) {
  const raw = c.req.header('cookie') || '';
  for (const kv of raw.split(/;\s*/)) {
    const i = kv.indexOf('=');
    if (i > 0 && kv.slice(0, i) === COOKIE) return kv.slice(i + 1);
  }
  return null;
}

// --- Hono middleware ---
/** Populates c.get('user') / c.get('token'); does not reject. */
export async function loadUser(c, next) {
  const token = readToken(c);
  c.set('token', token);
  if (token) {
    const found = await userForToken(token).catch(() => null);
    if (found) c.set('user', found.user);
  }
  await next();
}

/** Rejects with 401 when no valid session. Use after loadUser. */
export async function requireUser(c, next) {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401);
  await next();
}

export function publicUser(u) {
  return { id: u.id, email: u.email, displayName: u.displayName, plan: u.plan };
}
