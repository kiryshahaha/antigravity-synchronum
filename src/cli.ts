#!/usr/bin/env -S node --experimental-sqlite
import { Command } from 'commander';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SynchronumBundler } from './bundler.js';

import { loadConfig, renameDevice, saveConfig } from './config.js';
import { isEncryptedBuffer } from './crypto.js';
import { GoogleDriveOAuth } from './gdrive.js';
import { getAntigravityPaths, validateAntigravityPaths } from './paths.js';
import { repairAndReconcileAll } from './projects.js';
import { syncAgyhubProtoFromDb } from './proto-sync.js';
import { installService, isServiceInstalled, isServiceRunning, startService, stopService, uninstallService } from './service.js';
import { AntigravitySqlite } from './sqlite.js';
import { createStorageProvider, LocalFolderStorageProvider } from './storage.js';
import { SynchronumSyncEngine } from './sync.js';
import { SynchronumWatcher } from './watcher.js';

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
  .command('setup')
  .description('One-click setup: install Sidecar into Antigravity, configure storage, and verify environment')
  .option('-p, --password <password>', 'Master password for Zero-Knowledge E2EE')
  .option('--storage <type>', 'Storage type (gdrive or local_folder)')
  .option('--folder <path>', 'Local folder path for sync (if using local_folder)')
  .option('--device-name <name>', 'Custom name for this device')
  .option('--autostart', 'Install background OS autostart service')
  .action(async (options) => {
    console.log('\n🚀 === Synchronum: One-Click Environment Setup ===\n');
    const paths = getAntigravityPaths();
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(paths.conversationsDir, { recursive: true });
    fs.mkdirSync(paths.brainDir, { recursive: true });

    // 1. Install / update Sidecar and Plugin
    const targetSidecarDir = path.join(paths.root, 'sidecars', 'synchronum');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sourceSidecarDir = path.join(repoRoot, 'sidecar');
    const globalConfigDir = path.resolve(os.homedir(), '.gemini', 'config');
    const targetPluginDir = path.join(globalConfigDir, 'plugins', 'synchronum');
    const targetPluginSidecarDir = path.join(targetPluginDir, 'sidecars', 'synchronum');

    console.log(`📦 Deploying Sidecar & Plugin extensions into Antigravity...`);
    if (fs.existsSync(sourceSidecarDir)) {
      // Deploy legacy sidecar
      fs.mkdirSync(targetSidecarDir, { recursive: true });
      fs.cpSync(sourceSidecarDir, targetSidecarDir, { recursive: true });
      const distDir = path.join(repoRoot, 'dist');
      if (fs.existsSync(distDir)) {
        fs.cpSync(distDir, path.join(targetSidecarDir, 'dist'), { recursive: true });
      }

      // Deploy modern plugin
      fs.mkdirSync(targetPluginDir, { recursive: true });
      fs.mkdirSync(targetPluginSidecarDir, { recursive: true });
      fs.cpSync(sourceSidecarDir, targetPluginSidecarDir, { recursive: true });
      if (fs.existsSync(distDir)) {
        fs.cpSync(distDir, path.join(targetPluginSidecarDir, 'dist'), { recursive: true });
      }

      // Copy node_modules so sidecar process doesn't fail on missing adm-zip / commander
      const nodeModulesDir = path.join(repoRoot, 'node_modules');
      if (fs.existsSync(nodeModulesDir)) {
        fs.cpSync(nodeModulesDir, path.join(targetPluginSidecarDir, 'node_modules'), { recursive: true });
        fs.cpSync(nodeModulesDir, path.join(targetSidecarDir, 'node_modules'), { recursive: true });
      }

      // Create plugin.json
      const pluginManifest = {
        name: 'synchronum',
        description: 'Zero-Knowledge E2EE Cross-Device Sync for Antigravity 2.0 conversations, workspaces, and artifacts.',
        suggestedPrompts: [
          'Run Synchronum sync to backup current conversations',
          'Show Synchronum synchronization status',
          'Push current non-git workspace to Synchronum cloud'
        ]
      };
      fs.writeFileSync(path.join(targetPluginDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf-8');

      // Enable in config.json
      try {
        const cfgJsonPath = path.join(globalConfigDir, 'config.json');
        let globalCfg: any = {};
        if (fs.existsSync(cfgJsonPath)) {
          globalCfg = JSON.parse(fs.readFileSync(cfgJsonPath, 'utf-8'));
        }
        if (!globalCfg.plugins) globalCfg.plugins = {};
        globalCfg.plugins.synchronum = { enabled: true };
        fs.writeFileSync(cfgJsonPath, JSON.stringify(globalCfg, null, 2), 'utf-8');
      } catch {}

      console.log(`✅ Sidecar & Plugin installed to: ${targetPluginDir}`);
    } else {
      console.log(`⚠️  Sidecar template folder not found at ${sourceSidecarDir}`);
    }

    // 2. Save Config
    const updates: any = {};
    if (options.password) updates.masterPassword = options.password;
    if (options.storage) updates.storageType = options.storage;
    if (options.folder) updates.localFolderPath = path.resolve(options.folder);
    if (options.deviceName) updates.deviceName = options.deviceName;
    if (options.autostart) updates.autostartService = true;
    const config = saveConfig(updates);
    console.log(`⚙️  Configuration saved: Storage=${config.storageType}, Device=${config.deviceName}`);

    // 3. Autostart service if requested
    if (options.autostart) {
      console.log(`🔄 Installing background OS service...`);
      await installService(repoRoot);
      console.log(`✅ Background service active.`);
    }

    // 4. Reconcile Antigravity
    console.log(`🔄 Reconciling Antigravity projects and protobuf cache...`);
    const rep = repairAndReconcileAll();
    console.log(`✅ Environment synchronized: ${rep.totalProjects} projects registered, ${rep.protoSynced} dialogues ready in IDE.`);

    console.log(`\n🎉 Synchronum v1.0.0 is ready to use!`);
    console.log(`👉 Restart Antigravity 2.0 to access the Synchronum dashboard in Auxiliary Pane.`);
    console.log(`👉 Or run: synchronum sync (to sync right away)\n`);
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
  .command('hook-stop')
  .description('Notify Synchronum that an Antigravity generation/task has stopped (debounced auto-sync)')
  .action(async () => {
    try {
      const running = await isServiceRunning();
      if (running.running) {
        const req = http.request(
          `http://127.0.0.1:${running.port}/api/hook/stop`,
          { method: 'POST', timeout: 3000 },
          () => process.exit(0)
        );
        req.on('error', () => process.exit(0));
        req.end();
      } else {
        process.exit(0);
      }
    } catch {
      process.exit(0);
    }
  });

program
  .command('sync')
  .description('Perform full two-way E2EE sync of sessions, workspaces, and tombstones')
  .option('-p, --password <password>', 'Master password for E2EE')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const pwd = options.password || config.masterPassword;
      if (!pwd) {
        console.error('\n❌ Master password is required for sync. Provide -p "password" or set in config.\n');
        process.exit(1);
      }
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      console.log(`\n🔄 Running two-way sync via ${storage.name}...`);
      const result = await engine.syncAll(pwd);
      console.log('\n=== Synchronum Sync Result ===');
      console.log(`Sessions Pushed:     ${result.pushed.length} (${result.pushed.join(', ') || 'None'})`);
      console.log(`Sessions Restored:   ${result.restored.length} (${result.restored.join(', ') || 'None'})`);
      console.log(`Sessions Deleted:    ${result.deletedSessions?.length || 0} (${result.deletedSessions?.join(', ') || 'None'})`);
      console.log(`Workspaces Pushed:   ${result.pushedWorkspaces?.length || 0} (${result.pushedWorkspaces?.join(', ') || 'None'})`);
      console.log(`Workspaces Restored: ${result.restoredWorkspaces?.length || 0} (${result.restoredWorkspaces?.join(', ') || 'None'})`);
      console.log(`Workspaces Skipped:  ${result.skippedWorkspaces?.length || 0}`);
      repairAndReconcileAll();
      console.log('\n✅ Antigravity environment updated!\n');
    } catch (err: any) {
      console.error(`\n❌ Sync failed: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('push-workspace <projectId>')
  .description('Encrypt and upload a non-git project workspace to cloud')
  .option('-p, --password <password>', 'Master password for E2EE encryption')
  .action(async (projectId, options) => {
    try {
      const config = loadConfig();
      const pwd = options.password || config.masterPassword;
      if (!pwd) {
        console.error('\n❌ Master password is required.\n');
        process.exit(1);
      }
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      console.log(`\n🔄 Packaging and uploading workspace: ${projectId}...`);
      const res = await engine.pushWorkspace(projectId, pwd);
      console.log(`✅ Successfully uploaded workspace [${res.projectName}]!`);
      console.log(`   Hash:  ${res.hash}`);
      console.log(`   Size:  ${(res.bytes / 1024).toFixed(2)} KB\n`);
    } catch (err: any) {
      console.error(`\n❌ Failed to push workspace: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('delete-session <conversationId>')
  .description('Delete a conversation, set a tombstone, and remove local files')
  .action(async (conversationId) => {
    try {
      const paths = getAntigravityPaths();
      const sqlite = new AntigravitySqlite(paths.summariesDbPath);
      const summary = sqlite.getSummary(conversationId);
      const title = summary?.title || summary?.preview || conversationId;

      const config = loadConfig();
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);

      engine.markSessionDeleted(conversationId, title);
      sqlite.deleteSummary(conversationId);
      sqlite.deleteConversationFiles(conversationId, paths.root);

      try {
        syncAgyhubProtoFromDb(paths.summariesDbPath, paths.agyhubProtoPath);
      } catch {}

      console.log(`\n✅ Conversation [${conversationId}] deleted and tombstoned.`);
      console.log(`   Other devices will not restore it, and will delete it upon next sync.\n`);
    } catch (err: any) {
      console.error(`\n❌ Failed to delete conversation: ${err.message}\n`);
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

const deviceCmd = program.command('device').description('Manage device settings and naming');

deviceCmd
  .command('rename <newName>')
  .description('Rename this device for cloud identification')
  .action((newName) => {
    try {
      const updated = renameDevice(newName);
      console.log(`\n✅ Устройство успешно переименовано: "${updated.deviceName}"\n`);
    } catch (err: any) {
      console.error(`\n❌ Ошибка: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('delete <conversationId>')
  .description('Delete a conversation everywhere (locally and from cloud storage with tombstone)')
  .option('-p, --password <password>', 'Master password for cloud authorization')
  .action(async (conversationId, options) => {
    try {
      const config = loadConfig();
      const password = options.password || config.masterPassword;
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);

      console.log(`\n🗑️ Удаление диалога: ${conversationId}...`);
      const result = await engine.deleteSession(conversationId, password);
      console.log(`✅ Диалог "${result.title}" успешно удален отовсюду.`);
      console.log('   Создан tombstone — диалог не будет восстанавливаться с других устройств.\n');
    } catch (err: any) {
      console.error(`\n❌ Ошибка удаления: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Run autonomous file watcher & remote poller daemon directly')
  .option('-p, --password <password>', 'Master password for E2EE sync')
  .action(async (options) => {
    const config = loadConfig();
    const password = options.password || config.masterPassword;
    if (!password) {
      console.error('\n❌ Master password is required for automatic sync. Run: synchronum sync -p <password> first or provide -p\n');
      process.exit(1);
    }
    if (options.password) {
      saveConfig({ masterPassword: options.password });
    }

    const oauth = new GoogleDriveOAuth();
    const storage = createStorageProvider(config, oauth);
    const engine = new SynchronumSyncEngine(storage);
    const watcher = new SynchronumWatcher(engine);

    console.log('\n🚀 Starting Synchronum Autonomous Daemon...');
    console.log(`   Device Name: ${engine.getDeviceName()} (${engine.getDeviceId()})`);
    console.log(`   Storage:     ${storage.getDisplayName()}`);
    console.log('   Press Ctrl+C to stop and flush.\n');

    watcher.start({ debounceMs: 3000, pollIntervalMs: 10000 });
  });

program
  .command('flush')
  .description('Flush and sync all local changes to cloud storage immediately')
  .action(async () => {
    try {
      const config = loadConfig();
      if (!config.masterPassword) {
        console.error('\n❌ Мастер-пароль не задан. Укажите его через: synchronum sync -p <password>\n');
        process.exit(1);
      }
      const oauth = new GoogleDriveOAuth();
      const storage = createStorageProvider(config, oauth);
      const engine = new SynchronumSyncEngine(storage);
      const watcher = new SynchronumWatcher(engine);
      await watcher.flushImmediately();
      console.log('✅ Все изменения успешно отправлены в хранилище.\n');
    } catch (err: any) {
      console.error(`\n❌ Ошибка сброса: ${err.message}\n`);
      process.exit(1);
    }
  });

program.parse(process.argv);
