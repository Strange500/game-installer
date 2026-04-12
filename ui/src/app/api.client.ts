import { GameMetadata, GamesApiResponse, InstalledGame } from './api.types';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function fetchGamesApi(offset = 0, limit = 24, refresh = false): Promise<GamesApiResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    refresh: String(refresh)
  });
  return request<GamesApiResponse>(`/api/games?${params.toString()}`);
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

export function fetchInstalledGamesApi(): Promise<{ count: number; games: InstalledGame[] }> {
  return request('/api/installed-games');
}

export function fetchGameMetadataApi(name: string): Promise<GameMetadata> {
  return request(`/api/game-meta?name=${encodeURIComponent(name)}`);
}
