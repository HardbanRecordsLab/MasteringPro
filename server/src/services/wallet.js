// Client of HRL Wallet: one account and one credits balance shared with the other HRL apps (Metadata Engine, ...).
// Server-to-server with this app's bearer token. With WALLET_ENABLED off (the default) none of this is used and credits stay in
// the local `users` table. MasteringPro counts in TRACKS (1 track = 9 wallet credits); the wallet does the conversion.
import { config } from '../config.js';

export class WalletError extends Error {
  constructor(status, code, message, payload) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.payload = payload || {};
  }
}
/** The wallet did not answer (down, timeout, 5xx). Callers refuse the action instead of guessing a balance. */
export class WalletUnavailable extends WalletError {}

export const walletEnabled = () => Boolean(config.wallet.enabled && config.wallet.url && config.wallet.token);

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(config.wallet.url.replace(/\/+$/, '') + path, {
      method,
      headers: { Authorization: 'Bearer ' + config.wallet.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('[wallet] unreachable:', e.message);
    throw new WalletUnavailable(503, 'wallet_unavailable', 'HRL Wallet is not reachable');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) {
    console.error(`[wallet] ${method} ${path} -> ${res.status}`);
    throw new WalletUnavailable(503, 'wallet_unavailable', `HRL Wallet answered ${res.status}`, data);
  }
  if (res.status >= 400) throw new WalletError(res.status, String(data.error || 'error'), String(data.message || data.detail || ''), data);
  return data;
}

export const wallet = {
  register: (email, password) => call('POST', '/v1/accounts/register', { email, password }),
  login: (email, password) => call('POST', '/v1/accounts/login', { email, password }),
  /** { credits, unlimited, units, cost } — `units` = whole tracks the balance buys */
  balance: (accountId) => call('GET', `/v1/wallet/${accountId}/balance?product=master_export`),
  /** tracks: [{ key, label }]; the same tracks inside their 3-day window are free, an album is all or nothing */
  chargeExport: (accountId, key, tracks) =>
    call('POST', '/v1/wallet/charge', { account_id: accountId, product: 'master_export', idempotency_key: key, tracks }),
  checkout: (accountId, packId, successUrl, cancelUrl, lang) =>
    call('POST', '/v1/checkout', { account_id: accountId, pack_id: packId, success_url: successUrl, cancel_url: cancelUrl, lang }),
  purchases: (accountId) => call('GET', `/v1/wallet/${accountId}/purchases`).then((r) => r.purchases || []),
};

/** Sign-up for all HRL apps: a new wallet account (start credits), or the one the person made in another app (same password). */
export async function registerOrLink(email, password) {
  try {
    return (await wallet.register(email, password)).account_id;
  } catch (e) {
    if (!(e instanceof WalletError) || e.code !== 'email_taken') throw e;
  }
  try {
    return (await wallet.login(email, password)).account_id;
  } catch (e) {
    if (e instanceof WalletError && (e.code === 'bad_credentials' || e.code === 'locked')) {
      throw new WalletError(409, 'password_mismatch', 'This e-mail already has an HRL account with a different password. Sign in with that password.');
    }
    throw e;
  }
}

/** HTTP answer for a wallet error on an account route: [body, status] */
export function accountError(e) {
  if (e instanceof WalletUnavailable) return [{ error: 'Accounts are temporarily unavailable. Please try again in a minute.' }, 503];
  if (e instanceof WalletError) {
    if (e.code === 'bad_credentials') return [{ error: 'Wrong email or password' }, 401];
    if (e.code === 'locked') return [{ error: 'Too many failed attempts. Try again later.' }, 429];
    if (e.code === 'password_mismatch') return [{ error: e.message }, 409];
    if (e.code === 'weak_password' || e.code === 'bad_email') return [{ error: e.message || 'Invalid email or password (min 8 chars)' }, 400];
  }
  console.error('[wallet] unexpected:', e?.message);
  return [{ error: 'Accounts service error. Please try again.' }, 502];
}
