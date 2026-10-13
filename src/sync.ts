import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SynchronumBundler } from './bundler.js';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths } from './paths.js';
import { AntigravitySqlite } from './sqlite.js';
import { GoogleDriveStorageProvider, SyncStorageProvider } from './storage.js';

export interface RemoteSessionEntry {
  conversation_id: string;
  title: string;
  step_count: number;
  last_modified_time: string;
  file_name: string;
  file_id: string;
  size_bytes: number;
  updated_at: string;
  author_device: string;
}

export interface RemoteIndex {
  version: number;
  updated_at: string;
  last_device: string;
  sessions: Record<string, RemoteSessionEntry>;
}

const INDEX_FILE_NAME = 'synchronum_index.json.enc';

export class SynchronumSyncEngine {
  private storage: SyncStorageProvider;
  private bundler: SynchronumBundler;
  private sqlite: AntigravitySqlite;
  private paths = getAntigravityPaths();

  constructor(providerOrOAuth: SyncStorageProvider | GoogleDriveOAuth) {
    if ('listFiles' in providerOrOAuth && typeof (providerOrOAuth as any).listFiles === 'function') {
      this.storage = providerOrOAuth as SyncStorageProvider;
    } else {
      this.storage = new GoogleDriveStorageProvider(providerOrOAuth as GoogleDriveOAuth);
    }
    this.bundler = new SynchronumBundler();
    this.sqlite = new AntigravitySqlite(this.paths.summariesDbPath);
  }

  public getStorageProvider(): SyncStorageProvider {
    return this.storage;
  }

  public async fetchRemoteIndex(password: string): Promise<RemoteIndex> {
    const files = await this.storage.listFiles();
    const indexFile = files.find((f) => f.name === INDEX_FILE_NAME);

    if (!indexFile) {
      return {
        version: 1,
        updated_at: new Date().toISOString(),
        last_device: os.hostname(),
        sessions: {},
      };
    }

    const encryptedData = await this.storage.downloadFile(indexFile.id);
    let decrypted = encryptedData;
    if (isEncryptedBuffer(encryptedData)) {
      try {
        decrypted = decryptBuffer(encryptedData, password);
      } catch {
        throw new Error('Неверный мастер-пароль! Введенный пароль не совпадает с паролем облака.');
      }
    }

    try {
      return JSON.parse(decrypted.toString('utf-8'));
    } catch {
      throw new Error('Неверный мастер-пароль или поврежденный файл индекса.');
    }
  }

  public async saveRemoteIndex(index: RemoteIndex, password: string): Promise<string> {
    index.updated_at = new Date().toISOString();
    index.last_device = `${os.hostname()} (${os.platform()})`;

    const jsonBuffer = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
    const encrypted = encryptBuffer(jsonBuffer, password);

    return this.storage.uploadFile(INDEX_FILE_NAME, encrypted, 'application/octet-stream');
  }

  public async pushSession(
    conversationId: string,
    password: string
  ): Promise<{ conversationId: string; title: string; bytes: number }> {
    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });
    const bundlePath = path.join(tempDir, `${conversationId}.bundle.enc`);

    try {
      const exportResult = await this.bundler.exportBundle(conversationId, {
        outputPath: bundlePath,
        password,
      });

      const bundleBuffer = fs.readFileSync(bundlePath);
      const remoteFileName = `session_${conversationId}.bundle.enc`;

      const fileId = await this.storage.uploadFile(remoteFileName, bundleBuffer);

      // Update remote index
      const index = await this.fetchRemoteIndex(password);
      index.sessions[conversationId] = {
        conversation_id: conversationId,
        title: exportResult.manifest.title,
        step_count: exportResult.manifest.step_count,
        last_modified_time: exportResult.manifest.last_modified_time,
        file_name: remoteFileName,
        file_id: fileId,
        size_bytes: bundleBuffer.length,
        updated_at: new Date().toISOString(),
        author_device: `${os.hostname()} (${os.platform()})`,
      };

      await this.saveRemoteIndex(index, password);

      return {
        conversationId,
        title: exportResult.manifest.title,
        bytes: bundleBuffer.length,
      };
    } finally {
      if (fs.existsSync(bundlePath)) {
        try {
          fs.unlinkSync(bundlePath);
        } catch {}
      }
    }
  }

  public async pullAll(password: string): Promise<{ restored: string[]; skipped: string[] }> {
    const index = await this.fetchRemoteIndex(password);
    const localSummaries = this.sqlite.listSummaries(500);
    const localMap = new Map(localSummaries.map((s) => [s.conversation_id, s]));

    const restored: string[] = [];
    const skipped: string[] = [];

    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });

    for (const [id, entry] of Object.entries(index.sessions)) {
      const local = localMap.get(id);

      // Check if local is already up to date
      if (local && local.step_count >= entry.step_count) {
        skipped.push(entry.title || id);
        continue;
      }

      // Download and import
      const tempFile = path.join(tempDir, `${id}.download.enc`);
      try {
        const data = await this.storage.downloadFile(entry.file_id);
        fs.writeFileSync(tempFile, data);

        await this.bundler.importBundle(tempFile, { password });
        restored.push(entry.title || id);
      } finally {
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch {}
        }
      }
    }

    return { restored, skipped };
  }
}
