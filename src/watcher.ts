import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { getAntigravityPaths } from './paths.js';
import { AntigravitySqlite } from './sqlite.js';
import { SynchronumSyncEngine } from './sync.js';

export interface WatcherOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  onPush?: (count: number) => void;
  onPull?: (count: number) => void;
}

export class SynchronumWatcher {
  private syncEngine: SynchronumSyncEngine;
  private paths = getAntigravityPaths();
  private sqlite: AntigravitySqlite;
  private isSyncing = false;
  private pushTimer: NodeJS.Timeout | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private processCheckInterval: NodeJS.Timeout | null = null;
  private localFsWatcher: fs.FSWatcher | null = null;
  private lastRemoteMtimes: Map<string, number> = new Map();
  private wasAntigravityRunning = false;
  private isShuttingDown = false;

  constructor(syncEngine: SynchronumSyncEngine) {
    this.syncEngine = syncEngine;
    this.sqlite = new AntigravitySqlite(this.paths.summariesDbPath);
  }

  private isAntigravityProcessRunning(): boolean {
    if (process.platform === 'win32') {
      try {
        const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        return out.includes('Antigravity.exe');
      } catch {
        return false;
      }
    } else {
      try {
        const out = execSync('pgrep -x "Antigravity" || true', { encoding: 'utf-8' });
        return out.trim().length > 0;
      } catch {
        return false;
      }
    }
  }

  public async flushImmediately(): Promise<void> {
    const config = loadConfig();
    if (!config.masterPassword) return;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      // Checkpoint WAL
      this.sqlite.checkpoint();

      console.log('[Synchronum Flush] Flushing all local session changes to storage...');
      const result = await this.syncEngine.syncAll(config.masterPassword);
      console.log(
        `[Synchronum Flush] Done: Pushed ${result.pushed.length}, Restored ${result.restored.length}, Skipped ${result.skipped.length}`
      );
    } catch (err: any) {
      console.error('[Synchronum Flush Error]', err.message);
    } finally {
      this.isSyncing = false;
    }
  }

  public start(options: WatcherOptions = {}): void {
    const debounceMs = options.debounceMs || 3000;
    const pollIntervalMs = options.pollIntervalMs || 10000;

    // 1. Initial process state check
    this.wasAntigravityRunning = this.isAntigravityProcessRunning();

    // 2. Watch local conversations directory
    try {
      if (fs.existsSync(this.paths.conversationsDir)) {
        this.localFsWatcher = fs.watch(
          this.paths.conversationsDir,
          { recursive: false },
          (eventType, filename) => {
            if (this.isShuttingDown) return;
            if (!filename) return;

            // Trigger on database changes (.db or .db-wal)
            if (filename.endsWith('.db') || filename.endsWith('.db-wal') || filename.endsWith('.pb')) {
              this.scheduleDebouncedPush(debounceMs, options.onPush);
            }
          }
        );
      }
    } catch (err: any) {
      console.warn('[Watcher] Could not attach fs.watch to conversationsDir:', err.message);
    }

    // 3. Remote storage change polling (detects updates from other devices)
    this.pollInterval = setInterval(async () => {
      if (this.isShuttingDown || this.isSyncing) return;
      await this.checkRemoteChanges(options.onPull);
    }, pollIntervalMs);

    // 4. Antigravity Process Lifecycle Watcher (On-Close Hook)
    this.processCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      const isRunning = this.isAntigravityProcessRunning();
      if (this.wasAntigravityRunning && !isRunning) {
        console.log('[On-Close] Antigravity IDE exit detected! Running final auto-flush...');
        this.wasAntigravityRunning = false;
        await this.flushImmediately();
      } else if (!this.wasAntigravityRunning && isRunning) {
        this.wasAntigravityRunning = true;
      }
    }, 3000);

    // 5. Node Process Exit Hooks (SIGINT, SIGTERM, beforeExit)
    const cleanupAndFlush = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      console.log(`[Shutdown Hook] Received ${signal}. Flushing final changes before exit...`);
      await this.flushImmediately();
      process.exit(0);
    };

    process.once('SIGINT', () => cleanupAndFlush('SIGINT'));
    process.once('SIGTERM', () => cleanupAndFlush('SIGTERM'));

    console.log(`[Synchronum Watcher] Active: local debounce ${debounceMs}ms, remote poll ${pollIntervalMs}ms`);
  }

  private scheduleDebouncedPush(debounceMs: number, onPush?: (count: number) => void): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }

    this.pushTimer = setTimeout(async () => {
      this.pushTimer = null;
      if (this.isSyncing) return;

      const config = loadConfig();
      if (!config.masterPassword) return;

      this.isSyncing = true;
      try {
        this.sqlite.checkpoint();
        console.log('[Auto-Watch] Local conversation modified. Pushing changes...');
        const result = await this.syncEngine.syncAll(config.masterPassword);
        if (result.pushed.length > 0) {
          console.log(`[Auto-Watch] Automatically pushed ${result.pushed.length} sessions to cloud.`);
          if (onPush) onPush(result.pushed.length);
        }
      } catch (err: any) {
        console.warn('[Auto-Watch Error]', err.message);
      } finally {
        this.isSyncing = false;
      }
    }, debounceMs);
  }

  private async checkRemoteChanges(onPull?: (count: number) => void): Promise<void> {
    const config = loadConfig();
    if (!config.masterPassword) return;

    try {
      const storage = this.syncEngine.getStorageProvider();
      const deviceIds = await storage.listDevices();
      const myId = this.syncEngine.getDeviceId();

      let hasRemoteUpdates = false;

      for (const id of deviceIds) {
        if (id === myId) continue;

        const indexPath = `devices/${id}/index.json.enc`;
        let mtime = 0;

        // If local folder storage, check file stats directly
        if ('resolvePath' in storage && typeof (storage as any).resolvePath === 'function') {
          const fullPath = (storage as any).resolvePath(indexPath);
          if (fs.existsSync(fullPath)) {
            mtime = fs.statSync(fullPath).mtimeMs;
          }
        } else {
          // If remote cloud, check file metadata
          const files = await storage.listFiles(`devices/${id}`);
          const idxFile = files.find((f) => f.name.endsWith('index.json.enc'));
          if (idxFile && idxFile.modifiedTime) {
            mtime = new Date(idxFile.modifiedTime).getTime();
          }
        }

        const prev = this.lastRemoteMtimes.get(id) || 0;
        if (mtime > 0 && mtime > prev) {
          if (prev > 0) {
            hasRemoteUpdates = true;
          }
          this.lastRemoteMtimes.set(id, mtime);
        }
      }

      if (hasRemoteUpdates) {
        console.log('[Remote-Watch] New remote changes detected! Syncing...');
        this.isSyncing = true;
        try {
          const result = await this.syncEngine.syncAll(config.masterPassword);
          console.log(`[Remote-Watch] Auto-sync complete: Restored ${result.restored.length} sessions.`);
          if (onPull) onPull(result.restored.length);
        } finally {
          this.isSyncing = false;
        }
      }
    } catch {}
  }

  public stop(): void {
    this.isShuttingDown = true;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.processCheckInterval) clearInterval(this.processCheckInterval);
    if (this.localFsWatcher) {
      this.localFsWatcher.close();
      this.localFsWatcher = null;
    }
  }
}
