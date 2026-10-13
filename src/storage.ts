import fs from 'node:fs';
import path from 'node:path';
import { SynchronumConfig } from './config.js';
import { DriveFileInfo, GoogleDriveAppDataClient, GoogleDriveOAuth } from './gdrive.js';

export interface SyncStorageProvider {
  readonly type: 'gdrive' | 'local_folder';
  readonly name: string;
  listFiles(): Promise<DriveFileInfo[]>;
  downloadFile(fileIdOrName: string): Promise<Buffer>;
  uploadFile(name: string, content: Buffer, mimeType?: string): Promise<string>;
  deleteFile(fileIdOrName: string): Promise<void>;
  isAvailable(): Promise<boolean>;
  getDisplayName(): string;
}

export class GoogleDriveStorageProvider implements SyncStorageProvider {
  public readonly type = 'gdrive' as const;
  public readonly name = 'Google Drive API (appDataFolder)';
  private client: GoogleDriveAppDataClient;

  constructor(private oauth: GoogleDriveOAuth) {
    this.client = new GoogleDriveAppDataClient(oauth);
  }

  public async listFiles(): Promise<DriveFileInfo[]> {
    return this.client.listFiles();
  }

  public async downloadFile(fileId: string): Promise<Buffer> {
    return this.client.downloadFile(fileId);
  }

  public async uploadFile(name: string, content: Buffer, mimeType = 'application/octet-stream'): Promise<string> {
    return this.client.uploadFile(name, content, mimeType);
  }

  public async deleteFile(fileId: string): Promise<void> {
    return this.client.deleteFile(fileId);
  }

  public async isAvailable(): Promise<boolean> {
    return this.oauth.isAuthenticated();
  }

  public getDisplayName(): string {
    return `Google Drive Cloud (${this.oauth.isAuthenticated() ? 'Подключен 🟢' : 'Не авторизован ⚪'})`;
  }
}

export class LocalFolderStorageProvider implements SyncStorageProvider {
  public readonly type = 'local_folder' as const;
  public readonly name = 'Локальная папка (Google Диск / Облако)';
  private targetFolder: string;

  constructor(folderPath: string) {
    this.targetFolder = path.resolve(folderPath);
    this.ensureFolder();
  }

  private ensureFolder(): void {
    if (!fs.existsSync(this.targetFolder)) {
      try {
        fs.mkdirSync(this.targetFolder, { recursive: true });
      } catch {}
    }
  }

  public async listFiles(): Promise<DriveFileInfo[]> {
    this.ensureFolder();
    if (!fs.existsSync(this.targetFolder)) {
      return [];
    }

    const entries = fs.readdirSync(this.targetFolder);
    const files: DriveFileInfo[] = [];

    for (const name of entries) {
      const fullPath = path.join(this.targetFolder, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          files.push({
            id: name,
            name,
            size: String(stat.size),
            modifiedTime: stat.mtime.toISOString(),
          });
        }
      } catch {}
    }

    return files;
  }

  public async downloadFile(fileName: string): Promise<Buffer> {
    const fullPath = path.join(this.targetFolder, fileName);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Файл не найден в локальном хранилище: ${fileName}`);
    }
    return fs.readFileSync(fullPath);
  }

  public async uploadFile(name: string, content: Buffer): Promise<string> {
    this.ensureFolder();
    const fullPath = path.join(this.targetFolder, name);
    fs.writeFileSync(fullPath, content);
    return name;
  }

  public async deleteFile(fileName: string): Promise<void> {
    const fullPath = path.join(this.targetFolder, fileName);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }

  public async isAvailable(): Promise<boolean> {
    try {
      this.ensureFolder();
      return fs.existsSync(this.targetFolder);
    } catch {
      return false;
    }
  }

  public getDisplayName(): string {
    return `Локальная папка: ${this.targetFolder}`;
  }
}

export function createStorageProvider(config: SynchronumConfig, oauth?: GoogleDriveOAuth): SyncStorageProvider {
  if (config.storageType === 'local_folder') {
    return new LocalFolderStorageProvider(config.localFolderPath);
  }

  return new GoogleDriveStorageProvider(oauth || new GoogleDriveOAuth());
}
