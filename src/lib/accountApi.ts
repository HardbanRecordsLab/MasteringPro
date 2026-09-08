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
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(body?.error || res.statusText, res.status);
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
