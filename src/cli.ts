import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { SynchronumBundler } from './bundler.js';
import { loadConfig, saveConfig } from './config.js';
import { isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths, validateAntigravityPaths } from './paths.js';
import { repairAndReconcileAll } from './projects.js';
import { installService, isServiceInstalled, isServiceRunning, startService, stopService, uninstallService } from './service.js';
import { AntigravitySqlite } from './sqlite.js';
import { createStorageProvider, LocalFolderStorageProvider } from './storage.js';
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
  .description('Encrypt and upload a conversation to configured storage')
  .requiredOption('-p, --password <password>', 'Master password for E2EE encryption')
  .action(async (conversationId, options) => {
    try {
      const config = loadConfig();
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      console.log(`\n🔄 Encrypting and pushing session [${conversationId}] via ${storage.name}...`);

      const result = await engine.pushSession(conversationId, options.password);
      console.log(`✅ Successfully pushed!`);
      console.log(`   Title: ${result.title}`);
      console.log(`   Size:  ${(result.bytes / 1024).toFixed(2)} KB\n`);
    } catch (err: any) {
      console.error(`\n❌ Push failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('pull')
  .description('Download and restore updated sessions from storage')
  .requiredOption('-p, --password <password>', 'Master password for E2EE decryption')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      console.log(`\n🔄 Checking ${storage.name} for updated conversations...`);

      const result = await engine.pullAll(options.password);
      console.log(`\n✅ Pull completed!`);
      console.log(`   Restored (${result.restored.length}): ${result.restored.join(', ') || 'None'}`);
      console.log(`   Up-to-date (${result.skipped.length}): ${result.skipped.join(', ') || 'None'}\n`);

      console.log(`🔄 Reconciling Antigravity projects and binary protobuf...`);
      const rep = repairAndReconcileAll();
      console.log(`✅ Antigravity environment updated: ${rep.totalProjects} projects registered, ${rep.protoSynced} dialogues ready in IDE!\n`);
    } catch (err: any) {
      console.error(`\n❌ Pull failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('repair')
  .description('Automatically repair Antigravity projects registry, layouts, and binary protobuf cache')
  .action(() => {
    try {
      console.log('\n🔧 Running full Antigravity environment repair & reconciliation...');
      const result = repairAndReconcileAll();
      console.log(`\n✅ Repair completed successfully!`);
      console.log(`   Projects remapped to local:  ${result.remappedCount}`);
      console.log(`   Total projects registered:   ${result.totalProjects}`);
      console.log(`   Dialogues in protobuf cache: ${result.protoSynced}`);
      console.log(`   UI layout panes initialized: ${result.layoutsAdded}\n`);
      console.log(`💡 Now press Ctrl+Shift+P in Antigravity -> "Developer: Reload Window" to see all dialogues!\n`);
    } catch (err: any) {
      console.error(`\n❌ Repair failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('cloud-list')
  .description('List sessions stored in storage provider')
  .requiredOption('-p, --password <password>', 'Master password for E2EE decryption')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      console.log(`\n🔄 Fetching session catalog from ${storage.name}...`);

      const index = await engine.fetchRemoteIndex(options.password);
      const list = Object.values(index.sessions);

      console.log(`\n=== Remote Sessions (${list.length} total) ===\n`);
      list.forEach((s, idx) => {
        console.log(`${(idx + 1).toString().padStart(2)}. [${s.conversation_id}]`);
        console.log(`    Title:    ${s.title}`);
        console.log(`    Steps:    ${s.step_count} | Size: ${(s.size_bytes / 1024).toFixed(2)} KB`);
        console.log(`    Device:   ${s.author_device} | Updated: ${new Date(s.updated_at).toLocaleString()}`);
        console.log('------------------------------------------------------------');
      });
      console.log('');
    } catch (err: any) {
      console.error(`\n❌ Listing failed: ${err.message}\n`);
      process.exit(1);
    }
  });

const serviceCmd = program.command('service').description('Manage background OS service & autostart');

serviceCmd
  .command('status')
  .description('Check background service status')
  .action(async () => {
    const runningStatus = await isServiceRunning();
    const installed = isServiceInstalled();
    console.log('\n=== Synchronum Background Service ===');
    console.log(`Installed in OS Autostart: ${installed ? '🟢 YES' : '⚪ NO'}`);
    console.log(`Running on background port: ${runningStatus.running ? '🟢 YES (http://localhost:42125)' : '⚪ STOPPED'}\n`);
  });

serviceCmd
  .command('install')
  .description('Install Synchronum as a silent background service (starts with Windows)')
  .action(async () => {
    try {
      console.log('\n🔄 Installing Synchronum into OS Startup...');
      const res = await installService();
      console.log('✅ Synchronum Background Service installed successfully!');
      console.log(`   Startup Launcher: ${res.scriptPath}`);
      console.log('   Dashboard: http://localhost:42125\n');
    } catch (err: any) {
      console.error(`\n❌ Failed to install service: ${err.message}\n`);
      process.exit(1);
    }
  });

serviceCmd
  .command('uninstall')
  .description('Uninstall Synchronum from OS Startup and stop background process')
  .action(async () => {
    try {
      console.log('\n🔄 Removing Synchronum from OS Startup...');
      await uninstallService();
      console.log('✅ Synchronum Background Service removed and stopped.\n');
    } catch (err: any) {
      console.error(`\n❌ Failed to uninstall service: ${err.message}\n`);
      process.exit(1);
    }
  });

serviceCmd
  .command('start')
  .description('Start background service immediately (silent without window)')
  .action(async () => {
    try {
      console.log('\n🔄 Starting Synchronum in background...');
      const started = await startService();
      if (started) {
        console.log('✅ Synchronum started! Running at http://localhost:42125\n');
      } else {
        console.log('⚠️  Could not confirm server startup within 3s.\n');
      }
    } catch (err: any) {
      console.error(`\n❌ Failed to start service: ${err.message}\n`);
      process.exit(1);
    }
  });

serviceCmd
  .command('stop')
  .description('Stop running background service')
  .action(async () => {
    try {
      console.log('\n🔄 Stopping Synchronum background service...');
      await stopService();
      console.log('✅ Synchronum stopped.\n');
    } catch (err: any) {
      console.error(`\n❌ Failed to stop service: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('config')
  .description('View or update Synchronum configuration')
  .option('--storage <type>', 'Storage type (gdrive or local_folder)')
  .option('--folder <path>', 'Local folder path for sync')
  .option('--auto-sync <boolean>', 'Enable or disable auto-sync (true/false)')
  .option('--interval <minutes>', 'Auto-sync interval in minutes')
  .action((options) => {
    const current = loadConfig();
    const updates: any = {};
    if (options.storage) updates.storageType = options.storage;
    if (options.folder) updates.localFolderPath = options.folder;
    if (options.autoSync !== undefined) updates.autoSync = options.autoSync === 'true';
    if (options.interval) updates.autoSyncIntervalMinutes = parseInt(options.interval, 10);

    const saved = saveConfig(updates);
    console.log('\n=== Synchronum Configuration ===');
    console.log(`Storage Type:       ${saved.storageType}`);
    console.log(`Local Folder Path:  ${saved.localFolderPath}`);
    console.log(`Auto-Sync:          ${saved.autoSync ? '🟢 Enabled' : '⚪ Disabled'}`);
    console.log(`Interval (minutes): ${saved.autoSyncIntervalMinutes}`);
    console.log(`Last Sync Time:     ${saved.lastSyncTime || '(none)'}`);
    console.log(`Autostart Service:  ${saved.autostartService ? '🟢 Enabled' : '⚪ Disabled'}\n`);
  });

program.parse(process.argv);
