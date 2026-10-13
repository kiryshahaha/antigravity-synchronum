import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class PathResolver {
  public static getGitRemote(dirPath: string): string | null {
    if (!fs.existsSync(dirPath)) return null;
    try {
      const gitConfigFile = path.join(dirPath, '.git', 'config');
      if (fs.existsSync(gitConfigFile)) {
        const content = fs.readFileSync(gitConfigFile, 'utf-8');
        const match = content.match(/\[remote\s+"origin"\][^\[]*url\s*=\s*([^\r\n]+)/i);
        if (match && match[1]) {
          return match[1].trim();
        }
      }
      const output = execSync('git config --get remote.origin.url', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 500,
      }).trim();
      return output || null;
    } catch {
      return null;
    }
  }

  public static uriToPath(uri: string): string {
    try {
      if (uri.startsWith('file://')) {
        return fileURLToPath(uri);
      }
      return uri;
    } catch {
      return uri.replace(/^file:\/\/\/?/, '');
    }
  }

  public static pathToUri(filePath: string): string {
    try {
      return pathToFileURL(path.resolve(filePath)).href;
    } catch {
      return `file:///${filePath.replace(/\\/g, '/')}`;
    }
  }

  public static translateWorkspaceUris(
    originalWorkspaceUrisJson: string,
    options: {
      targetWorkspace?: string;
      gitRemote?: string;
      knownWorkspaceUris?: string[];
    }
  ): string {
    let uris: string[] = [];
    try {
      uris = JSON.parse(originalWorkspaceUrisJson);
      if (!Array.isArray(uris)) uris = [originalWorkspaceUrisJson];
    } catch {
      uris = [originalWorkspaceUrisJson];
    }

    if (options.targetWorkspace) {
      const newUri = PathResolver.pathToUri(options.targetWorkspace);
      return JSON.stringify([newUri]);
    }

    // Flatten and parse knownWorkspaceUris so JSON strings don't break uriToPath
    const cleanKnownUris: string[] = [];
    if (options.knownWorkspaceUris) {
      for (const item of options.knownWorkspaceUris) {
        try {
          const parsed = JSON.parse(item);
          if (Array.isArray(parsed)) cleanKnownUris.push(...parsed);
          else if (typeof parsed === 'string') cleanKnownUris.push(parsed);
          else cleanKnownUris.push(item);
        } catch {
          cleanKnownUris.push(item);
        }
      }
    }

    const translated = uris.map((uri) => {
      const originalPath = PathResolver.uriToPath(uri);

      // If the original path exists on this machine, keep it!
      if (fs.existsSync(originalPath)) {
        return uri;
      }

      // If git remote is provided and we have known local workspaces
      if (options.gitRemote && cleanKnownUris.length > 0) {
        for (const knownUri of cleanKnownUris) {
          const knownPath = PathResolver.uriToPath(knownUri);
          if (fs.existsSync(knownPath)) {
            const remote = PathResolver.getGitRemote(knownPath);
            if (remote && remote.toLowerCase() === options.gitRemote.toLowerCase()) {
              return knownUri;
            }
          }
        }
      }

      // Check if folder name exists in current user Desktop or Home
      const baseName = path.basename(originalPath);
      const candidates = [
        path.join(process.cwd(), baseName),
        path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', baseName),
        path.join(process.env.USERPROFILE || process.env.HOME || '', 'Projects', baseName),
        path.join(process.env.USERPROFILE || process.env.HOME || '', baseName),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return PathResolver.pathToUri(candidate);
        }
      }

      return uri;
    });

    return JSON.stringify(translated);
  }
}
