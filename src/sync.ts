import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SynchronumBundler } from './bundler.js';
import { getDefaultDeviceId, loadConfig } from './config.js';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths } from './paths.js';
import { AntigravitySqlite } from './sqlite.js';
import { GoogleDriveStorageProvider, SyncStorageProvider } from './storage.js';
import { DeviceInfo } from './types.js';
import { getConversationStorageSubpath } from './projects.js';

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
  device_id: string;
  device_name: string;
  sessions: Record<string, RemoteSessionEntry>;
}

export interface SyncCycleResult {
  pushed: string[];
  restored: string[];
  skipped: string[];
  devices: DeviceInfo[];
}

const LEGACY_INDEX_FILE = 'synchronum_index.json.enc';

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

  public getDeviceId(): string {
    const config = loadConfig();
    return config.deviceId || getDefaultDeviceId();
  }

  public getDeviceName(): string {
    const config = loadConfig();
    return config.deviceName || 'Laptop-Work';
  }

  public getStorageProvider(): SyncStorageProvider {
    return this.storage;
  }

  private getDeviceIndexPath(deviceId: string): string {
    return `devices/${deviceId}/index.json.enc`;
  }

  private getDeviceInfoPath(deviceId: string): string {
    return `devices/${deviceId}/info.json.enc`;
  }

  private getDeviceSessionPath(deviceId: string, conversationId: string): string {
    const summary = this.sqlite.getSummary(conversationId);
    const subpath = summary
      ? getConversationStorageSubpath(summary, conversationId)
      : `standalone/session_${conversationId}.bundle.enc`;
    return `devices/${deviceId}/${subpath}`;
  }

  public async fetchDeviceIndex(deviceId: string, password: string): Promise<RemoteIndex> {
    const indexPath = this.getDeviceIndexPath(deviceId);
    let encryptedData: Buffer | null = null;

    try {
      encryptedData = await this.storage.downloadFile(indexPath);
    } catch {
      // Check legacy root index if own device
      if (deviceId === this.getDeviceId()) {
        try {
          encryptedData = await this.storage.downloadFile(LEGACY_INDEX_FILE);
        } catch {}
      }
    }

    if (!encryptedData) {
      return {
        version: 2,
        updated_at: new Date().toISOString(),
        device_id: deviceId,
        device_name: this.getDeviceName(),
        sessions: {},
      };
    }

    let decrypted = encryptedData;
    if (isEncryptedBuffer(encryptedData)) {
      try {
        decrypted = decryptBuffer(encryptedData, password);
      } catch {
        throw new Error('Неверный мастер-пароль! Введенный пароль не совпадает с паролем хранилища.');
      }
    }

    try {
      const parsed = JSON.parse(decrypted.toString('utf-8'));
      return {
        version: 2,
        updated_at: parsed.updated_at || new Date().toISOString(),
        device_id: parsed.device_id || deviceId,
        device_name: parsed.device_name || deviceId,
        sessions: parsed.sessions || {},
      };
    } catch {
      throw new Error('Поврежденный файл индекса устройства.');
    }
  }

  public async saveDeviceIndex(deviceId: string, index: RemoteIndex, password: string): Promise<string> {
    index.updated_at = new Date().toISOString();
    index.device_id = deviceId;
    index.device_name = this.getDeviceName();

    const jsonBuffer = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
    const encrypted = encryptBuffer(jsonBuffer, password);

    const uploaded = await this.storage.uploadFile(
      this.getDeviceIndexPath(deviceId),
      encrypted,
      'application/octet-stream'
    );

    // Also update device info
    await this.saveDeviceInfo(deviceId, password, Object.keys(index.sessions).length);

    return uploaded;
  }

  public async saveDeviceInfo(deviceId: string, password: string, sessionsCount: number): Promise<void> {
    const info: DeviceInfo = {
      id: deviceId,
      name: this.getDeviceName(),
      hostname: os.hostname(),
      platform: os.platform(),
      updated_at: new Date().toISOString(),
      sessions_count: sessionsCount,
    };

    const jsonBuffer = Buffer.from(JSON.stringify(info, null, 2), 'utf-8');
    const encrypted = encryptBuffer(jsonBuffer, password);

    try {
      await this.storage.uploadFile(this.getDeviceInfoPath(deviceId), encrypted, 'application/octet-stream');
    } catch {}
  }

  public async listAllDevices(password?: string): Promise<DeviceInfo[]> {
    const deviceIds = await this.storage.listDevices();
    const result: DeviceInfo[] = [];

    // Always include current device
    const myId = this.getDeviceId();
    if (!deviceIds.includes(myId)) {
      deviceIds.push(myId);
    }

    for (const id of deviceIds) {
      let info: DeviceInfo | null = null;
      if (password) {
        try {
          const enc = await this.storage.downloadFile(this.getDeviceInfoPath(id));
          const dec = decryptBuffer(enc, password);
          info = JSON.parse(dec.toString('utf-8'));
        } catch {}
      }

      if (info) {
        result.push(info);
      } else {
        result.push({
          id,
          name: id === myId ? this.getDeviceName() : id,
          hostname: id,
          platform: 'unknown',
          updated_at: new Date().toISOString(),
          sessions_count: 0,
        });
      }
    }

    return result;
  }

  public async pushSession(
    conversationId: string,
    password: string
  ): Promise<{ conversationId: string; title: string; bytes: number }> {
    const deviceId = this.getDeviceId();
    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });
    const bundlePath = path.join(tempDir, `${conversationId}.bundle.enc`);

    try {
      const exportResult = await this.bundler.exportBundle(conversationId, {
        outputPath: bundlePath,
        password,
      });

      const bundleBuffer = fs.readFileSync(bundlePath);
      const remoteFileName = this.getDeviceSessionPath(deviceId, conversationId);

      const fileId = await this.storage.uploadFile(remoteFileName, bundleBuffer);

      // Update device index
      const index = await this.fetchDeviceIndex(deviceId, password);
      const displayTitle = exportResult.manifest.title || (exportResult.manifest.summary as any)?.preview || conversationId;

      index.sessions[conversationId] = {
        conversation_id: conversationId,
        title: displayTitle,
        step_count: exportResult.manifest.step_count,
        last_modified_time: exportResult.manifest.last_modified_time,
        file_name: remoteFileName,
        file_id: fileId,
        size_bytes: bundleBuffer.length,
        updated_at: new Date().toISOString(),
        author_device: `${this.getDeviceName()} (${os.hostname()})`,
      };

      await this.saveDeviceIndex(deviceId, index, password);

      return {
        conversationId,
        title: displayTitle,
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

  // Safe two-way sync: backup local to own folder, merge from others without deleting
  public async syncAll(password: string): Promise<SyncCycleResult> {
    const myId = this.getDeviceId();
    const pushed: string[] = [];
    const restored: string[] = [];
    const skipped: string[] = [];

    // Phase 1: Backup / Publish Own Sessions to devices/<myId>/
    const localSummaries = this.sqlite.listSummaries(500);
    const myIndex = await this.fetchDeviceIndex(myId, password);

    for (const local of localSummaries) {
      const entry = myIndex.sessions[local.conversation_id];
      const localMod = new Date(local.last_modified_time || 0).getTime();
      const remoteMod = entry ? new Date(entry.last_modified_time || 0).getTime() : 0;

      // Push if missing or updated locally
      if (!entry || localMod > remoteMod || local.step_count > (entry.step_count || 0)) {
        try {
          const res = await this.pushSession(local.conversation_id, password);
          pushed.push(res.title || local.conversation_id);
        } catch (e: any) {
          console.error(`[Sync] Error pushing ${local.conversation_id}:`, e.message);
        }
      }
    }

    // Phase 2: Pull & Merge from OTHER devices (Append-only & Smart Update)
    const allDeviceIds = await this.storage.listDevices();
    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });

    const localMap = new Map(this.sqlite.listSummaries(500).map((s) => [s.conversation_id, s]));

    for (const otherId of allDeviceIds) {
      if (otherId === myId) continue; // Skip own device

      let otherIndex: RemoteIndex | null = null;
      try {
        otherIndex = await this.fetchDeviceIndex(otherId, password);
      } catch (err: any) {
        console.warn(`[Sync] Could not read index for device ${otherId}:`, err.message);
        continue;
      }

      for (const [id, remoteEntry] of Object.entries(otherIndex.sessions)) {
        const local = localMap.get(id);

        if (local) {
          const localMod = new Date(local.last_modified_time || 0).getTime();
          const remoteMod = new Date(remoteEntry.last_modified_time || 0).getTime();

          // Only update if remote is genuinely newer
          if (remoteMod <= localMod && remoteEntry.step_count <= local.step_count) {
            skipped.push(remoteEntry.title || id);
            continue;
          }
        }

        // Download and import
        const tempFile = path.join(tempDir, `${id}.download.enc`);
        try {
          const data = await this.storage.downloadFile(remoteEntry.file_id || remoteEntry.file_name);
          fs.writeFileSync(tempFile, data);

          await this.bundler.importBundle(tempFile, { password });
          restored.push(remoteEntry.title || id);
          localMap.set(id, this.sqlite.getSummary(id)!);
        } catch (err: any) {
          console.error(`[Sync] Error restoring session ${id} from ${otherId}:`, err.message);
        } finally {
          if (fs.existsSync(tempFile)) {
            try {
              fs.unlinkSync(tempFile);
            } catch {}
          }
        }
      }
    }

    const devices = await this.listAllDevices(password);

    return {
      pushed,
      restored,
      skipped,
      devices,
    };
  }

  // Alias for backward compatibility
  public async pullAll(password: string): Promise<{ restored: string[]; skipped: string[] }> {
    const result = await this.syncAll(password);
    return {
      restored: result.restored,
      skipped: result.skipped,
    };
  }

  public async fetchRemoteIndex(password: string): Promise<RemoteIndex> {
    return this.fetchDeviceIndex(this.getDeviceId(), password);
  }
}
