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

export type GameMetadata = {
  name: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  provider: 'steam' | 'none';
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
  total?: number;
  pageCount?: number;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  games: GameItem[];
  remoteStatus?: 'ok' | 'unavailable';
  remoteError?: string | null;
  error?: string;
};
