export type InstallerSourceType = 'local' | 'remote';

export type InstallerOption = {
  fileName: string;
  sourcePath: string;
  sourceType: InstallerSourceType;
  packageDir: string;
  size: number;
};

export type GameItem = {
  id: string;
  name: string;
  sourceType: InstallerSourceType;
  installers: InstallerOption[];
};

export type InstallSession = {
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

export type GamesApiResponse = {
  count: number;
  games: GameItem[];
  remoteStatus?: 'ok' | 'unavailable';
  remoteError?: string | null;
  error?: string;
};
