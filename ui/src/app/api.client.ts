import { GamesApiResponse } from './api.types';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

export function fetchGamesApi(): Promise<GamesApiResponse> {
  return request<GamesApiResponse>('/api/games');
}

export function startInstallApi(body: {
  gameName: string;
  sourcePath: string;
  sourceType: 'local' | 'remote';
  packageDir: string;
}): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>('/api/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export function launchInstallApi(sessionId: string): Promise<any> {
  return request(`/api/install/${sessionId}/launch`, { method: 'POST' });
}

export function fetchSessionApi(sessionId: string): Promise<any> {
  return request(`/api/install/${sessionId}`);
}

export function fetchActiveSessionApi(): Promise<{ session: any | null }> {
  return request('/api/install/active');
}

export function fetchSessionLogsApi(sessionId: string): Promise<any> {
  return request(`/api/install/${sessionId}/logs`);
}
