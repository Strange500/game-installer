import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import {
  fetchActiveSessionApi,
  fetchGameMetadataApi,
  fetchGamesApi,
  fetchInstalledGamesApi,
  fetchSessionApi,
  fetchSessionLogsApi,
  launchInstallApi,
  startInstallApi
} from './api.client';
import { GameItem, GameMetadata, InstalledGame, InstallSession } from './api.types';

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  games: GameItem[] = [];
  gameMetadata: Record<string, GameMetadata> = {};
  installedGames: InstalledGame[] = [];
  selectedInstaller: Record<string, string> = {};
  session: InstallSession | null = null;
  sessionLogs = '';
  status = 'Idle';
  gameCountLabel = 'Loading...';
  errorMessage = '';
  remoteWarning = '';
  loading = false;
  loadingMoreGames = false;
  hasMoreGames = false;
  gamesOffset = 0;
  readonly gamesPageSize = 24;
  totalGames = 0;
  pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.fetchGames(true);
    this.restoreSession();
    this.loadInstalledGames();
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  trackByGameId(_: number, game: GameItem): string {
    return game.id;
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return 'Unknown size';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(value < 10 && idx > 0 ? 1 : 0)} ${units[idx]}`;
  }

  onInstallerSelect(gameId: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.selectedInstaller[gameId] = value;
  }

  async fetchGames(reset = false): Promise<void> {
    if (reset) {
      this.loading = true;
      this.games = [];
      this.gameMetadata = {};
      this.gamesOffset = 0;
      this.hasMoreGames = false;
      this.totalGames = 0;
    }
    this.status = 'Loading library...';
    this.errorMessage = '';
    this.remoteWarning = '';

    try {
      const data = await fetchGamesApi(this.gamesOffset, this.gamesPageSize, reset);
      const incomingGames = data.games || [];

      const existingIds = new Set(this.games.map((game) => game.id));
      const dedupedIncoming = incomingGames.filter((game) => !existingIds.has(game.id));
      this.games = reset ? dedupedIncoming : [...this.games, ...dedupedIncoming];

      const total = data.total ?? data.count ?? this.games.length;
      this.totalGames = total;
      this.hasMoreGames = Boolean(data.hasMore);
      this.gamesOffset = (data.offset ?? this.gamesOffset) + incomingGames.length;
      this.gameCountLabel = `${this.games.length} / ${total} game groups loaded`;

      if (data.remoteStatus === 'unavailable') {
        this.remoteWarning = `Remote SSH unavailable: ${data.remoteError || 'unknown error'}`;
      }

      for (const game of this.games) {
        if (!this.selectedInstaller[game.id] && game.installers.length) {
          this.selectedInstaller[game.id] = game.installers[0].sourcePath;
        }
      }

      this.loadGameMetadata(dedupedIncoming);

      this.status = this.hasMoreGames ? 'Library partially loaded' : 'Library loaded';
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to load games';
      this.gameCountLabel = 'Failed to load';
      this.status = 'Error loading games';
    } finally {
      this.loading = false;
      this.loadingMoreGames = false;
    }
  }

  loadMoreGames(): void {
    if (this.loading || this.loadingMoreGames || !this.hasMoreGames) return;
    this.loadingMoreGames = true;
    this.fetchGames(false);
  }

  private loadGameMetadata(games: GameItem[]): void {
    for (const game of games) {
      if (this.gameMetadata[game.id]) continue;
      fetchGameMetadataApi(game.name)
        .then((metadata) => {
          this.gameMetadata = {
            ...this.gameMetadata,
            [game.id]: metadata
          };
        })
        .catch(() => {
          this.gameMetadata = {
            ...this.gameMetadata,
            [game.id]: {
              name: game.name,
              title: game.name,
              description: null,
              imageUrl: null,
              sourceUrl: null,
              provider: 'none'
            }
          };
        });
    }
  }

  async startInstall(game: GameItem): Promise<void> {
    const sourcePath = this.selectedInstaller[game.id] || game.installers[0]?.sourcePath;
    const installer = game.installers.find((item) => item.sourcePath === sourcePath) || game.installers[0];
    if (!installer) return;

    this.loading = true;
    try {
      const payload = await startInstallApi({
        gameName: game.name,
        sourcePath: installer.sourcePath,
        sourceType: installer.sourceType,
        packageDir: installer.packageDir
      });
      localStorage.setItem('activeInstallSessionId', payload.sessionId);
      await this.fetchSession(payload.sessionId);
      this.startPolling();
      this.status = 'Download started';
      this.loadInstalledGames();
    } catch (err: any) {
      this.status = err.message || 'Install failed to start';
    } finally {
      this.loading = false;
    }
  }

  async launchInstaller(): Promise<void> {
    if (!this.session) return;
    this.loading = true;
    try {
      const payload = await launchInstallApi(this.session.id);
      this.session = payload.session;
      this.status = 'Installer launched';
      if (payload.remoteUiUrl) window.open(payload.remoteUiUrl, '_blank', 'noopener,noreferrer');
      this.startPolling();
      this.loadInstalledGames();
    } catch (err: any) {
      this.status = err.message || 'Launch failed';
    } finally {
      this.loading = false;
    }
  }

  private async loadInstalledGames(): Promise<void> {
    try {
      const data = await fetchInstalledGamesApi();
      this.installedGames = data.games || [];
    } catch {
      // keep previous view on transient errors
    }
  }

  async loadLogs(): Promise<void> {
    if (!this.session) return;
    this.loading = true;
    try {
      const data = await fetchSessionLogsApi(this.session.id);
      this.sessionLogs = [
        `runtimeDir: ${data.runtimeDir}`,
        '\n=== x11vnc.err ===\n',
        data.tails.x11vncErr || '(empty)',
        '\n=== websockify.err ===\n',
        data.tails.websockifyErr || '(empty)',
        '\n=== installer.err ===\n',
        data.tails.installerErr || '(empty)'
      ].join('');
    } catch (err: any) {
      this.sessionLogs = err.message || 'Failed to load logs';
    } finally {
      this.loading = false;
    }
  }

  private async restoreSession(): Promise<void> {
    const saved = localStorage.getItem('activeInstallSessionId');
    if (saved) {
      await this.fetchSession(saved);
      this.startPolling();
      return;
    }

    try {
      const data = await fetchActiveSessionApi();
      if (data.session?.id) {
        localStorage.setItem('activeInstallSessionId', data.session.id);
        this.session = data.session;
        this.startPolling();
      }
    } catch {
      // ignore optional active-session lookup failure
    }
  }

  private async fetchSession(sessionId: string): Promise<void> {
    try {
      const data = await fetchSessionApi(sessionId);
      this.session = data;
    } catch (err: any) {
      if (err?.status === 404) {
        localStorage.removeItem('activeInstallSessionId');
        this.session = null;
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.session?.id) return;
      await this.fetchSession(this.session.id);
      const doneStates = ['failed'];
      if (this.session && doneStates.includes(this.session.state)) {
        clearInterval(this.pollTimer!);
        this.pollTimer = null;
      }
    }, 2500);
  }
}
