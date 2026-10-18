import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SynchronumBundler } from './bundler.js';
import { TombstoneEntry, TombstoneManager } from './tombstones.js';
import { getDefaultDeviceId, getDefaultDeviceName, loadConfig } from './config.js';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { PathResolver } from './path-resolver.js';
import { getAntigravityPaths } from './paths.js';
import {
  ensureProjectConfigExists,
  findCanonicalProject,
  getConversationStorageSubpath,
  getLocalProjectsWithDetails,
} from './projects.js';
import { syncAgyhubProtoFromDb } from './proto-sync.js';
import { AntigravitySqlite } from './sqlite.js';
import { GoogleDriveStorageProvider, SyncStorageProvider } from './storage.js';
import { DeviceInfo, RemoteWorkspaceEntry, SessionTombstone } from './types.js';
import { WorkspaceManager } from './workspace.js';

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
  deleted?: boolean;
  deleted_at?: string;
}

export interface RemoteIndex {
  version: number;
  updated_at: string;
  device_id: string;
  device_name: string;
  sessions: Record<string, RemoteSessionEntry>;
  workspaces?: Record<string, RemoteWorkspaceEntry>;
  tombstones?: Record<string, TombstoneEntry>;
}


export interface SyncCycleResult {
  pushed: string[];
  restored: string[];
  skipped: string[];
  devices: DeviceInfo[];
  pushedWorkspaces?: string[];
  restoredWorkspaces?: string[];
  skippedWorkspaces?: string[];
  deletedSessions?: string[];
}

const LEGACY_INDEX_FILE = 'synchronum_index.json.enc';

export class SynchronumSyncEngine {
  private storage: SyncStorageProvider;
  private bundler: SynchronumBundler;
  private sqlite: AntigravitySqlite;
  private tombstones = new TombstoneManager();
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
    return config.deviceName || getDefaultDeviceName();
  }

  public getStorageProvider(): SyncStorageProvider {
    return this.storage;
  }

  private getTombstonesFilePath(): string {
    return path.join(this.paths.root, 'synchronum_tombstones.json');
  }

  public getLocalTombstones(): Record<string, SessionTombstone> {
    const f = this.getTombstonesFilePath();
    if (fs.existsSync(f)) {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {}
    }
    return {};
  }

  public saveLocalTombstones(tombstones: Record<string, SessionTombstone>): void {
    const f = this.getTombstonesFilePath();
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(tombstones, null, 2), 'utf8');
    } catch {}
  }

  public markSessionDeleted(conversationId: string, title?: string): void {
    const tombstones = this.getLocalTombstones();
    tombstones[conversationId] = {
      conversation_id: conversationId,
      deleted_at: new Date().toISOString(),
      title: title || conversationId,
      author_device: this.getDeviceName(),
    };
    this.saveLocalTombstones(tombstones);
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

  private getDeviceWorkspacePath(deviceId: string, projectId: string, projectName: string): string {
    const safeProject = projectName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'project';
    return `devices/${deviceId}/workspaces/${safeProject}_${projectId}.workspace.enc`;
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
        workspaces: {},
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
        tombstones: parsed.tombstones || {},
        workspaces: parsed.workspaces || {},
      };

    } catch {
      throw new Error('Поврежденный файл индекса устройства.');
    }
  }


  public async saveDeviceIndex(deviceId: string, index: RemoteIndex, password: string): Promise<string> {
    index.updated_at = new Date().toISOString();
    index.device_id = deviceId;
    index.device_name = this.getDeviceName();
    index.tombstones = this.tombstones.getLocalTombstones();

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

  public async pushWorkspace(
    projectId: string,
    password: string
  ): Promise<{ projectId: string; projectName: string; hash: string; bytes: number }> {
    const deviceId = this.getDeviceId();
    const projects = getLocalProjectsWithDetails();
    const project = projects.find((p) => p.id === projectId) || projects.find((p) => p.name === projectId);
    if (!project || !project.folderExists) {
      throw new Error(`Воркспейс не найден или директория не существует: ${projectId}`);
    }

    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });
    const safeName = project.name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'project';
    const bundlePath = path.join(tempDir, `${safeName}_${project.id}.workspace.enc`);

    try {
      const exportResult = await WorkspaceManager.exportWorkspace(project.localPath, bundlePath, {
        projectId: project.id,
        projectName: project.name,
        password,
      });

      const buffer = fs.readFileSync(bundlePath);
      const remoteFileName = this.getDeviceWorkspacePath(deviceId, project.id, project.name);
      const fileId = await this.storage.uploadFile(remoteFileName, buffer);

      const index = await this.fetchDeviceIndex(deviceId, password);
      if (!index.workspaces) index.workspaces = {};

      index.workspaces[project.id] = {
        project_id: project.id,
        project_name: project.name,
        workspace_hash: exportResult.meta.workspace_hash,
        file_name: remoteFileName,
        file_id: fileId,
        size_bytes: buffer.length,
        file_count: exportResult.meta.file_count,
        updated_at: new Date().toISOString(),
        author_device: `${this.getDeviceName()} (${os.hostname()})`,
      };

      await this.saveDeviceIndex(deviceId, index, password);

      return {
        projectId: project.id,
        projectName: project.name,
        hash: exportResult.meta.workspace_hash,
        bytes: buffer.length,
      };
    } finally {
      if (fs.existsSync(bundlePath)) {
        try {
          fs.unlinkSync(bundlePath);
        } catch {}
      }
    }
  }

  // Safe two-way sync: sessions + non-git workspaces + tombstones (deleted items)
  public async syncAll(password: string): Promise<SyncCycleResult> {
    const myId = this.getDeviceId();
    const pushed: string[] = [];
    const restored: string[] = [];
    const skipped: string[] = [];
    const pushedWorkspaces: string[] = [];
    const restoredWorkspaces: string[] = [];
    const skippedWorkspaces: string[] = [];
    const deletedSessions: string[] = [];

    const myIndex = await this.fetchDeviceIndex(myId, password);
    if (!myIndex.workspaces) myIndex.workspaces = {};

    // 1. Reconcile local deletions and tombstones
    const localSummaries = this.sqlite.listSummaries(1000);
    const localMap = new Map(localSummaries.map((s) => [s.conversation_id, s]));
    const tombstones = this.getLocalTombstones();

    // Any session previously registered in myIndex that is now gone from SQLite was deleted by the user!
    for (const [id, entry] of Object.entries(myIndex.sessions)) {
      if (!entry.deleted && !localMap.has(id)) {
        entry.deleted = true;
        entry.deleted_at = new Date().toISOString();
        tombstones[id] = {
          conversation_id: id,
          deleted_at: entry.deleted_at,
          title: entry.title,
          author_device: this.getDeviceName(),
        };
      }
    }
    this.saveLocalTombstones(tombstones);

    // 2. Phase 1: Publish Own Sessions to devices/<myId>/
    for (const local of localSummaries) {
      if (this.tombstones.isDeleted(local.conversation_id) || tombstones[local.conversation_id]) {
        this.tombstones.purgeLocalConversation(local.conversation_id);
        continue;
      }


      const entry = myIndex.sessions[local.conversation_id];
      const localMod = new Date(local.last_modified_time || 0).getTime();
      const remoteMod = entry ? new Date(entry.last_modified_time || 0).getTime() : 0;

      // Push if missing or updated locally
      if (!entry || entry.deleted || localMod > remoteMod || local.step_count > (entry.step_count || 0)) {
        try {
          const res = await this.pushSession(local.conversation_id, password);
          pushed.push(res.title || local.conversation_id);
        } catch (e: any) {
          console.error(`[Sync] Error pushing ${local.conversation_id}:`, e.message);
        }
      }
    }

    // 3. Phase 1B: Publish Non-Git Workspaces to devices/<myId>/workspaces/
    const localProjects = getLocalProjectsWithDetails();
    for (const p of localProjects) {
      if (!p.gitRemote && p.folderExists) {
        try {
          const scan = WorkspaceManager.scanWorkspace(p.localPath);
          if (scan.fileCount > 0) {
            const currentRemoteWs = myIndex.workspaces[p.id];
            if (!currentRemoteWs || currentRemoteWs.workspace_hash !== scan.hash) {
              const res = await this.pushWorkspace(p.id, password);
              pushedWorkspaces.push(`${res.projectName} (хэш: ${res.hash})`);
            }
          }
        } catch (e: any) {
          console.error(`[Sync] Error pushing workspace ${p.name}:`, e.message);
        }
      }
    }

    await this.saveDeviceIndex(myId, myIndex, password);

    // 4. Phase 2: Pull & Merge from OTHER devices
    const allDeviceIds = await this.storage.listDevices();
    const tempDir = path.join(os.tmpdir(), 'synchronum');
    fs.mkdirSync(tempDir, { recursive: true });

    let dbChanged = false;

    for (const otherId of allDeviceIds) {
      if (otherId === myId) continue; // Skip own device

      let otherIndex: RemoteIndex | null = null;
      try {
        otherIndex = await this.fetchDeviceIndex(otherId, password);
      } catch (err: any) {
        console.warn(`[Sync] Could not read index for device ${otherId}:`, err.message);
        continue;
      }

      // Merge remote tombstones
      if (otherIndex.tombstones) {
        this.tombstones.mergeRemoteTombstones(otherIndex.tombstones);
      }

      // 4A. Merge Sessions & Tombstones
      for (const [id, remoteEntry] of Object.entries(otherIndex.sessions)) {
        if (remoteEntry.deleted || this.tombstones.isDeleted(id, remoteEntry.last_modified_time)) {
          const delTime = remoteEntry.deleted_at || remoteEntry.updated_at || new Date().toISOString();
          this.tombstones.recordLocalTombstone(id, remoteEntry.title);
          tombstones[id] = {
            conversation_id: id,
            deleted_at: delTime,
            title: remoteEntry.title,
            author_device: otherIndex.device_name || otherId,
          };
          if (myIndex.sessions[id]) {
            myIndex.sessions[id].deleted = true;
            myIndex.sessions[id].deleted_at = delTime;
          }

          if (localMap.has(id)) {
            const local = localMap.get(id)!;
            const localMod = new Date(local.last_modified_time || 0).getTime();
            const delTimestamp = new Date(delTime).getTime();
            if (localMod <= delTimestamp || !remoteEntry.deleted_at) {
              this.tombstones.purgeLocalConversation(id);
              localMap.delete(id);
              deletedSessions.push(remoteEntry.title || id);
              dbChanged = true;
            }
          }
          continue;
        }


        // If local tombstones say this session was deleted, skip restore
        if (tombstones[id]) {
          const delTime = new Date(tombstones[id].deleted_at).getTime();
          const remoteMod = new Date(remoteEntry.last_modified_time || 0).getTime();
          if (remoteMod <= delTime) {
            skipped.push(remoteEntry.title || id);
            continue;
          }
        }

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
          dbChanged = true;
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

      // 4B. Merge Workspaces (non-git projects)
      if (otherIndex.workspaces) {
        for (const [projId, remoteWs] of Object.entries(otherIndex.workspaces)) {
          if (remoteWs.deleted) continue;

          // Find if this project corresponds to a local project
          const canonical = findCanonicalProject(remoteWs.project_name, undefined, undefined, projId, localProjects);

          // If canonical project has git remote, let git handle files
          if (canonical && canonical.gitRemote) {
            continue;
          }

          let targetFolder = canonical && canonical.localPath ? canonical.localPath : '';
          if (!targetFolder) {
            const desktopDir = path.join(os.homedir(), 'Desktop');
            targetFolder = path.join(desktopDir, remoteWs.project_name);
          }

          let localScan: any = null;
          if (fs.existsSync(targetFolder)) {
            try {
              localScan = WorkspaceManager.scanWorkspace(targetFolder);
            } catch {}
          }

          if (localScan && localScan.hash === remoteWs.workspace_hash) {
            skippedWorkspaces.push(`${remoteWs.project_name} (актуален)`);
            continue;
          }

          const tempWsFile = path.join(tempDir, `${projId}.ws.download.enc`);
          try {
            const data = await this.storage.downloadFile(remoteWs.file_id || remoteWs.file_name);
            fs.writeFileSync(tempWsFile, data);

            const importRes = await WorkspaceManager.importWorkspace(tempWsFile, targetFolder, {
              password,
              backup: true,
              safeProjectName: remoteWs.project_name,
            });

            const primaryUri = PathResolver.pathToUri(targetFolder);
            ensureProjectConfigExists(projId, remoteWs.project_name, primaryUri);

            restoredWorkspaces.push(`${remoteWs.project_name} (хэш: ${importRes.meta.workspace_hash})`);
          } catch (err: any) {
            console.error(`[Sync] Error restoring workspace ${remoteWs.project_name} from ${otherId}:`, err.message);
          } finally {
            if (fs.existsSync(tempWsFile)) {
              try {
                fs.unlinkSync(tempWsFile);
              } catch {}
            }
          }
        }
      }
    }

    this.saveLocalTombstones(tombstones);
    await this.saveDeviceIndex(myId, myIndex, password);

    const devices = await this.listAllDevices(password);

    if (dbChanged) {
      try {
        syncAgyhubProtoFromDb(this.paths.summariesDbPath, this.paths.agyhubProtoPath);
      } catch (e: any) {
        console.warn('[Proto Sync Warning]', e.message);
      }
    }

    return {
      pushed,
      restored,
      skipped,
      devices,
      pushedWorkspaces,
      restoredWorkspaces,
      skippedWorkspaces,
      deletedSessions,
    };
  }

  public async deleteSession(
    conversationId: string,
    password?: string
  ): Promise<{ success: boolean; conversationId: string; title: string }> {
    const myId = this.getDeviceId();
    const result = await this.tombstones.deleteEverywhere(conversationId, this.storage, myId);

    // Update own index on storage if password available
    if (password) {
      try {
        const index = await this.fetchDeviceIndex(myId, password);
        delete index.sessions[conversationId];
        await this.saveDeviceIndex(myId, index, password);
      } catch (err: any) {
        console.warn('[Delete Remote Index Warning]', err.message);
      }
    }

    return result;
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

