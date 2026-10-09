import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AntigravityPaths {
  root: string;
  conversationsDir: string;
  brainDir: string;
  summariesDbPath: string;
}

export function getAntigravityPaths(customRoot?: string): AntigravityPaths {
  let root = customRoot;

  if (!root) {
    const home = os.homedir();
    root = path.join(home, '.gemini', 'antigravity');
  }

  const summariesDbPath = path.join(root, 'conversation_summaries.db');
  const conversationsDir = path.join(root, 'conversations');
  const brainDir = path.join(root, 'brain');

  return {
    root,
    conversationsDir,
    brainDir,
    summariesDbPath,
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
