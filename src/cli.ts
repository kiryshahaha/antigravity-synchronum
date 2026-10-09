#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { SynchronumBundler } from './bundler.js';
import { isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths, validateAntigravityPaths } from './paths.js';
import { AntigravitySqlite } from './sqlite.js';
import { SynchronumSyncEngine } from './sync.js';

const program = new Command();

program
  .name('synchronum')
  .description('Cross-device session synchronization tool for Google Antigravity 2.0')
  .version('1.0.0');

program
  .command('status')
  .description('Check Antigravity installation status and paths')
  .action(() => {
    const paths = getAntigravityPaths();
    const validation = validateAntigravityPaths(paths);

    console.log('\n=== Synchronum: Antigravity Environment ===');
    console.log(`Antigravity Root:   ${paths.root}`);
    console.log(`Summaries Database: ${paths.summariesDbPath}`);
    console.log(`Conversations Dir:  ${paths.conversationsDir}`);
    console.log(`Brain Directory:    ${paths.brainDir}`);

    if (!validation.valid) {
      console.log('\n⚠️  Issues detected:');
      validation.errors.forEach((err) => console.log(` - ${err}`));
      process.exit(1);
    }

    const sqlite = new AntigravitySqlite(paths.summariesDbPath);
    const summaries = sqlite.listSummaries(100);
    console.log(`\nStatus: 🟢 Connected successfully`);
    console.log(`Total conversations indexed: ${summaries.length}\n`);

    const oauth = new GoogleDriveOAuth();
    console.log(`Google Drive OAuth: ${oauth.isAuthenticated() ? '🟢 Authenticated' : '⚪ Not connected (run: synchronum login)'}\n`);
  });

program
  .command('list')
  .description('List recent Antigravity conversations')
  .option('-n, --limit <number>', 'Number of conversations to display', '15')
  .action((options) => {
    const paths = getAntigravityPaths();
    const validation = validateAntigravityPaths(paths);
    if (!validation.valid) {
      console.error('Error: Antigravity directory not found or incomplete.');
      process.exit(1);
    }

    const sqlite = new AntigravitySqlite(paths.summariesDbPath);
    const limit = parseInt(options.limit, 10) || 15;
    const summaries = sqlite.listSummaries(limit);

    console.log(`\n=== Antigravity Conversations (Recent ${summaries.length}) ===\n`);
    summaries.forEach((s, idx) => {
      const title = s.title || '(Untitled conversation)';
      const date = s.last_modified_time ? new Date(s.last_modified_time).toLocaleString() : 'unknown';
      console.log(`${(idx + 1).toString().padStart(2)}. [${s.conversation_id}]`);
      console.log(`    Title:  ${title}`);
      console.log(`    Steps:  ${s.step_count} | Modified: ${date} | Status: ${s.status}`);
      console.log('------------------------------------------------------------');
    });
    console.log('');
  });

program
  .command('export <conversationId>')
  .description('Export an Antigravity conversation to a portable bundle')
  .option('-o, --output <path>', 'Output file path (default: <id>.bundle[.enc])')
  .option('-p, --password <password>', 'Master password for Zero-Knowledge E2EE encryption')
  .option('--no-brain', 'Exclude brain directory files from export')
  .action(async (conversationId, options) => {
    try {
      const bundler = new SynchronumBundler();
      console.log(`\n🔄 Packaging conversation: ${conversationId}...`);

      const result = await bundler.exportBundle(conversationId, {
        outputPath: options.output,
        password: options.password,
        includeBrain: options.brain,
      });

      console.log(`✅ Successfully exported bundle!`);
      console.log(`   Title:     ${result.manifest.title}`);
      console.log(`   Steps:     ${result.manifest.step_count}`);
      console.log(`   File:      ${result.outputPath}`);
      console.log(`   Size:      ${(result.bytes / 1024).toFixed(2)} KB`);
      console.log(`   Encrypted: ${result.encrypted ? '🔒 YES (AES-256-GCM)' : '❌ NO (plain)'}\n`);
    } catch (err: any) {
      console.error(`\n❌ Export failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('import <bundleFile>')
  .description('Import a Synchronum bundle into local Antigravity')
  .option('-p, --password <password>', 'Master password if the bundle is encrypted')
  .option('-w, --target-workspace <path>', 'Override workspace path for this machine')
  .action(async (bundleFile, options) => {
    try {
      const bundler = new SynchronumBundler();
      console.log(`\n🔄 Importing bundle: ${bundleFile}...`);

      const result = await bundler.importBundle(path.resolve(bundleFile), {
        password: options.password,
        targetWorkspace: options.targetWorkspace,
      });

      console.log(`✅ Successfully imported conversation into Antigravity!`);
      console.log(`   ID:        ${result.conversationId}`);
      console.log(`   Title:     ${result.manifest.title}`);
      console.log(`   Steps:     ${result.manifest.step_count}`);
      console.log(`   Restored:  ${result.filesRestored} files`);
      console.log(`\n🎉 You can now open this conversation in Antigravity 2.0!\n`);
    } catch (err: any) {
      console.error(`\n❌ Import failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('inspect <bundleFile>')
  .description('Inspect bundle metadata without importing')
  .option('-p, --password <password>', 'Master password if the bundle is encrypted')
  .action((bundleFile, options) => {
    try {
      const resolved = path.resolve(bundleFile);
      const raw = fs.readFileSync(resolved);
      const isEnc = isEncryptedBuffer(raw);

      console.log(`\n=== Bundle Inspection: ${path.basename(resolved)} ===`);
      console.log(`File Size:      ${(raw.length / 1024).toFixed(2)} KB`);
      console.log(`Encrypted:      ${isEnc ? '🔒 YES (E2EE AES-256-GCM)' : '❌ NO'}`);

      if (isEnc && !options.password) {
        console.log('\n🔒 This bundle is encrypted. Pass --password <pass> to read contents.\n');
        return;
      }

      const bundler = new SynchronumBundler();
      const manifest = bundler.readManifestOnly(resolved, options.password);

      console.log(`Conversation ID:${manifest.conversation_id}`);
      console.log(`Title:          ${manifest.title}`);
      console.log(`Steps:          ${manifest.step_count}`);
      console.log(`Last Modified:  ${manifest.last_modified_time}`);
      console.log(`Author Device:  ${manifest.author_device}`);
      console.log(`Git Remote:     ${manifest.git_remote || '(none)'}`);
      console.log(`Exported At:    ${manifest.exported_at}\n`);
    } catch (err: any) {
      console.error(`\n❌ Inspect failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Connect to Google Drive (OAuth 2.0 with appDataFolder)')
  .option('--client-id <id>', 'Google Cloud OAuth Client ID')
  .option('--client-secret <secret>', 'Google Cloud OAuth Client Secret')
  .action(async (options) => {
    try {
      const oauth = new GoogleDriveOAuth(options.clientId, options.clientSecret);
      console.log('\nInitiating Google Drive connection...');
      await oauth.startAuthFlow({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      });
      console.log('\n✅ Successfully authenticated with Google Drive!\n');
    } catch (err: any) {
      console.error(`\n❌ Authentication failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('push <conversationId>')
  .description('Encrypt and upload a conversation to Google Drive (appDataFolder)')
  .requiredOption('-p, --password <password>', 'Master password for E2EE encryption')
  .action(async (conversationId, options) => {
    try {
      const oauth = new GoogleDriveOAuth();
      const engine = new SynchronumSyncEngine(oauth);
      console.log(`\n🔄 Encrypting and pushing session [${conversationId}] to Google Drive...`);

      const result = await engine.pushSession(conversationId, options.password);
      console.log(`✅ Successfully pushed to Google Drive!`);
      console.log(`   Title: ${result.title}`);
      console.log(`   Size:  ${(result.bytes / 1024).toFixed(2)} KB\n`);
    } catch (err: any) {
      console.error(`\n❌ Push failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('pull')
  .description('Download and restore updated sessions from Google Drive')
  .requiredOption('-p, --password <password>', 'Master password for E2EE decryption')
  .action(async (options) => {
    try {
      const oauth = new GoogleDriveOAuth();
      const engine = new SynchronumSyncEngine(oauth);
      console.log(`\n🔄 Checking Google Drive for updated conversations...`);

      const result = await engine.pullAll(options.password);
      console.log(`\n✅ Pull completed!`);
      console.log(`   Restored (${result.restored.length}): ${result.restored.join(', ') || 'None'}`);
      console.log(`   Up-to-date (${result.skipped.length}): ${result.skipped.join(', ') || 'None'}\n`);
    } catch (err: any) {
      console.error(`\n❌ Pull failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('cloud-list')
  .description('List sessions stored in Google Drive appDataFolder')
  .requiredOption('-p, --password <password>', 'Master password for E2EE decryption')
  .action(async (options) => {
    try {
      const oauth = new GoogleDriveOAuth();
      const engine = new SynchronumSyncEngine(oauth);
      console.log(`\n🔄 Fetching remote session catalog from Google Drive...`);

      const index = await engine.fetchRemoteIndex(options.password);
      const list = Object.values(index.sessions);

      console.log(`\n=== Google Drive Sessions (${list.length} total) ===\n`);
      list.forEach((s, idx) => {
        console.log(`${(idx + 1).toString().padStart(2)}. [${s.conversation_id}]`);
        console.log(`    Title:    ${s.title}`);
        console.log(`    Steps:    ${s.step_count} | Size: ${(s.size_bytes / 1024).toFixed(2)} KB`);
        console.log(`    Device:   ${s.author_device} | Updated: ${new Date(s.updated_at).toLocaleString()}`);
        console.log('------------------------------------------------------------');
      });
      console.log('');
    } catch (err: any) {
      console.error(`\n❌ Cloud list failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);
