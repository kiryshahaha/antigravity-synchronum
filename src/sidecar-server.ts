import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SynchronumBundler } from './bundler.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths } from './paths.js';
import { AntigravitySqlite } from './sqlite.js';
import { SynchronumSyncEngine } from './sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '42125', 10);
const paths = getAntigravityPaths();
const sqlite = new AntigravitySqlite(paths.summariesDbPath);
const bundler = new SynchronumBundler();
const oauth = new GoogleDriveOAuth();

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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'connected',
        platform: process.platform,
        hostname: os.hostname(),
        antigravityDir: paths.root,
        totalConversations: sqlite.listSummaries(1000).length,
        googleDriveConnected: oauth.isAuthenticated(),
      })
    );
    return;
  }

  // 2. Conversations List API
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

  // 3. Export File Download API
  if (url.pathname.startsWith('/api/export/')) {
    const conversationId = url.pathname.replace('/api/export/', '');
    const password = url.searchParams.get('password') || undefined;

    try {
      const tempPath = path.join(os.tmpdir(), `${conversationId}${password ? '.bundle.enc' : '.bundle'}`);
      const exportResult = await bundler.exportBundle(conversationId, {
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

  // 4. Import Bundle Upload API
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

  // 5. Connect Google Drive API
  if (url.pathname === '/api/connect-gdrive' && req.method === 'POST') {
    const body = await parseBody(req);
    oauth.setCredentials(body.clientId || '', body.clientSecret || '');
    oauth.startAuthFlow({ clientId: body.clientId, clientSecret: body.clientSecret }).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true }));
    return;
  }

  // 6. Push to Google Drive API
  if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
    const conversationId = url.pathname.replace('/api/push/', '');
    const body = await parseBody(req);
    const password = body.password;

    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Master password is required for E2EE' }));
      return;
    }

    try {
      const syncEngine = new SynchronumSyncEngine(oauth);
      const result = await syncEngine.pushSession(conversationId, password);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. Pull from Google Drive API
  if (url.pathname === '/api/pull' && req.method === 'POST') {
    const body = await parseBody(req);
    const password = body.password;

    if (!password) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Master password is required for E2EE' }));
      return;
    }

    try {
      const syncEngine = new SynchronumSyncEngine(oauth);
      const result = await syncEngine.pullAll(password);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. Auto-install Sidecar into Antigravity
  if (url.pathname === '/api/install-sidecar' && req.method === 'POST') {
    try {
      const targetSidecarDir = path.join(paths.root, 'sidecars', 'synchronum');
      const sourceSidecarDir = path.resolve(__dirname, '..', 'sidecar');

      fs.mkdirSync(targetSidecarDir, { recursive: true });
      fs.cpSync(sourceSidecarDir, targetSidecarDir, { recursive: true });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, path: targetSidecarDir }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Static files
  const publicDir = path.resolve(__dirname, '..', 'sidecar', 'public');
  let filePath = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType =
      ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Synchronum Sidecar] Running Aux Pane dashboard on http://127.0.0.1:${PORT}`);
});
