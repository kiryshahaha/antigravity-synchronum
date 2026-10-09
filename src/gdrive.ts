import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type?: string;
}

export interface DriveFileInfo {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

const DEFAULT_REDIRECT_PORT = 42124;
const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}/oauth/callback`;
const TOKEN_FILE_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'synchronum_tokens.json');

export class GoogleDriveOAuth {
  private clientId: string;
  private clientSecret: string;
  private tokens: OAuthTokens | null = null;

  constructor(clientId?: string, clientSecret?: string) {
    // Allows user-provided GCP credentials or falls back to environment/config
    this.clientId = clientId || process.env.SYNCHRONUM_CLIENT_ID || '';
    this.clientSecret = clientSecret || process.env.SYNCHRONUM_CLIENT_SECRET || '';
    this.loadTokens();
  }

  public setCredentials(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private loadTokens(): void {
    if (fs.existsSync(TOKEN_FILE_PATH)) {
      try {
        this.tokens = JSON.parse(fs.readFileSync(TOKEN_FILE_PATH, 'utf-8'));
      } catch {
        this.tokens = null;
      }
    }
  }

  public saveTokens(tokens: OAuthTokens): void {
    const existing = this.tokens || {};
    this.tokens = {
      ...existing,
      ...tokens,
      expires_at: tokens.expires_at || Date.now() + 3500 * 1000,
    };
    fs.mkdirSync(path.dirname(TOKEN_FILE_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_FILE_PATH, JSON.stringify(this.tokens, null, 2), { mode: 0o600 });
  }

  public isAuthenticated(): boolean {
    return Boolean(this.tokens?.refresh_token || this.tokens?.access_token);
  }

  public async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated. Please run "synchronum login" first.');
    }

    if (this.tokens.expires_at && Date.now() < this.tokens.expires_at - 60000 && this.tokens.access_token) {
      return this.tokens.access_token;
    }

    if (!this.tokens.refresh_token) {
      if (this.tokens.access_token) return this.tokens.access_token;
      throw new Error('No refresh token available. Re-run "synchronum login".');
    }

    // Refresh the token
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to refresh Google OAuth token: ${errText}`);
    }

    const data = (await res.json()) as any;
    this.saveTokens({
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    });

    return data.access_token;
  }

  public async startAuthFlow(options: { clientId?: string; clientSecret?: string } = {}): Promise<OAuthTokens> {
    const clientId = options.clientId || this.clientId;
    const clientSecret = options.clientSecret || this.clientSecret;

    if (!clientId) {
      throw new Error('Google OAuth Client ID is required. Pass via options or set SYNCHRONUM_CLIENT_ID.');
    }

    // PKCE code verifier and challenge
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', DEFAULT_REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.appdata');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || '', `http://127.0.0.1:${DEFAULT_REDIRECT_PORT}`);
          if (reqUrl.pathname === '/oauth/callback') {
            const code = reqUrl.searchParams.get('code');
            const error = reqUrl.searchParams.get('error');

            if (error) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<h2>Authentication Failed</h2><p>${error}</p>`);
              server.close();
              reject(new Error(`OAuth error: ${error}`));
              return;
            }

            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<h2>Missing authorization code</h2>');
              return;
            }

            // Exchange code for tokens
            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                code_verifier: verifier,
                grant_type: 'authorization_code',
                redirect_uri: DEFAULT_REDIRECT_URI,
              }),
            });

            if (!tokenRes.ok) {
              const err = await tokenRes.text();
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<h2>Token Exchange Failed</h2><pre>${err}</pre>`);
              server.close();
              reject(new Error(`Token exchange failed: ${err}`));
              return;
            }

            const tokenData = (await tokenRes.json()) as OAuthTokens;
            this.setCredentials(clientId, clientSecret);
            this.saveTokens(tokenData);

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <html>
                <body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #0f172a; color: #f8fafc;">
                  <div style="background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                    <h1 style="color: #38bdf8; margin-top: 0;">Synchronum Authenticated!</h1>
                    <p style="color: #94a3b8;">Google Drive (appDataFolder) access granted.</p>
                    <p style="font-size: 0.9rem; color: #64748b;">You can close this tab and return to Antigravity.</p>
                  </div>
                </body>
              </html>
            `);

            server.close();
            resolve(tokenData);
          }
        } catch (err) {
          server.close();
          reject(err);
        }
      });

      server.listen(DEFAULT_REDIRECT_PORT, () => {
        console.log(`\n🔗 Please authorize Synchronum in your browser:`);
        console.log(`\n${authUrl.toString()}\n`);

        // Attempt to auto-open in default browser
        import('node:child_process').then(({ exec }) => {
          const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
          exec(`${startCmd} "${authUrl.toString()}"`, () => {});
        });
      });

      server.on('error', (err) => {
        reject(new Error(`Could not start local OAuth listener on port ${DEFAULT_REDIRECT_PORT}: ${err.message}`));
      });
    });
  }
}

export class GoogleDriveAppDataClient {
  constructor(private oauth: GoogleDriveOAuth) {}

  public async listFiles(): Promise<DriveFileInfo[]> {
    const token = await this.oauth.getAccessToken();
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('fields', 'files(id, name, modifiedTime, size)');
    url.searchParams.set('pageSize', '100');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Drive listFiles failed: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data.files || [];
  }

  public async downloadFile(fileId: string): Promise<Buffer> {
    const token = await this.oauth.getAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Drive downloadFile failed: ${await res.text()}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  public async uploadFile(name: string, content: Buffer, mimeType = 'application/octet-stream'): Promise<string> {
    const token = await this.oauth.getAccessToken();
    const existingFiles = await this.listFiles();
    const existing = existingFiles.find((f) => f.name === name);

    const metadata = {
      name,
      parents: ['appDataFolder'],
    };

    const boundary = '-------SynchronumBoundary' + Date.now();
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody = Buffer.concat([
      Buffer.from(
        delimiter +
          'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(metadata) +
          delimiter +
          `Content-Type: ${mimeType}\r\n\r\n`
      ),
      content,
      Buffer.from(closeDelimiter),
    ]);

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';

    if (existing) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`;
      method = 'PATCH';
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });

    if (!res.ok) {
      throw new Error(`Drive uploadFile failed: ${await res.text()}`);
    }

    const data = (await res.json()) as any;
    return data.id;
  }

  public async deleteFile(fileId: string): Promise<void> {
    const token = await this.oauth.getAccessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive deleteFile failed: ${await res.text()}`);
    }
  }
}
