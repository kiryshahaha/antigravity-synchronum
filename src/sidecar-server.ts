import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {}

import { SynchronumBundler } from './bundler.js';
import { loadConfig, saveConfig, SynchronumConfig } from './config.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths } from './paths.js';
import { getGroupedConversations, repairAndReconcileAll } from './projects.js';
import { installService, isServiceInstalled, uninstallService } from './service.js';
import { AntigravitySqlite } from './sqlite.js';
import { createStorageProvider, SyncStorageProvider } from './storage.js';
import { SynchronumSyncEngine } from './sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '42125', 10);
const paths = getAntigravityPaths();
const sqlite = new AntigravitySqlite(paths.summariesDbPath);
const bundler = new SynchronumBundler();
const oauth = new GoogleDriveOAuth();

let currentConfig: SynchronumConfig = loadConfig();
let currentStorage: SyncStorageProvider = createStorageProvider(currentConfig, oauth);

function getSyncEngine(): SynchronumSyncEngine {
  currentConfig = loadConfig();
  currentStorage = createStorageProvider(currentConfig, oauth);
  return new SynchronumSyncEngine(currentStorage);
}

// Background Auto-Sync Worker
let isSyncing = false;
async function runAutoSyncCycle(): Promise<void> {
  if (isSyncing) return;
  const config = loadConfig();
  if (!config.masterPassword) return;

  const intervalMs = Math.max(1, config.autoSyncIntervalMinutes || 5) * 60 * 1000;
  const lastSync = config.lastSyncTime ? new Date(config.lastSyncTime).getTime() : 0;
  if (!config.autoSync && lastSync > 0) return; // Only skip if not autoSync and not first run
  if (config.autoSync && Date.now() - lastSync < intervalMs) return;

  isSyncing = true;
  try {
    const engine = getSyncEngine();
    console.log(`[Auto-Sync] Running two-way sync for device ${engine.getDeviceName()}...`);

    const result = await engine.syncAll(config.masterPassword);
    saveConfig({ lastSyncTime: new Date().toISOString() });
    console.log(`[Auto-Sync] Completed: Pushed ${result.pushed.length}, Restored ${result.restored.length}, Skipped ${result.skipped.length}`);

    // Auto-reconcile Antigravity project registry and proto cache
    try {
      repairAndReconcileAll();
    } catch {}
  } catch (err: any) {
    console.error('[Auto-Sync Error]', err.message);
  } finally {
    isSyncing = false;
  }
}

// Run auto-sync check every 30 seconds
setInterval(runAutoSyncCycle, 30000);

// Run initial sync cycle and reconciliation on startup
setTimeout(() => {
  try {
    repairAndReconcileAll();
  } catch {}
  const cfg = loadConfig();
  if (cfg.masterPassword) {
    runAutoSyncCycle().catch(() => {});
  }
}, 2000);

// Helper to parse multipart/form-data or json
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          resolve(JSON.parse(buffer.toString('utf-8')));
        } catch {
          resolve({});
        }
      } else {
        resolve(buffer);
      }
    });
  });
}

function resolveStaticFile(requestPath: string): string | null {
  const normalized = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const searchDirs = [
    path.resolve(__dirname, '..', 'sidecar', 'public'),
    path.resolve(__dirname, 'public'),
    path.resolve(REPO_ROOT, 'sidecar', 'public'),
    path.resolve(process.cwd(), 'sidecar', 'public'),
    path.resolve(process.cwd(), 'public'),
  ];

  for (const d of searchDirs) {
    const candidate = path.join(d, normalized);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Status API
  if (url.pathname === '/api/status') {
    const config = loadConfig();
    const storage = createStorageProvider(config, oauth);
    const isAvail = await storage.isAvailable();
    const engine = getSyncEngine();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'connected',
        platform: process.platform,
        hostname: os.hostname(),
        deviceId: engine.getDeviceId(),
        deviceName: engine.getDeviceName(),
        antigravityDir: paths.root,
        totalConversations: sqlite.listSummaries(1000).length,
        googleDriveConnected: oauth.isAuthenticated(),
        storageType: config.storageType,
        storageName: storage.getDisplayName(),
        storageAvailable: isAvail,
        autoSync: config.autoSync,
        autoSyncIntervalMinutes: config.autoSyncIntervalMinutes,
        lastSyncTime: config.lastSyncTime || null,
        serviceInstalled: isServiceInstalled(),
      })
    );
    return;
  }

  // 1.1 Devices List API
  if (url.pathname === '/api/devices') {
    try {
      const engine = getSyncEngine();
      const config = loadConfig();
      const devices = await engine.listAllDevices(config.masterPassword);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(devices));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. Config API
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadConfig()));
      return;
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      const updated = saveConfig(body);
      currentConfig = updated;
      currentStorage = createStorageProvider(updated, oauth);

      // Trigger sync immediately if master password is present
      if (updated.masterPassword) {
        setTimeout(() => {
          runAutoSyncCycle().catch((e) => console.error('[Config Auto-Sync]', e.message));
        }, 200);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, config: updated }));
      return;
    }
  }

  // 3. Service Management API
  if (url.pathname === '/api/service/install' && req.method === 'POST') {
    try {
      const result = await installService(REPO_ROOT);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/service/uninstall' && req.method === 'POST') {
    try {
      await uninstallService();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4. Instant Safe Sync API (Two-Way)
  if ((url.pathname === '/api/sync-now' || url.pathname === '/api/pull') && req.method === 'POST') {
    const body = await parseBody(req);
    const password = body.password || loadConfig().masterPassword;

    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Мастер-пароль обязателен для синхронизации!' }));
      return;
    }

    try {
      const engine = getSyncEngine();
      const syncResult = await engine.syncAll(password);
      saveConfig({ lastSyncTime: new Date().toISOString() });

      // Ensure full Antigravity reconciliation
      let repairStats = null;
      try {
        repairStats = repairAndReconcileAll();
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: syncResult, repair: repairStats }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4.1 Manual Antigravity Environment Repair API
  if (url.pathname === '/api/repair' && req.method === 'POST') {
    try {
      const stats = repairAndReconcileAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, stats }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5. Grouped Conversations & Projects API
  if (url.pathname === '/api/grouped-conversations') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      const grouped = getGroupedConversations(sqlite, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(grouped));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5.1 Raw Conversations List API
  if (url.pathname === '/api/conversations') {
    try {
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const summaries = sqlite.listSummaries(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summaries));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 6. Export File Download API
  if (url.pathname.startsWith('/api/export/')) {
    const conversationId = url.pathname.replace('/api/export/', '');
    const password = url.searchParams.get('password') || undefined;

    try {
      const tempPath = path.join(os.tmpdir(), `${conversationId}${password ? '.bundle.enc' : '.bundle'}`);
      await bundler.exportBundle(conversationId, {
        outputPath: tempPath,
        password,
      });

      const fileBuffer = fs.readFileSync(tempPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(tempPath)}"`,
        'Content-Length': fileBuffer.length,
      });
      res.end(fileBuffer);

      try {
        fs.unlinkSync(tempPath);
      } catch {}
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. Import Bundle Upload API
  if (url.pathname === '/api/import' && req.method === 'POST') {
    try {
      const buffer = await parseBody(req);
      const password = url.searchParams.get('password') || undefined;
      const targetWorkspace = url.searchParams.get('workspace') || undefined;

      const tempFile = path.join(os.tmpdir(), `upload_${Date.now()}.bundle`);
      fs.writeFileSync(tempFile, buffer);

      const result = await bundler.importBundle(tempFile, {
        password,
        targetWorkspace,
      });

      try {
        fs.unlinkSync(tempFile);
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. Connect Google Drive API
  if (url.pathname === '/api/connect-gdrive' && req.method === 'POST') {
    const body = await parseBody(req);
    if (body.clientId && body.clientSecret) {
      oauth.setCredentials(body.clientId, body.clientSecret);
    }
    const authDetails = oauth.generateAuthUrl(body.clientId ? { clientId: body.clientId } : {});
    oauth.startAuthFlow({ ...(body.clientId ? { clientId: body.clientId, clientSecret: body.clientSecret } : {}), authDetails }).catch((err) => {
      console.error('[OAuth Flow Error]', err.message);
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, authUrl: authDetails.authUrl }));
    return;
  }

  // 9. Push to Cloud/Local Provider API
  if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
    const conversationId = url.pathname.replace('/api/push/', '');
    const body = await parseBody(req);
    const password = body.password || loadConfig().masterPassword;

    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Master password is required for E2EE' }));
      return;
    }

    try {
      const syncEngine = getSyncEngine();
      const result = await syncEngine.pushSession(conversationId, password);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 10. Pull from Cloud/Local Provider API
  if (url.pathname === '/api/pull' && req.method === 'POST') {
    const body = await parseBody(req);
    const password = body.password || loadConfig().masterPassword;

    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Master password is required for E2EE' }));
      return;
    }

    try {
      const syncEngine = getSyncEngine();
      const result = await syncEngine.pullAll(password);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 11. Auto-install Sidecar into Antigravity
  if (url.pathname === '/api/install-sidecar' && req.method === 'POST') {
    try {
      const targetSidecarDir = path.join(paths.root, 'sidecars', 'synchronum');
      const sourceSidecarDir = path.resolve(REPO_ROOT, 'sidecar');

      fs.mkdirSync(targetSidecarDir, { recursive: true });
      fs.cpSync(sourceSidecarDir, targetSidecarDir, { recursive: true });

      // Also copy dist for self-contained relative execution
      const distDir = path.resolve(REPO_ROOT, 'dist');
      if (fs.existsSync(distDir)) {
        fs.cpSync(distDir, path.join(targetSidecarDir, 'dist'), { recursive: true });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, path: targetSidecarDir }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files serving with flexible fallback
  const resolvedPath = resolveStaticFile(url.pathname);
  if (resolvedPath) {
    const ext = path.extname(resolvedPath);
    const contentType =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.css'
          ? 'text/css'
          : ext === '.js'
            ? 'application/javascript'
            : ext === '.json'
              ? 'application/json'
              : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(resolvedPath));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Synchronum Sidecar] Сервис уже запущен и работает на http://127.0.0.1:${PORT}`);
    process.exit(0);
  } else {
    console.error('[Synchronum Server Error]', err);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Synchronum Sidecar] Running Aux Pane dashboard on http://127.0.0.1:${PORT}`);
});
