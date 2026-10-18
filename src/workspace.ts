import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.js';
import { getAntigravityPaths } from './paths.js';
import { WorkspaceMeta } from './types.js';

export const DEFAULT_WORKSPACE_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.idea',
  '.vscode',
  '.gemini',
  '.synchronum',
  '.next',
  '.nuxt',
  '.turbo',
  'coverage',
  '.DS_Store',
  'Thumbs.db',
  '*.pyc',
  '*.pyo',
  '*.log',
  '*.tmp',
  '*.swp',
  '*.bundle',
  '*.bundle.enc',
  '*.workspace.enc',
];

export interface WorkspaceScanResult {
  hash: string;
  fileCount: number;
  totalBytes: number;
  files: { relPath: string; fullPath: string; size: number; mtime: number }[];
}

export class WorkspaceManager {
  private static parseGitignore(folderPath: string): string[] {
    const gitignorePath = path.join(folderPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      return content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch {
      return [];
    }
  }

  private static matchesPattern(relPath: string, pattern: string): boolean {
    const cleanPattern = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    const normPath = relPath.replace(/\\/g, '/');

    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      return normPath.endsWith(ext);
    }

    if (normPath === cleanPattern || normPath.startsWith(cleanPattern + '/') || normPath.includes('/' + cleanPattern + '/')) {
      return true;
    }

    const segments = normPath.split('/');
    return segments.includes(cleanPattern);
  }

  private static isIgnored(relPath: string, customIgnores: string[]): boolean {
    const allPatterns = [...DEFAULT_WORKSPACE_IGNORES, ...customIgnores];
    for (const pattern of allPatterns) {
      if (this.matchesPattern(relPath, pattern)) {
        return true;
      }
    }
    return false;
  }

  public static scanWorkspace(folderPath: string): WorkspaceScanResult {
    if (!fs.existsSync(folderPath)) {
      return { hash: '', fileCount: 0, totalBytes: 0, files: [] };
    }

    const customIgnores = this.parseGitignore(folderPath);
    const files: { relPath: string; fullPath: string; size: number; mtime: number }[] = [];
    let totalBytes = 0;

    const walk = (currentDir: string, currentRel = '') => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(currentDir, entry.name);
        const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;

        if (this.isIgnored(rel, customIgnores)) {
          continue;
        }

        if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            files.push({
              relPath: rel,
              fullPath: full,
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs),
            });
            totalBytes += stat.size;
          } catch {}
        } else if (entry.isDirectory()) {
          walk(full, rel);
        }
      }
    };

    walk(folderPath);

    // Sort deterministically
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));

    // Calculate content hash
    const hashSum = crypto.createHash('sha256');
    for (const f of files) {
      hashSum.update(`${f.relPath}:${f.size}:${f.mtime}\n`);
      // For files under 2MB, hash actual file contents for cryptographic certainty
      if (f.size <= 2 * 1024 * 1024) {
        try {
          const content = fs.readFileSync(f.fullPath);
          hashSum.update(content);
        } catch {}
      }
    }

    const hash = hashSum.digest('hex').slice(0, 16);

    return {
      hash,
      fileCount: files.length,
      totalBytes,
      files,
    };
  }

  public static async exportWorkspace(
    folderPath: string,
    outputPath: string,
    meta: { projectId: string; projectName: string; password?: string }
  ): Promise<{
    meta: WorkspaceMeta;
    outputPath: string;
    bytes: number;
    encrypted: boolean;
  }> {
    const scan = this.scanWorkspace(folderPath);
    if (scan.fileCount === 0 && !fs.existsSync(folderPath)) {
      throw new Error(`Воркспейс не существует или пуст: ${folderPath}`);
    }

    const workspaceMeta: WorkspaceMeta = {
      project_id: meta.projectId,
      project_name: meta.projectName,
      workspace_hash: scan.hash,
      file_count: scan.fileCount,
      total_bytes: scan.totalBytes,
      last_modified_time: new Date().toISOString(),
      author_device: `${os.hostname()} (${os.platform()})`,
    };

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(workspaceMeta, null, 2), 'utf-8'));

    // Add all files
    for (const f of scan.files) {
      try {
        const fileData = fs.readFileSync(f.fullPath);
        const zipDir = path.dirname(f.relPath);
        const zipFileName = path.basename(f.relPath);
        zip.addFile(f.relPath, fileData);
      } catch (err: any) {
        console.warn(`[Workspace Export] Skipping ${f.relPath}:`, err.message);
      }
    }

    let buffer = zip.toBuffer();
    let isEncrypted = false;

    if (meta.password) {
      buffer = encryptBuffer(buffer, meta.password);
      isEncrypted = true;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);

    return {
      meta: workspaceMeta,
      outputPath,
      bytes: buffer.length,
      encrypted: isEncrypted,
    };
  }

  public static async importWorkspace(
    archivePathOrBuffer: string | Buffer,
    targetFolderPath: string,
    options: {
      password?: string;
      backup?: boolean;
      safeProjectName?: string;
    } = {}
  ): Promise<{
    meta: WorkspaceMeta;
    filesRestored: number;
    backupPath?: string;
  }> {
    let buffer: Buffer;
    if (typeof archivePathOrBuffer === 'string') {
      if (!fs.existsSync(archivePathOrBuffer)) {
        throw new Error(`Файл архива не найден: ${archivePathOrBuffer}`);
      }
      buffer = fs.readFileSync(archivePathOrBuffer);
    } else {
      buffer = archivePathOrBuffer;
    }

    if (isEncryptedBuffer(buffer)) {
      if (!options.password) {
        throw new Error('Архив воркспейса зашифрован. Требуется мастер-пароль!');
      }
      buffer = decryptBuffer(buffer, options.password);
    }

    const zip = new AdmZip(buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
      throw new Error('Некорректный архив воркспейса: отсутствует manifest.json');
    }

    const meta: WorkspaceMeta = JSON.parse(manifestEntry.getData().toString('utf-8'));

    // Step 1: Backup existing local workspace if it has files
    let backupPath: string | undefined;
    if (options.backup !== false && fs.existsSync(targetFolderPath)) {
      try {
        const currentScan = this.scanWorkspace(targetFolderPath);
        if (currentScan.fileCount > 0) {
          backupPath = this.createLocalBackup(
            targetFolderPath,
            options.safeProjectName || meta.project_name || 'project',
            currentScan.hash
          );
        }
      } catch (err: any) {
        console.warn('[Workspace Backup Warning]', err.message);
      }
    }

    // Step 2: Unpack files into target folder
    fs.mkdirSync(targetFolderPath, { recursive: true });
    let filesRestored = 0;

    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName === 'manifest.json' || entry.isDirectory) continue;

      const destPath = path.join(targetFolderPath, entry.entryName);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      filesRestored++;
    }

    return {
      meta,
      filesRestored,
      backupPath,
    };
  }

  public static createLocalBackup(
    folderPath: string,
    safeProjectName: string,
    currentHash: string
  ): string {
    const paths = getAntigravityPaths();
    const cleanName = safeProjectName.replace(/[<>:"/\\|?*]/g, '_').trim() || 'project';
    const backupDir = path.join(paths.root, 'backups', 'workspaces', cleanName);
    fs.mkdirSync(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `backup_${timestamp}_${currentHash}.zip`);

    const scan = this.scanWorkspace(folderPath);
    const zip = new AdmZip();
    for (const f of scan.files) {
      try {
        zip.addFile(f.relPath, fs.readFileSync(f.fullPath));
      } catch {}
    }
    zip.writeZip(backupFile);

    // Prune old backups, keep last 5
    this.pruneBackups(backupDir, 5);

    return backupFile;
  }

  private static pruneBackups(backupDir: string, keepCount: number): void {
    try {
      if (!fs.existsSync(backupDir)) return;
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith('.zip'))
        .map((f) => ({
          name: f,
          full: path.join(backupDir, f),
          time: fs.statSync(path.join(backupDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length > keepCount) {
        for (let i = keepCount; i < files.length; i++) {
          try {
            fs.unlinkSync(files[i].full);
          } catch {}
        }
      }
    } catch {}
  }
}
