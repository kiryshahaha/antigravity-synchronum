import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AntigravityPaths {
  root: string;
  conversationsDir: string;
  brainDir: string;
  summariesDbPath: string;
  agyhubProtoPath: string;
  configProjectsDir: string;
  appStoragePath: string;
}

export function getAntigravityPaths(customRoot?: string): AntigravityPaths {
  let root = customRoot;
  const home = os.homedir();

  if (!root) {
    root = path.join(home, '.gemini', 'antigravity');
  }

  const summariesDbPath = path.join(root, 'conversation_summaries.db');
  const conversationsDir = path.join(root, 'conversations');
  const brainDir = path.join(root, 'brain');
  const agyhubProtoPath = path.join(root, 'agyhub_summaries_proto.pb');
  const configProjectsDir = path.join(home, '.gemini', 'config', 'projects');

  let appStoragePath: string;
  if (process.platform === 'win32') {
    appStoragePath = path.join(home, 'AppData', 'Roaming', 'Antigravity', 'app_storage.json');
  } else if (process.platform === 'darwin') {
    appStoragePath = path.join(home, 'Library', 'Application Support', 'Antigravity', 'app_storage.json');
  } else {
    appStoragePath = path.join(home, '.config', 'Antigravity', 'app_storage.json');
  }

  return {
    root,
    conversationsDir,
    brainDir,
    summariesDbPath,
    agyhubProtoPath,
    configProjectsDir,
    appStoragePath,
  };
}

export function validateAntigravityPaths(paths: AntigravityPaths): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!fs.existsSync(paths.root)) {
    errors.push(`Antigravity root directory not found: ${paths.root}`);
  }
  if (!fs.existsSync(paths.summariesDbPath)) {
    errors.push(`Conversation summaries DB not found: ${paths.summariesDbPath}`);
  }
  if (!fs.existsSync(paths.conversationsDir)) {
    errors.push(`Conversations directory not found: ${paths.conversationsDir}`);
  }
  if (!fs.existsSync(paths.brainDir)) {
    errors.push(`Brain directory not found: ${paths.brainDir}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
