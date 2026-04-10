import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';

type InstallerOption = {
  fileName: string;
  sourcePath: string;
  sourceType: 'local' | 'remote';
  packageDir: string;
  size: number;
};

type GameItem = {
  id: string;
  name: string;
  sourceType: 'local' | 'remote';
  installers: InstallerOption[];
};

type InstallSession = {
  id: string;
  state: string;
  progress: string;
  installDir?: string;
  localInstallerPath?: string;
  remoteUiUrl?: string;
  runtime?: { runtimeDir?: string };
  download?: {
    totalBytes?: number | null;
    transferredBytes?: number | null;
    percent?: number | null;
  };
};

type GamesApiResponse = {
  count: number;
  games: GameItem[];
  remoteStatus?: 'ok' | 'unavailable';
  remoteError?: string | null;
  error?: string;
};

@Component({
  selector: 'app-root',
  imports: [CommonModule],
  template: `
    <main class="app">
      <header class="hero">
        <p class="eyebrow">LAN GAME DEPLOYMENT</p>
        <h1>Install games from your server in minutes</h1>
        <p class="subhead">Browse available installers, start a package copy, then complete setup in isolated web-accessed desktop.</p>
        <div class="hero-actions">
          <button class="btn btn-primary" (click)="fetchGames()" [disabled]="loading">Refresh Library</button>
          <span class="pill">{{ status }}</span>
        </div>
      </header>

      <section class="panel">
        <div class="panel-header">
          <h2>Available Games</h2>
          <p class="muted">{{ gameCountLabel }}</p>
        </div>

        <p *ngIf="remoteWarning" class="warn">{{ remoteWarning }}</p>

        <p *ngIf="errorMessage" class="muted">{{ errorMessage }}</p>

        <div class="games-grid" *ngIf="games.length">
          <article class="game-card" *ngFor="let game of games; trackBy: trackByGameId">
            <h3 class="game-title">{{ game.name }}</h3>
            <p class="game-meta">{{ game.installers.length }} option(s) • source: {{ game.sourceType }}</p>
            <label class="installer-label">Installer file</label>
            <select class="installer-select" [value]="selectedInstaller[game.id] || ''" (change)="onInstallerSelect(game.id, $event)">
              <option *ngFor="let installer of game.installers" [value]="installer.sourcePath">
                {{ installer.fileName }} ({{ formatBytes(installer.size) }})
              </option>
            </select>
            <button class="btn btn-secondary" (click)="startInstall(game)" [disabled]="loading">Download Installer</button>
          </article>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Install Session</h2>
        </div>

        <div class="session-box" *ngIf="session; else noSessionTpl">
          <p class="session-state">State: {{ session.state }}</p>
          <p class="session-progress">{{ session.progress }}</p>
          <p class="muted">Install directory: {{ session.installDir || 'n/a' }}</p>
          <p class="muted">Installer file: {{ session.localInstallerPath || 'n/a' }}</p>
          <div *ngIf="session.download" class="progress-wrap">
            <div class="progress-bar">
              <div class="progress-fill" [style.width.%]="session.download.percent || 0"></div>
            </div>
            <p class="muted progress-text">
              Download: {{ formatBytes(session.download.transferredBytes || 0) }}
              <span *ngIf="session.download.totalBytes"> / {{ formatBytes(session.download.totalBytes || 0) }}</span>
              <span *ngIf="session.download.percent !== null && session.download.percent !== undefined"> ({{ session.download.percent }}%)</span>
            </p>
          </div>
          <p class="muted" *ngIf="session.remoteUiUrl">
            Isolated installer UI:
            <a [href]="session.remoteUiUrl" target="_blank" rel="noopener noreferrer">Open remote installer desktop</a>
          </p>

          <div class="hero-actions" *ngIf="session.state === 'awaiting_user'">
            <button class="btn btn-accent" (click)="launchInstaller()" [disabled]="loading">Launch Installer UI</button>
          </div>

          <div class="hero-actions" *ngIf="session.runtime?.runtimeDir">
            <button class="btn btn-secondary" (click)="loadLogs()" [disabled]="loading">Show Session Logs</button>
          </div>
          <pre class="logs" *ngIf="sessionLogs">{{ sessionLogs }}</pre>
        </div>
      </section>
    </main>

    <ng-template #noSessionTpl>
      <div class="session-box"><p>No active install session</p></div>
    </ng-template>
  `,
  styles: [`
    :host { display: block; }
    .app { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 3rem; font-family: Manrope, sans-serif; color: #151922; }
    .hero { margin-bottom: 1rem; }
    .eyebrow { margin: 0; letter-spacing: 0.14em; color: #0f766e; font-size: 0.78rem; font-weight: 800; }
    h1 { margin: 0.35rem 0 0.75rem; font-family: 'Space Grotesk', sans-serif; font-size: clamp(1.7rem, 4vw, 2.6rem); }
    .subhead, .muted { color: #5f6b85; margin: 0; }
    .hero-actions { margin-top: 0.9rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
    .pill { padding: 0.4rem 0.7rem; border: 1px solid #d9dfec; border-radius: 999px; background: #fff; font-size: 0.82rem; }
    .panel { margin-top: 1rem; border: 1px solid #d9dfec; border-radius: 16px; padding: 1rem; background: rgba(255,255,255,0.92); }
    .panel-header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 0.8rem; }
    .games-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
    .game-card { border: 1px solid #d9dfec; border-radius: 14px; padding: 0.9rem; display: flex; flex-direction: column; gap: 0.45rem; }
    .game-title { margin: 0; }
    .game-meta { margin: 0; font-size: 0.86rem; color: #5f6b85; }
    .installer-label { font-size: 0.78rem; color: #5f6b85; }
    .installer-select { border: 1px solid #d9dfec; border-radius: 10px; padding: 0.5rem; font: inherit; }
    .btn { border: 0; border-radius: 10px; padding: 0.55rem 0.8rem; font: inherit; font-weight: 700; cursor: pointer; }
    .btn-primary { color: #fff; background: linear-gradient(135deg, #0f766e, #0a5c57); }
    .btn-secondary { color: #fff; background: linear-gradient(135deg, #1f2937, #111827); }
    .btn-accent { color: #111827; background: linear-gradient(135deg, #fbbf24, #f59e0b); }
    .session-box { border: 1px dashed #d9dfec; border-radius: 12px; padding: 0.9rem; background: #fff; }
    .session-state { margin: 0; font-weight: 700; }
    .progress-wrap { margin: 0.5rem 0; }
    .progress-bar { width: 100%; height: 10px; border-radius: 999px; background: #e5e7eb; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(135deg, #0f766e, #14b8a6); transition: width 0.25s ease; }
    .progress-text { margin-top: 0.3rem; }
    .logs { margin-top: 0.7rem; max-height: 280px; overflow: auto; background: #0f172a; color: #e2e8f0; padding: 0.7rem; border-radius: 10px; }
    .warn { color: #92400e; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 10px; padding: 0.6rem; margin: 0 0 0.8rem; }
  `],
})
export class App implements OnInit, OnDestroy {
  games: GameItem[] = [];
  selectedInstaller: Record<string, string> = {};
  session: InstallSession | null = null;
  sessionLogs = '';
  status = 'Idle';
  gameCountLabel = 'Loading...';
  errorMessage = '';
  remoteWarning = '';
  loading = false;
  pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.fetchGames();
    this.restoreSession();
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

  async fetchGames(): Promise<void> {
    this.loading = true;
    this.status = 'Loading library...';
    this.errorMessage = '';
    this.remoteWarning = '';
    try {
      const response = await fetch('/api/games');
      const data = (await response.json()) as GamesApiResponse;
      if (!response.ok) throw new Error(data.error || 'Failed to load games');
      this.games = data.games || [];
      this.gameCountLabel = `${data.count} game groups (local + remote)`;
      if (data.remoteStatus === 'unavailable') {
        this.remoteWarning = `Remote SSH unavailable: ${data.remoteError || 'unknown error'}`;
      }
      for (const game of this.games) {
        if (!this.selectedInstaller[game.id] && game.installers.length) {
          this.selectedInstaller[game.id] = game.installers[0].sourcePath;
        }
      }
      this.status = 'Library loaded';
    } catch (err: any) {
      this.errorMessage = err.message || 'Failed to load games';
      this.gameCountLabel = 'Failed to load';
      this.status = 'Error loading games';
    } finally {
      this.loading = false;
    }
  }

  async startInstall(game: GameItem): Promise<void> {
    const sourcePath = this.selectedInstaller[game.id] || game.installers[0]?.sourcePath;
    const installer = game.installers.find((item) => item.sourcePath === sourcePath) || game.installers[0];
    if (!installer) return;

    this.loading = true;
    try {
      const response = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameName: game.name,
          sourcePath: installer.sourcePath,
          sourceType: installer.sourceType,
          packageDir: installer.packageDir
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Install start failed');
      localStorage.setItem('activeInstallSessionId', payload.sessionId);
      await this.fetchSession(payload.sessionId);
      this.startPolling();
      this.status = 'Download started';
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
      const response = await fetch(`/api/install/${this.session.id}/launch`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to launch installer');
      this.session = payload.session;
      this.status = 'Installer launched';
      if (payload.remoteUiUrl) window.open(payload.remoteUiUrl, '_blank', 'noopener,noreferrer');
      this.startPolling();
    } catch (err: any) {
      this.status = err.message || 'Launch failed';
    } finally {
      this.loading = false;
    }
  }

  async loadLogs(): Promise<void> {
    if (!this.session) return;
    this.loading = true;
    try {
      const response = await fetch(`/api/install/${this.session.id}/logs`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch logs');
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
      const response = await fetch('/api/install/active');
      const data = await response.json();
      if (response.ok && data.session?.id) {
        localStorage.setItem('activeInstallSessionId', data.session.id);
        this.session = data.session;
        this.startPolling();
      }
    } catch {
      // ignore optional active-session lookup failure
    }
  }

  private async fetchSession(sessionId: string): Promise<void> {
    const response = await fetch(`/api/install/${sessionId}`);
    const data = await response.json();
    if (!response.ok) {
      localStorage.removeItem('activeInstallSessionId');
      this.session = null;
      return;
    }
    this.session = data;
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
