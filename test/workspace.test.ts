import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WorkspaceManager } from '../src/workspace.js';

describe('WorkspaceManager Module', () => {
  const testRoot = path.join(os.tmpdir(), `synchronum_test_ws_${Date.now()}`);
  const srcDir = path.join(testRoot, 'project_src');
  const destDir = path.join(testRoot, 'project_dest');
  const archivePath = path.join(testRoot, 'bundle.workspace.enc');
  const password = 'TestWorkspacePassword123';

  before(() => {
    fs.mkdirSync(path.join(srcDir, 'subfolder'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'node_modules', 'dummy'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, '.git'), { recursive: true });

    // Legitimate files
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'console.log("hello world");');
    fs.writeFileSync(path.join(srcDir, 'subfolder', 'helper.ts'), 'export const x = 42;');

    // Ignored files
    fs.writeFileSync(path.join(srcDir, 'node_modules', 'dummy', 'dep.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(srcDir, '.git', 'config'), '[core]');
    fs.writeFileSync(path.join(srcDir, 'debug.log'), 'error logs');
  });

  after(() => {
    try {
      if (fs.existsSync(testRoot)) {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {}
  });

  it('should scan workspace and correctly ignore node_modules, .git, and logs', () => {
    const scan = WorkspaceManager.scanWorkspace(srcDir);

    assert.equal(scan.fileCount, 2);
    const relPaths = scan.files.map((f) => f.relPath.replace(/\\/g, '/')).sort();
    assert.deepEqual(relPaths, ['index.ts', 'subfolder/helper.ts']);
    assert.ok(scan.hash.length > 0);
  });

  it('should skip files larger than 25 MB limit', () => {
    const hugeFilePath = path.join(srcDir, 'huge.bin');
    const fd = fs.openSync(hugeFilePath, 'w');
    fs.writeSync(fd, Buffer.alloc(1), 0, 1, 26 * 1024 * 1024);
    fs.closeSync(fd);

    const scan = WorkspaceManager.scanWorkspace(srcDir);
    fs.unlinkSync(hugeFilePath);

    assert.equal(scan.files.some((f) => f.relPath === 'huge.bin'), false);
  });


  it('should export encrypted workspace archive', async () => {
    const res = await WorkspaceManager.exportWorkspace(srcDir, archivePath, {
      projectId: 'test-project-id',
      projectName: 'Test Project',
      password,
    });

    assert.ok(fs.existsSync(archivePath));
    assert.equal(res.meta.file_count, 2);
    assert.equal(res.encrypted, true);
    assert.ok(res.bytes > 0);
  });

  it('should import encrypted workspace archive and restore files', async () => {
    const res = await WorkspaceManager.importWorkspace(archivePath, destDir, {
      password,
      backup: false,
    });

    assert.equal(res.filesRestored, 2);
    assert.ok(fs.existsSync(path.join(destDir, 'index.ts')));
    assert.ok(fs.existsSync(path.join(destDir, 'subfolder', 'helper.ts')));
    assert.equal(
      fs.readFileSync(path.join(destDir, 'index.ts'), 'utf-8'),
      'console.log("hello world");'
    );
  });
});
