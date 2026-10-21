import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  machineId?: string;
  tombstones?: Record<string, any>;
}

const CONFIG_FILE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'synchronum_config.json');

export function getMachineId(): string {
  // 1. Windows MachineGuid
  if (process.platform === 'win32') {
    try {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {}
  }

  // 2. Linux /etc/machine-id
  if (process.platform === 'linux') {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        if (fs.existsSync(p)) {
          const val = fs.readFileSync(p, 'utf-8').trim();
          if (val) return val;
        }
      } catch {}
    }
  }

  // 3. macOS IOPlatformUUID
  if (process.platform === 'darwin') {
    try {
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {}
  }

  // 4. Stable Fallback: hash of network interfaces MAC + hostname
  try {
    const interfaces = os.networkInterfaces();
    const macs: string[] = [];
    for (const name of Object.keys(interfaces).sort()) {
      for (const iface of interfaces[name] || []) {
        if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac.toLowerCase());
        }
      }
    }
    if (macs.length > 0) {
      return crypto.createHash('sha256').update(macs.join(',') + ':' + os.hostname()).digest('hex').substring(0, 32);
    }
  } catch {}

  return os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_');
}

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
  return os.hostname();
}

export function renameDevice(newName: string): SynchronumConfig {
  if (!newName || !newName.trim()) {
    throw new Error('Имя устройства не может быть пустым');
  }
  return saveConfig({ deviceName: newName.trim() });
}

export function adoptDevice(deviceId: string, deviceName?: string): SynchronumConfig {
  const updates: Partial<SynchronumConfig> = { deviceId };
  if (deviceName && deviceName.trim()) {
    updates.deviceName = deviceName.trim();
  }
  return saveConfig(updates);
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
    machineId: getMachineId(),
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
      machineId: parsed.machineId || getMachineId(),
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
    machineId: updates.machineId || current.machineId || getMachineId(),
  };

  fs.mkdirSync(path.dirname(CONFIG_FILE_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return merged;
}
