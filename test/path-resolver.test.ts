import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { PathResolver } from '../src/path-resolver.js';

describe('PathResolver Module', () => {
  it('should correctly convert file:// URI to system path', () => {
    if (process.platform === 'win32') {
      const uri = 'file:///C:/Users/User/Desktop/project';
      const p = PathResolver.uriToPath(uri);
      assert.ok(p.toLowerCase().includes('c:\\users\\user\\desktop\\project') || p.toLowerCase().includes('c:/users/user/desktop/project'));
    } else {
      const uri = 'file:///home/user/project';
      const p = PathResolver.uriToPath(uri);
      assert.equal(p, '/home/user/project');
    }
  });

  it('should convert relative or absolute path to valid file:// URI', () => {
    const p = path.resolve('src/cli.ts');
    const uri = PathResolver.pathToUri(p);

    assert.ok(uri.startsWith('file://'));
  });

  it('should translate workspace uris when explicit target workspace is given', () => {
    const original = JSON.stringify(['file:///old/machine/path/project']);
    const target = path.resolve('new/local/project');
    const translated = PathResolver.translateWorkspaceUris(original, {
      targetWorkspace: target,
    });

    const parsed = JSON.parse(translated);
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].startsWith('file://'));
  });
});
