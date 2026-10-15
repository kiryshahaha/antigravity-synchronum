import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptBuffer, decryptBuffer, isEncryptedBuffer } from './crypto.js';
import { PathResolver } from './path-resolver.js';
import { getAntigravityPaths } from './paths.js';
import { buildUriReplacements, patchProtoTree } from './proto-patcher.js';
import {
  ensureConversationLayout,
  ensureOutsideOfProjectConfigExists,
  ensureProjectConfigExists,
  findCanonicalProject,
  findLocalProjectMatch,
} from './projects.js';
import { syncAgyhubProtoFromDb } from './proto-sync.js';
import { AntigravitySqlite } from './sqlite.js';
import { BundleManifest, ConversationSummary, ExportOptions, ImportOptions } from './types.js';

export class SynchronumBundler {
  private sqlite: AntigravitySqlite;
  private paths = getAntigravityPaths();

  constructor(customAntigravityRoot?: string) {
    if (customAntigravityRoot) {
      this.paths = getAntigravityPaths(customAntigravityRoot);
    }
    this.sqlite = new AntigravitySqlite(this.paths.summariesDbPath);
  }

  public async exportBundle(conversationId: string, options: ExportOptions = {}): Promise<{
    manifest: BundleManifest;
    outputPath: string;
    bytes: number;
    encrypted: boolean;
  }> {
    const summary = this.sqlite.getSummary(conversationId);
    if (!summary) {
      throw new Error(`Conversation not found in database: ${conversationId}`);
    }

    const conversationDbPath = path.join(this.paths.conversationsDir, `${conversationId}.db`);
    const conversationPbPath = path.join(this.paths.conversationsDir, `${conversationId}.pb`);
    let convoFilePath: string | null = null;
    let convoFileExt: string = '.db';

    if (fs.existsSync(conversationDbPath)) {
      convoFilePath = conversationDbPath;
      convoFileExt = '.db';
      // Step 1: Force WAL checkpoint into DB file
      this.sqlite.walCheckpoint(conversationDbPath);
    } else if (fs.existsSync(conversationPbPath)) {
      convoFilePath = conversationPbPath;
      convoFileExt = '.pb';
    }

    // Step 2: Build manifest
    let gitRemote: string | undefined;
    try {
      const uris = JSON.parse(summary.workspace_uris || '[]');
      if (Array.isArray(uris) && uris.length > 0) {
        const workspacePath = PathResolver.uriToPath(uris[0]);
        gitRemote = PathResolver.getGitRemote(workspacePath) || undefined;
      }
    } catch {
      // ignore JSON parse error
    }

    const manifest: BundleManifest = {
      version: 1,
      conversation_id: summary.conversation_id,
      title: summary.title,
      step_count: summary.step_count,
      last_modified_time: summary.last_modified_time,
      summary,
      git_remote: gitRemote,
      exported_at: new Date().toISOString(),
      author_device: `${os.hostname()} (${os.platform()})`,
    };

    // Step 3: Create ZIP package in memory
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    if (convoFilePath) {
      zip.addLocalFile(convoFilePath, '', `conversation${convoFileExt}`);
    }

    // Add brain files if exists and requested
    const brainConvoDir = path.join(this.paths.brainDir, conversationId);
    if (options.includeBrain !== false && fs.existsSync(brainConvoDir)) {
      zip.addLocalFolder(brainConvoDir, 'brain');
    }

    // Add annotation file if exists (for pinned status)
    const annotationPath = path.join(this.paths.annotationsDir, `${conversationId}.pbtxt`);
    if (fs.existsSync(annotationPath)) {
      zip.addLocalFile(annotationPath, '', 'annotation.pbtxt');
    }

    let buffer = zip.toBuffer();
    let isEncrypted = false;

    // Step 4: Encrypt if password provided
    if (options.password) {
      buffer = encryptBuffer(buffer, options.password);
      isEncrypted = true;
    }

    // Step 5: Save output file
    const defaultExt = isEncrypted ? '.bundle.enc' : '.bundle';
    const outputPath = options.outputPath || path.resolve(process.cwd(), `${conversationId}${defaultExt}`);
    fs.writeFileSync(outputPath, buffer);

    return {
      manifest,
      outputPath,
      bytes: buffer.length,
      encrypted: isEncrypted,
    };
  }

  public async importBundle(bundlePath: string, options: ImportOptions = {}): Promise<{
    manifest: BundleManifest;
    conversationId: string;
    filesRestored: number;
  }> {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(`Bundle file does not exist: ${bundlePath}`);
    }

    let buffer: any = fs.readFileSync(bundlePath);

    // Check if bundle is encrypted
    if (isEncryptedBuffer(buffer)) {
      if (!options.password) {
        throw new Error('This bundle is encrypted with E2EE. Please provide the master password via --password');
      }
      buffer = decryptBuffer(buffer, options.password);
    }

    const zip = new (AdmZip as any)(buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
      throw new Error('Invalid bundle: missing manifest.json');
    }

    const manifestText = manifestEntry.getData().toString('utf-8');
    const manifest: BundleManifest = JSON.parse(manifestText);
    const conversationId = manifest.conversation_id;

    if (!conversationId) {
      throw new Error('Invalid manifest: missing conversation_id');
    }

    // Step 1: Restore conversation file (.db or .pb)
    const convoDbEntry = zip.getEntry('conversation.db');
    const convoPbEntry = zip.getEntry('conversation.pb');
    let filesRestored = 0;

    if (convoDbEntry) {
      const targetDbPath = path.join(this.paths.conversationsDir, `${conversationId}.db`);
      fs.mkdirSync(this.paths.conversationsDir, { recursive: true });
      fs.writeFileSync(targetDbPath, convoDbEntry.getData());
      filesRestored++;
    } else if (convoPbEntry) {
      const targetPbPath = path.join(this.paths.conversationsDir, `${conversationId}.pb`);
      fs.mkdirSync(this.paths.conversationsDir, { recursive: true });
      fs.writeFileSync(targetPbPath, convoPbEntry.getData());
      filesRestored++;
    }

    // Step 2: Restore brain directory
    const targetBrainDir = path.join(this.paths.brainDir, conversationId);
    fs.mkdirSync(targetBrainDir, { recursive: true });

    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.startsWith('brain/') && !entry.isDirectory) {
        const relativePath = entry.entryName.substring('brain/'.length);
        const fullDestPath = path.join(targetBrainDir, relativePath);
        fs.mkdirSync(path.dirname(fullDestPath), { recursive: true });
        fs.writeFileSync(fullDestPath, entry.getData());
        filesRestored++;
      }
    }

    // Step 2.1: Restore annotations (pinned status)
    const annotationEntry = zip.getEntry('annotation.pbtxt');
    if (annotationEntry) {
      fs.mkdirSync(this.paths.annotationsDir, { recursive: true });
      const targetAnnotationPath = path.join(this.paths.annotationsDir, `${conversationId}.pbtxt`);
      fs.writeFileSync(targetAnnotationPath, annotationEntry.getData());
      filesRestored++;
    }

    // Step 3: Translate workspace URIs
    const summaries = this.sqlite.listSummaries(100);
    const knownUris = summaries.map((s) => s.workspace_uris);

    const originalSummary = manifest.summary as ConversationSummary;
    const translatedWorkspaceUris = PathResolver.translateWorkspaceUris(
      originalSummary.workspace_uris || '[]',
      {
        targetWorkspace: options.targetWorkspace,
        gitRemote: manifest.git_remote,
        knownWorkspaceUris: knownUris,
      }
    );

    // Match local project_id if the translated workspace uri matches an existing local project
    let targetProjectId = originalSummary.project_id;
    let finalWorkspaceUris = translatedWorkspaceUris;

    try {
      const parsedUris = JSON.parse(translatedWorkspaceUris || '[]');
      if (Array.isArray(parsedUris) && parsedUris.length > 0) {
        const primaryUri = parsedUris[0];
        const wsPath = PathResolver.uriToPath(primaryUri);
        const projectName = path.basename(wsPath) || manifest.title || 'project';

        // 1. Match to the canonical local project on this machine
        const match = findCanonicalProject(projectName, manifest.git_remote, primaryUri, targetProjectId);
        if (match) {
          targetProjectId = match.id;
          if (match.folderUri) {
            finalWorkspaceUris = JSON.stringify([match.folderUri]);
          }
        } else if (targetProjectId && targetProjectId !== 'outside-of-project') {
          // 2. If no local match, ensure project config exists for targetProjectId
          ensureProjectConfigExists(targetProjectId, projectName, primaryUri);
        }
      }
    } catch {}

    // Ensure outside-of-project.json exists
    ensureOutsideOfProjectConfigExists();

    // Ensure layout pane exists for Antigravity
    ensureConversationLayout(conversationId);

    // Extract primary URIs for Protobuf tree replacements
    let origPrimaryUri = '';
    try {
      const origUris = JSON.parse(originalSummary.workspace_uris || '[]');
      if (Array.isArray(origUris) && origUris.length > 0) origPrimaryUri = origUris[0];
    } catch {}

    let targetPrimaryUri = '';
    try {
      const targetUris = JSON.parse(finalWorkspaceUris || '[]');
      if (Array.isArray(targetUris) && targetUris.length > 0) targetPrimaryUri = targetUris[0];
    } catch {}

    const protoReplacements: [string, string][] = [];
    if (origPrimaryUri && targetPrimaryUri && origPrimaryUri !== targetPrimaryUri) {
      protoReplacements.push(...buildUriReplacements(origPrimaryUri, targetPrimaryUri));
    }
    if (originalSummary.project_id && targetProjectId && originalSummary.project_id !== targetProjectId) {
      protoReplacements.push([originalSummary.project_id, targetProjectId]);
    }

    // Step 3.1: Patch trajectory_metadata_blob in conversation.db
    if (convoDbEntry && protoReplacements.length > 0) {
      const targetDbPath = path.join(this.paths.conversationsDir, `${conversationId}.db`);
      if (fs.existsSync(targetDbPath)) {
        try {
          const convoDb = new DatabaseSync(targetDbPath);
          const blobRow: any = convoDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
          if (blobRow && blobRow.data) {
            const patchedBlob = patchProtoTree(Buffer.from(blobRow.data), protoReplacements);
            if (!patchedBlob.equals(Buffer.from(blobRow.data))) {
              convoDb.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(patchedBlob);
            }
          }
          convoDb.close();
        } catch (err: any) {
          console.warn('[Trajectory Patch Warning]', err.message);
        }
      }
    }

    // Step 3.2: Patch raw_summary protobuf for conversation_summaries.db
    let patchedRawSummary = originalSummary.raw_summary;
    if (patchedRawSummary && protoReplacements.length > 0) {
      try {
        let rawBuf: Buffer;
        if (Buffer.isBuffer(patchedRawSummary)) rawBuf = patchedRawSummary;
        else if (patchedRawSummary instanceof Uint8Array) rawBuf = Buffer.from(patchedRawSummary);
        else if (typeof patchedRawSummary === 'object') {
          const vals = Object.values(patchedRawSummary);
          rawBuf = Buffer.from(vals as number[]);
        } else {
          rawBuf = Buffer.from(patchedRawSummary as any);
        }
        patchedRawSummary = patchProtoTree(rawBuf, protoReplacements);
      } catch (err: any) {
        console.warn('[Raw Summary Patch Warning]', err.message);
      }
    }

    const summaryToUpsert: ConversationSummary = {
      ...originalSummary,
      conversation_id: conversationId,
      project_id: targetProjectId,
      raw_summary: patchedRawSummary,
      title: manifest.title || originalSummary.title,
      step_count: manifest.step_count || originalSummary.step_count,
      last_modified_time: manifest.last_modified_time || originalSummary.last_modified_time,
      workspace_uris: finalWorkspaceUris,
    };

    // Step 4: Upsert into conversation_summaries.db
    this.sqlite.upsertSummary(summaryToUpsert);

    // Step 5: Automatically sync agyhub_summaries_proto.pb so Antigravity loads the session natively
    try {
      syncAgyhubProtoFromDb(this.paths.summariesDbPath, this.paths.agyhubProtoPath);
    } catch {}

    return {
      manifest,
      conversationId,
      filesRestored,
    };
  }

  public readManifestOnly(bundlePath: string, password?: string): BundleManifest {
    let buffer: any = fs.readFileSync(bundlePath);
    if (isEncryptedBuffer(buffer)) {
      if (!password) {
        throw new Error('Bundle is encrypted. Provide --password to inspect.');
      }
      buffer = decryptBuffer(buffer, password);
    }
    const zip = new (AdmZip as any)(buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
      throw new Error('Invalid bundle: missing manifest.json');
    }
    return JSON.parse(manifestEntry.getData().toString('utf-8'));
  }
}
