import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SIDECAR = path.join(ROOT, 'sidecar');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const RELEASE_DIR = path.join(ROOT, 'release');

fs.mkdirSync(RELEASE_DIR, { recursive: true });

async function createZipBundle(): Promise<void> {
  const zipPath = path.join(RELEASE_DIR, 'synchronum-v1.0.0-windows-portable.zip');
  console.log(`📦 Packaging Windows portable bundle: ${zipPath}...`);

  const zip = new AdmZip();

  // Root files
  zip.addLocalFile(path.join(ROOT, 'install.bat'));
  zip.addLocalFile(path.join(ROOT, 'package.json'));
  zip.addLocalFile(path.join(ROOT, 'README.md'));

  // Directories
  zip.addLocalFolder(DIST, 'dist');
  zip.addLocalFolder(SIDECAR, 'sidecar');
  zip.addLocalFolder(NODE_MODULES, 'node_modules');

  zip.writeZip(zipPath);
  console.log('✅ Windows bundle created successfully!');
}

async function createPosixZipBundle(): Promise<void> {
  const zipPath = path.join(RELEASE_DIR, 'synchronum-v1.0.0-posix-portable.zip');
  console.log(`📦 Packaging POSIX portable bundle: ${zipPath}...`);

  const zip = new AdmZip();

  // Root files
  zip.addLocalFile(path.join(ROOT, 'install.sh'));
  zip.addLocalFile(path.join(ROOT, 'package.json'));
  zip.addLocalFile(path.join(ROOT, 'README.md'));

  // Directories
  zip.addLocalFolder(DIST, 'dist');
  zip.addLocalFolder(SIDECAR, 'sidecar');
  zip.addLocalFolder(NODE_MODULES, 'node_modules');

  zip.writeZip(zipPath);
  console.log('✅ POSIX bundle created successfully!');
}

async function main() {
  await createZipBundle();
  await createPosixZipBundle();
  console.log('\n🎉 All release bundles ready in ./release folder!\n');
}

main().catch((err) => {
  console.error('Build bundles failed:', err);
  process.exit(1);
});
