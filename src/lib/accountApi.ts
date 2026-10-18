/**
 * Client for the MasteringPro account API (accounts, projects, presets).
 * Cookie-based sessions — every call sends credentials. Same base URL as the
 * AI proxy (`VITE_API_URL`). All features are optional: when the backend has no
 * database the endpoints return 501 and the UI stays in local-only mode.
 */
const FALLBACK_BASE = import.meta.env.DEV ? 'http://localhost:8787' : '';
const API_BASE = (import.meta.env.VITE_API_URL ?? FALLBACK_BASE).replace(/\/+$/, '');

export interface Account {
  id: string;
  email: string;
  displayName: string | null;
  plan: 'free' | 'pro';
  /** AI Mastering / Copilot credits remaining. The manual DSP console never spends these. */
  credits: number;
}

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  /** null until the Stripe Price is configured; the amount always comes from Stripe. */
  price_usd: number | null;
  description: string;
  popular: boolean;
  /** false until STRIPE_PRICE_PACK is configured on the server for this pack. */
  available: boolean;
}

export interface Project {
  id: string;
  title: string;
  sourceName: string | null;
  sourceSampleRate: number | null;
  sourceChannels: number | null;
  sourceDurationS: number | null;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectVersion {
  id: string;
  label: string | null;
  chainParams: Record<string, unknown>;
  analysis: Record<string, unknown> | null;
  targetPlatform: string | null;
  targetLufs: number | null;
  createdAt: string;
}

export class ApiError extends Error {
  status: number;
  /** machine-readable error from the server, e.g. 'CREDITS_EXHAUSTED' */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE) throw new ApiError('API URL not configured', 0);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(body?.message || body?.error || res.statusText, res.status, body?.error);
  return body as T;
}

export const accountApi = {
  /** Whether the backend advertises a database (accounts available). */
  async available(): Promise<boolean> {
    try {
      const h = await req<{ db?: boolean }>('/health');
      return !!h.db;
    } catch {
      return false;
    }
  },

  me: () => req<{ user: Account }>('/api/auth/me').then((r) => r.user),
  register: (email: string, password: string, displayName?: string) =>
    req<{ user: Account }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName }),
    }).then((r) => r.user),
  login: (email: string, password: string) =>
    req<{ user: Account }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((r) => r.user),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  listProjects: () => req<{ projects: Project[] }>('/api/projects').then((r) => r.projects),
  createProject: (data: Partial<Project> & { title: string }) =>
    req<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(data) }).then((r) => r.project),
  getProject: (id: string) =>
    req<{ project: Project; versions: ProjectVersion[] }>(`/api/projects/${id}`),
  deleteProject: (id: string) => req<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  addVersion: (projectId: string, data: Record<string, unknown>) =>
    req<{ version: ProjectVersion }>(`/api/projects/${projectId}/versions`, {
      method: 'POST',
      body: JSON.stringify(data),
    }).then((r) => r.version),

  listPresets: () =>
    req<{ presets: Array<{ id: string; name: string; genre: string | null; chainParams: Record<string, unknown>; isFactory: boolean }> }>(
      '/api/presets',
    ).then((r) => r.presets),
  savePreset: (name: string, chainParams: Record<string, unknown>, genre?: string) =>
    req('/api/presets', { method: 'POST', body: JSON.stringify({ name, chainParams, genre }) }),
  deletePreset: (id: string) => req<{ ok: true }>(`/api/presets/${id}`, { method: 'DELETE' }),
};

export const billingApi = {
  listPacks: () =>
    req<{ packs: CreditPack[]; stripe_enabled: boolean; currency: string }>('/api/billing/packs'),
  checkout: (packId: string) =>
    req<{ checkout_url: string; session_id: string }>('/api/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ pack_id: packId }),
    }),
};

export interface ExportCharge {
  /** credits spent by this call (0 = every track was already paid for) */
  charged: number;
  covered: number;
  credits: number;
  covered_until: string | null;
  window_days: number;
  /** false while the server has export metering switched off */
  metering?: boolean;
}

export const creditsApi = {
  /** Public: is exporting charged yet? */
  status: () => req<{ export_metering: boolean; window_days: number; max_tracks: number }>('/api/credits/status'),
  /** Pays for exporting these tracks as masters (1 credit each; the same track is free again for 3 days). */
  chargeExport: (tracks: Array<{ key: string; label?: string }>) =>
    req<ExportCharge>('/api/credits/export', { method: 'POST', body: JSON.stringify({ tracks }) }),
};

export interface MasterPassport {
  alg: 'Ed25519';
  keyId: string;
  payload: Record<string, unknown> & { sha256: string; issuedAt: string };
  signature: string;
}

export const passportApi = {
  sign: (input: Record<string, unknown>) => req<MasterPassport>('/api/passport/sign', { method: 'POST', body: JSON.stringify(input) }),
  verify: (passport: unknown, sha256?: string) =>
    req<{ valid: boolean; reason?: string; fileMatches?: boolean; issuedAt?: string; keyId?: string }>('/api/passport/verify', {
      method: 'POST',
      body: JSON.stringify({ passport, sha256 }),
    }),
};
