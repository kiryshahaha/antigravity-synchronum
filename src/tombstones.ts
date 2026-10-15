import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { getAntigravityPaths } from './paths.js';
import { syncAgyhubProtoFromDb } from './proto-sync.js';
import { AntigravitySqlite } from './sqlite.js';
import { SyncStorageProvider } from './storage.js';

export interface TombstoneEntry {
  conversation_id: string;
  deleted_at: string;
  deleted_by_device: string;
  project_name?: string;
  title?: string;
}

export class TombstoneManager {
  private paths = getAntigravityPaths();
  private sqlite = new AntigravitySqlite(this.paths.summariesDbPath);

  public getLocalTombstones(): Record<string, TombstoneEntry> {
    const config: any = loadConfig();
    return config.tombstones || {};
  }

  public recordLocalTombstone(conversationId: string, title?: string, projectName?: string): TombstoneEntry {
    const config: any = loadConfig();
    const tombstones: Record<string, TombstoneEntry> = config.tombstones || {};

    const entry: TombstoneEntry = {
      conversation_id: conversationId,
      deleted_at: new Date().toISOString(),
      deleted_by_device: config.deviceName || os.hostname(),
      project_name: projectName,
      title: title,
    };

    tombstones[conversationId] = entry;
    saveConfig({ tombstones } as any);
    return entry;
  }

  public isDeleted(conversationId: string, lastModifiedIso?: string): boolean {
    const tombstones = this.getLocalTombstones();
    const entry = tombstones[conversationId];
    if (!entry) return false;

    if (!lastModifiedIso) return true;
    const deletedTime = new Date(entry.deleted_at).getTime();
    const modifiedTime = new Date(lastModifiedIso).getTime();
    return deletedTime >= modifiedTime;
  }

  public mergeRemoteTombstones(remoteTombstones: Record<string, TombstoneEntry>): void {
    if (!remoteTombstones || Object.keys(remoteTombstones).length === 0) return;

    const config: any = loadConfig();
    const local: Record<string, TombstoneEntry> = config.tombstones || {};
    let changed = false;

    for (const [id, r] of Object.entries(remoteTombstones)) {
      if (!local[id] || new Date(r.deleted_at).getTime() > new Date(local[id].deleted_at).getTime()) {
        local[id] = r;
        changed = true;
      }
    }

    if (changed) {
      saveConfig({ tombstones: local } as any);
    }
  }

  public purgeLocalConversation(conversationId: string): { success: boolean; filesRemoved: number } {
    let filesRemoved = 0;

    // 1. Remove from SQLite conversation_summaries.db
    try {
      this.sqlite.deleteSummary(conversationId);
      filesRemoved++;
    } catch {}

    // 2. Remove conversations/<id>.db / .pb / wal / shm
    const convoFiles = [
      path.join(this.paths.conversationsDir, `${conversationId}.db`),
      path.join(this.paths.conversationsDir, `${conversationId}.db-wal`),
      path.join(this.paths.conversationsDir, `${conversationId}.db-shm`),
      path.join(this.paths.conversationsDir, `${conversationId}.pb`),
    ];

    for (const f of convoFiles) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
          filesRemoved++;
        } catch {}
      }
    }

    // 3. Remove brain/<id>/
    const brainDir = path.join(this.paths.brainDir, conversationId);
    if (fs.existsSync(brainDir)) {
      try {
        fs.rmSync(brainDir, { recursive: true, force: true });
        filesRemoved++;
      } catch {}
    }

    // 4. Remove annotations/<id>.pbtxt
    const annotationPath = path.join(this.paths.annotationsDir, `${conversationId}.pbtxt`);
    if (fs.existsSync(annotationPath)) {
      try {
        fs.unlinkSync(annotationPath);
        filesRemoved++;
      } catch {}
    }

    // 5. Update agyhub_summaries_proto.pb
    try {
      syncAgyhubProtoFromDb(this.paths.summariesDbPath, this.paths.agyhubProtoPath);
    } catch {}

    return { success: true, filesRemoved };
  }

  public async deleteEverywhere(
    conversationId: string,
    storage: SyncStorageProvider,
    deviceId: string
  ): Promise<{ success: boolean; conversationId: string; title: string }> {
    const summary = this.sqlite.getSummary(conversationId);
    const title = summary?.title || summary?.preview || conversationId;

    // 1. Record Tombstone locally
    this.recordLocalTombstone(conversationId, title);

    // 2. Remove locally
    this.purgeLocalConversation(conversationId);

    // 3. Delete from remote storage device directory if present
    try {
      const files = await storage.listFiles(`devices/${deviceId}`);
      for (const f of files) {
        if (f.name.includes(conversationId)) {
          await storage.deleteFile(f.id);
        }
      }
    } catch {}

    return { success: true, conversationId, title };
  }
}
