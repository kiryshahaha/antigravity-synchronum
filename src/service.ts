import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from './config.js';

const SERVICE_PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '42125', 10);

export function getStartupScriptPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const startupFolder = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return path.join(startupFolder, 'Synchronum.vbs');
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.antigravity.synchronum.plist');
  }

  return path.join(os.homedir(), '.config', 'autostart', 'synchronum.desktop');
}

export function isServiceInstalled(): boolean {
  return fs.existsSync(getStartupScriptPath());
}

export async function isServiceRunning(port = SERVICE_PORT): Promise<{ running: boolean; pid?: number; port: number }> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/status`, { timeout: 1500 }, (res) => {
      if (res.statusCode === 200) {
        resolve({ running: true, port });
      } else {
        resolve({ running: false, port });
      }
    });

    req.on('error', () => {
      resolve({ running: false, port });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, port });
    });
  });
}

export async function installService(customRepoRoot?: string): Promise<{ success: boolean; scriptPath: string }> {
  const repoRoot = customRepoRoot || process.cwd();
  const scriptPath = getStartupScriptPath();
  const platform = process.platform;

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });

  if (platform === 'win32') {
    // Silent VBScript launcher - 0 windows, runs completely in background
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.CurrentDirectory = "${repoRoot.replace(/\\/g, '\\\\')}"`,
      'WshShell.Run "cmd /c node --experimental-sqlite ./dist/sidecar-server.js", 0, False',
    ].join('\r\n');

    fs.writeFileSync(scriptPath, vbsContent, 'utf-8');
  } else if (platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.antigravity.synchronum</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>--experimental-sqlite</string>
    <string>${path.join(repoRoot, 'dist', 'sidecar-server.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
    fs.writeFileSync(scriptPath, plist, 'utf-8');
  } else {
    const desktop = `[Desktop Entry]
Type=Application
Exec=node --experimental-sqlite ${path.join(repoRoot, 'dist', 'sidecar-server.js')}
Path=${repoRoot}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Name=Synchronum
Comment=Antigravity 2.0 Session Sync
`;
    fs.writeFileSync(scriptPath, desktop, 'utf-8');
  }

  saveConfig({ autostartService: true });

  // Start immediately if not already running
  const status = await isServiceRunning();
  if (!status.running) {
    await startService(repoRoot);
  }

  return { success: true, scriptPath };
}

export async function uninstallService(): Promise<{ success: boolean }> {
  const scriptPath = getStartupScriptPath();
  if (fs.existsSync(scriptPath)) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {}
  }

  saveConfig({ autostartService: false });
  await stopService();

  return { success: true };
}

export async function startService(customRepoRoot?: string): Promise<boolean> {
  const repoRoot = customRepoRoot || process.cwd();
  const serverPath = path.join(repoRoot, 'dist', 'sidecar-server.js');
  const logDir = path.join(os.homedir(), '.gemini', 'antigravity');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'synchronum.log');

  const runningStatus = await isServiceRunning();
  if (runningStatus.running) {
    return true;
  }

  if (process.platform === 'win32') {
    const silentVbs = path.join(repoRoot, 'start-silent.vbs');
    if (fs.existsSync(silentVbs)) {
      const child = spawn('wscript.exe', ['//B', silentVbs], {
        detached: true,
        stdio: 'ignore',
        cwd: repoRoot,
      });
      child.unref();
    } else {
      const out = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, ['--experimental-sqlite', serverPath], {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      });
      child.unref();
    }
  } else {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, ['--experimental-sqlite', serverPath], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
  }

  // Wait up to 4 seconds for it to start
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const status = await isServiceRunning();
    if (status.running) {
      return true;
    }
  }

  return false;
}

export async function stopService(): Promise<boolean> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const psCommand = `Get-NetTCPConnection -LocalPort ${SERVICE_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`;
      exec(`powershell -NoProfile -Command "${psCommand}"`, () => {
        resolve(true);
      });
    });
  }

  return new Promise((resolve) => {
    exec(`fuser -k ${SERVICE_PORT}/tcp || lsof -ti:${SERVICE_PORT} | xargs kill -9`, () => {
      resolve(true);
    });
  });
}
