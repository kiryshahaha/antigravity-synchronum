import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SynchronumConfig {
  storageType: 'gdrive' | 'local_folder';
  localFolderPath: string;
  autoSync: boolean;
  autoSyncIntervalMinutes: number;
  lastSyncTime?: string;
  autostartService: boolean;
  masterPassword?: string;
  deviceId?: string;
  deviceName?: string;
}

const CONFIG_FILE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'synchronum_config.json');

export function getDefaultDeviceId(): string {
  return os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getDefaultLocalFolderPath(): string {
  // Check common Google Drive virtual drive or user folder
  const possiblePaths = [
    'G:\\Мой диск\\AntigravitySync',
    'G:\\My Drive\\AntigravitySync',
    path.join(os.homedir(), 'Google Drive', 'AntigravitySync'),
    path.join(os.homedir(), 'Google Диск', 'AntigravitySync'),
    path.join(os.homedir(), 'AntigravitySync'),
  ];

  for (const p of possiblePaths) {
    const parent = path.dirname(p);
    if (fs.existsSync(parent)) {
      return p;
    }
  }

  return path.join(os.homedir(), 'AntigravitySync');
}

export function getDefaultDeviceName(): string {
  const host = os.hostname().toLowerCase();
  if (host.includes('laptop')) return 'Laptop-Work';
  if (host.includes('desktop') || host.includes('pc')) return 'Home-PC';
  return os.hostname();
}

export function getDefaultConfig(): SynchronumConfig {
  return {
    storageType: 'local_folder',
    localFolderPath: getDefaultLocalFolderPath(),
    autoSync: true,
    autoSyncIntervalMinutes: 5,
    autostartService: false,
    deviceId: getDefaultDeviceId(),
    deviceName: getDefaultDeviceName(),
  };
}

export function loadConfig(): SynchronumConfig {
  const defaults = getDefaultConfig();
  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      ...defaults,
      ...parsed,
    };
  } catch {
    return defaults;
  }
}

export function saveConfig(updates: Partial<SynchronumConfig>): SynchronumConfig {
  const current = loadConfig();
  const merged: SynchronumConfig = {
    ...current,
    ...updates,
  };

  fs.mkdirSync(path.dirname(CONFIG_FILE_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return merged;
}
