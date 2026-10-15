import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAntigravityPaths } from './paths.js';
import { PathResolver } from './path-resolver.js';
import { buildUriReplacements, patchProtoTree } from './proto-patcher.js';
import { syncAgyhubProtoFromDb } from './proto-sync.js';
import { AntigravitySqlite } from './sqlite.js';
import { EnhancedConversationSummary, ProjectGroup } from './types.js';

export function ensureOutsideOfProjectConfigExists(): void {
  const paths = getAntigravityPaths();
  fs.mkdirSync(paths.configProjectsDir, { recursive: true });
  const outsidePath = path.join(paths.configProjectsDir, 'outside-of-project.json');
  if (!fs.existsSync(outsidePath)) {
    const config = {
      id: 'outside-of-project',
      name: 'Outside of Project',
      projectResources: { resources: [] },
      settings: {
        fileAccessPolicy: 'AGENT_SETTING_POLICY_ASK',
        internetPolicy: 'AGENT_SETTING_POLICY_ASK',
        autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
        artifactReviewMode: 'ARTIFACT_REVIEW_MODE_ALWAYS',
      },
      isWorkspaceOnly: false,
    };
    fs.writeFileSync(outsidePath, JSON.stringify(config, null, 2), 'utf8');
  }
}

export interface CanonicalProject {
  id: string;
  name: string;
  folderUri: string;
  localPath: string;
  folderExists: boolean;
  gitRemote?: string;
}

export function getLocalProjectsWithDetails(): CanonicalProject[] {
  const paths = getAntigravityPaths();
  if (!fs.existsSync(paths.configProjectsDir)) return [];

  const files = fs.readdirSync(paths.configProjectsDir).filter((f) => f.endsWith('.json') && f !== 'outside-of-project.json');
  const result: CanonicalProject[] = [];

  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(paths.configProjectsDir, f), 'utf8'));
      const folderUri = p.projectResources?.resources?.[0]?.gitFolder?.folderUri || '';
      const localPath = folderUri ? PathResolver.uriToPath(folderUri) : '';
      const folderExists = Boolean(localPath && fs.existsSync(localPath));
      let gitRemote: string | undefined;
      if (folderExists) {
        gitRemote = PathResolver.getGitRemote(localPath) || undefined;
      }
      result.push({
        id: p.id,
        name: p.name,
        folderUri,
        localPath,
        folderExists,
        gitRemote,
      });
    } catch {}
  }

  return result;
}

export function findCanonicalProject(
  projectName?: string,
  gitRemote?: string,
  workspaceUri?: string,
  projectId?: string,
  cachedProjects?: CanonicalProject[]
): CanonicalProject | null {
  const projects = cachedProjects || getLocalProjectsWithDetails();
  if (projects.length === 0) return null;

  const clean = (s?: string) => (s || '').toLowerCase().trim().replace(/[-_]/g, '');
  const cleanTargetName = clean(projectName);
  const targetFolder = workspaceUri ? path.basename(PathResolver.uriToPath(workspaceUri)) : '';
  const cleanTargetFolder = clean(targetFolder);

  // Strategy 1: Prioritize projects whose workspace folder PHYSICALLY EXISTS on this machine!
  const existingOnDisk = projects.filter((p) => p.folderExists);

  // 1a. Match by Git Remote on projects that physically exist on disk
  if (gitRemote) {
    const match = existingOnDisk.find((p) => {
      if (!p.gitRemote) return false;
      return (
        p.gitRemote === gitRemote ||
        clean(p.gitRemote).includes(clean(gitRemote)) ||
        clean(gitRemote).includes(clean(p.gitRemote))
      );
    });
    if (match) return match;
  }

  // 1b. Match by folder name or project name on projects that physically exist on disk
  if (cleanTargetName || cleanTargetFolder) {
    const match = existingOnDisk.find((p) => {
      const pn = clean(p.name);
      const pf = clean(path.basename(p.localPath));
      return (
        (cleanTargetName && (pn === cleanTargetName || pf === cleanTargetName)) ||
        (cleanTargetFolder && (pn === cleanTargetFolder || pf === cleanTargetFolder))
      );
    });
    if (match) return match;
  }

  // 1c. Match special known patterns (e.g. synchronum vs antigravity-synchronum)
  if (cleanTargetName.includes('synchronum') || cleanTargetFolder.includes('synchronum')) {
    const match = existingOnDisk.find((p) => clean(p.name).includes('synchronum'));
    if (match) return match;
  }

  // Strategy 2: If no project physically exists on disk, check non-existing projects
  // 2a. Match by Git Remote
  if (gitRemote) {
    const match = projects.find((p) => {
      if (!p.gitRemote) return false;
      return (
        p.gitRemote === gitRemote ||
        clean(p.gitRemote).includes(clean(gitRemote)) ||
        clean(gitRemote).includes(clean(p.gitRemote))
      );
    });
    if (match) return match;
  }

  // 2b. Match by name
  if (cleanTargetName || cleanTargetFolder) {
    const match = projects.find((p) => {
      const pn = clean(p.name);
      const pf = clean(path.basename(p.localPath));
      return (
        (cleanTargetName && (pn === cleanTargetName || pf === cleanTargetName)) ||
        (cleanTargetFolder && (pn === cleanTargetFolder || pf === cleanTargetFolder))
      );
    });
    if (match) return match;
  }

  // 2c. Substring match
  if (cleanTargetName.length >= 5 || cleanTargetFolder.length >= 5) {
    const match = projects.find((p) => {
      const pn = clean(p.name);
      return (
        (cleanTargetName && (pn.includes(cleanTargetName) || cleanTargetName.includes(pn))) ||
        (cleanTargetFolder && (pn.includes(cleanTargetFolder) || cleanTargetFolder.includes(pn)))
      );
    });
    if (match) return match;
  }

  // 2d. Match by explicit projectId if present
  if (projectId) {
    const match = projects.find((p) => p.id === projectId);
    if (match) return match;
  }

  return null;
}

export function findLocalProjectMatch(
  projectName: string,
  gitRemote?: string,
  workspaceUri?: string
): { id: string; name: string; folderUri: string } | null {
  return findCanonicalProject(projectName, gitRemote, workspaceUri);
}

export function ensureProjectConfigExists(
  projectId: string,
  projectName: string,
  workspaceUri: string
): void {
  if (!projectId || projectId === 'outside-of-project') return;

  const paths = getAntigravityPaths();
  fs.mkdirSync(paths.configProjectsDir, { recursive: true });

  const projectFilePath = path.join(paths.configProjectsDir, `${projectId}.json`);
  if (!fs.existsSync(projectFilePath)) {
    const config = {
      id: projectId,
      name: projectName,
      projectResources: {
        resources: [
          {
            gitFolder: {
              folderUri: workspaceUri,
              defaultBranch: 'main',
            },
          },
        ],
      },
      settings: {
        fileAccessPolicy: 'AGENT_SETTING_POLICY_ASK',
        internetPolicy: 'AGENT_SETTING_POLICY_ASK',
        autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
        artifactReviewMode: 'ARTIFACT_REVIEW_MODE_ALWAYS',
      },
      isWorkspaceOnly: false,
    };
    fs.writeFileSync(projectFilePath, JSON.stringify(config, null, 2), 'utf8');
  }


  // Update projectsOrder in app_storage.json
  try {
    if (fs.existsSync(paths.appStoragePath)) {
      const storage = JSON.parse(fs.readFileSync(paths.appStoragePath, 'utf8'));
      let order: string[] = [];
      try {
        order = JSON.parse(storage.projectsOrder || '[]');
      } catch {}
      if (!order.includes(projectId)) {
        order.push(projectId);
        storage.projectsOrder = JSON.stringify(order);
        fs.writeFileSync(paths.appStoragePath, JSON.stringify(storage, null, 2), 'utf8');
      }
    }
  } catch {}
}

export function ensureConversationLayout(conversationId: string): void {
  try {
    const paths = getAntigravityPaths();
    if (fs.existsSync(paths.appStoragePath)) {
      const storage = JSON.parse(fs.readFileSync(paths.appStoragePath, 'utf8'));
      const key = `antigravity-multi-conversation-layout-v3-${conversationId}`;
      if (!storage[key]) {
        storage[key] = JSON.stringify({
          rootNode: {
            type: 'pane',
            id: 'pane-1',
            cascadeId: conversationId,
          },
          focusedPaneId: 'pane-1',
        });
        fs.writeFileSync(paths.appStoragePath, JSON.stringify(storage, null, 2), 'utf8');
      }
    }
  } catch {}
}

export function enhanceConversation(s: any): EnhancedConversationSummary {
  const displayTitle = s.preview || s.title || (s.last_modified_time ? `Диалог от ${new Date(s.last_modified_time).toLocaleString('ru-RU')}` : 'Диалог без названия');

  let uris: string[] = [];
  try {
    uris = JSON.parse(s.workspace_uris || '[]');
  } catch {}

  const hasWorkspace = Array.isArray(uris) && uris.length > 0;
  const isProject = Boolean(s.project_id && s.project_id !== 'outside-of-project' && hasWorkspace);

  let projectName: string | undefined;
  let gitRemote: string | undefined;
  let gitStatus: 'git_tracked' | 'local_only' | 'no_workspace' = 'no_workspace';

  if (hasWorkspace) {
    const wsPath = PathResolver.uriToPath(uris[0]);
    projectName = path.basename(wsPath);

    if (fs.existsSync(wsPath)) {
      const gitDir = path.join(wsPath, '.git');
      if (fs.existsSync(gitDir)) {
        const remote = PathResolver.getGitRemote(wsPath);
        if (remote) {
          gitRemote = remote;
          gitStatus = 'git_tracked';
        } else {
          gitStatus = 'local_only'; // Local git without remote
        }
      } else {
        gitStatus = 'local_only'; // Plain directory without git
      }
    }
  }

  return {
    ...s,
    display_title: displayTitle,
    is_project: isProject,
    project_name: projectName,
    git_remote: gitRemote,
    git_status: gitStatus,
  };
}

export function getConversationStorageSubpath(s: any, conversationId: string): string {
  const enhanced = enhanceConversation(s);
  if (enhanced.is_project && enhanced.project_name) {
    const safeProject = enhanced.project_name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'project';
    return `projects/${safeProject}/session_${conversationId}.bundle.enc`;
  }
  return `standalone/session_${conversationId}.bundle.enc`;
}

export function getGroupedConversations(sqlite: AntigravitySqlite, limit = 100): {
  projects: ProjectGroup[];
  standalone: EnhancedConversationSummary[];
  totalCount: number;
} {
  const summaries = sqlite.listSummaries(limit);
  const projectsMap = new Map<string, ProjectGroup>();
  const standalone: EnhancedConversationSummary[] = [];

  for (const raw of summaries) {
    const enhanced = enhanceConversation(raw);

    if (enhanced.is_project && enhanced.project_name) {
      let uris: string[] = [];
      try {
        uris = JSON.parse(raw.workspace_uris || '[]');
      } catch {}
      const wsPath = PathResolver.uriToPath(uris[0] || '');
      const groupKey = enhanced.project_name;

      if (!projectsMap.has(groupKey)) {
        projectsMap.set(groupKey, {
          id: raw.project_id,
          name: enhanced.project_name,
          workspacePath: wsPath,
          workspaceUri: uris[0] || '',
          gitRemote: enhanced.git_remote,
          gitStatus: enhanced.git_status,
          lastModifiedTime: raw.last_modified_time,
          sessions: [],
        });
      }

      const group = projectsMap.get(groupKey)!;
      group.sessions.push(enhanced);

      // Track most recent modification for project
      if (new Date(raw.last_modified_time) > new Date(group.lastModifiedTime)) {
        group.lastModifiedTime = raw.last_modified_time;
      }
    } else {
      standalone.push(enhanced);
    }
  }

  const projects = Array.from(projectsMap.values()).sort(
    (a, b) => new Date(b.lastModifiedTime).getTime() - new Date(a.lastModifiedTime).getTime()
  );

  standalone.sort(
    (a, b) => new Date(b.last_modified_time).getTime() - new Date(a.last_modified_time).getTime()
  );

  return {
    projects,
    standalone,
    totalCount: summaries.length,
  };
}

export function repairAndReconcileAll(): {
  remappedCount: number;
  newProjectsCount: number;
  totalProjects: number;
  protoSynced: number;
  layoutsAdded: number;
} {
  const paths = getAntigravityPaths();
  fs.mkdirSync(paths.configProjectsDir, { recursive: true });

  // 1. Ensure outside-of-project.json exists
  ensureOutsideOfProjectConfigExists();

  // 2. Load existing local projects
  // 2. Load existing local projects with full details
  const localProjects = getLocalProjectsWithDetails();

  // 3. Connect to DB and inspect all summaries
  const sqlite = new AntigravitySqlite(paths.summariesDbPath);
  const rows = sqlite.listAllSummariesWithRaw();

  let remappedCount = 0;
  for (const row of rows) {
    if (!row.project_id || row.project_id === 'outside-of-project') continue;

    let uris: string[] = [];
    try {
      uris = JSON.parse(row.workspace_uris || '[]');
    } catch {}
    const primaryUri = uris[0] || '';
    const wsPath = PathResolver.uriToPath(primaryUri);
    const folderName = path.basename(wsPath);
    let gitRemote: string | undefined;
    if (wsPath && fs.existsSync(wsPath)) {
      gitRemote = PathResolver.getGitRemote(wsPath) || undefined;
    }

    // Always find the canonical local project on this machine
    const canonical = findCanonicalProject(folderName, gitRemote, primaryUri, row.project_id, localProjects);

    if (canonical && canonical.id !== row.project_id) {
      // Remap to canonical local project!
      const protoReplacements: [string, string][] = [];
      if (primaryUri && canonical.folderUri && primaryUri !== canonical.folderUri) {
        protoReplacements.push(...buildUriReplacements(primaryUri, canonical.folderUri));
      }
      if (row.project_id && canonical.id && row.project_id !== canonical.id) {
        protoReplacements.push([row.project_id, canonical.id]);
      }

      // Patch trajectory_metadata_blob inside conversations/<id>.db
      if (protoReplacements.length > 0) {
        const convoDbPath = path.join(paths.conversationsDir, `${row.conversation_id}.db`);
        if (fs.existsSync(convoDbPath)) {
          try {
            const convoDb = new DatabaseSync(convoDbPath);
            const blobRow: any = convoDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
            if (blobRow && blobRow.data) {
              const patchedBlob = patchProtoTree(Buffer.from(blobRow.data), protoReplacements);
              if (!patchedBlob.equals(Buffer.from(blobRow.data))) {
                convoDb.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(patchedBlob);
              }
            }
            convoDb.close();
          } catch (err: any) {
            console.warn(`[Repair Trajectory Patch Warning] ${row.conversation_id}:`, err.message);
          }
        }
      }

      // Patch raw_summary BLOB
      let patchedRaw = row.raw_summary;
      if (patchedRaw && protoReplacements.length > 0) {
        try {
          const rawBuf = Buffer.isBuffer(patchedRaw) ? patchedRaw : Buffer.from(patchedRaw);
          patchedRaw = patchProtoTree(rawBuf, protoReplacements);
        } catch (err: any) {
          console.warn(`[Repair Raw Summary Patch Warning] ${row.conversation_id}:`, err.message);
        }
      }

      const newUris = JSON.stringify([canonical.folderUri || primaryUri]);
      sqlite.upsertSummary({
        ...row,
        project_id: canonical.id,
        workspace_uris: newUris,
        raw_summary: patchedRaw,
      });
      remappedCount++;
    } else if (!canonical) {
      // Create project config
      ensureProjectConfigExists(row.project_id, folderName || row.project_id, primaryUri);
      localProjects.push({
        id: row.project_id,
        name: folderName || row.project_id,
        folderUri: primaryUri,
        localPath: wsPath,
        folderExists: fs.existsSync(wsPath),
        gitRemote,
      });
    }
  }

  // 4. Update app_storage.json
  let layoutsAdded = 0;
  let totalProjects = localProjects.length;
  try {
    if (fs.existsSync(paths.appStoragePath)) {
      const storage = JSON.parse(fs.readFileSync(paths.appStoragePath, 'utf8'));
      let order: string[] = [];
      try {
        order = JSON.parse(storage.projectsOrder || '[]');
      } catch {}

      const allConfigIds = fs.readdirSync(paths.configProjectsDir)
        .filter((f) => f.endsWith('.json') && f !== 'outside-of-project.json')
        .map((f) => f.replace('.json', ''));

      for (const cid of allConfigIds) {
        if (!order.includes(cid)) order.push(cid);
      }
      storage.projectsOrder = JSON.stringify(order);
      totalProjects = order.length;

      for (const row of rows) {
        const key = `antigravity-multi-conversation-layout-v3-${row.conversation_id}`;
        if (!storage[key]) {
          storage[key] = JSON.stringify({
            rootNode: { type: 'pane', id: 'pane-1', cascadeId: row.conversation_id },
            focusedPaneId: 'pane-1',
          });
          layoutsAdded++;
        }
      }
      fs.writeFileSync(paths.appStoragePath, JSON.stringify(storage, null, 2), 'utf8');
    }
  } catch {}

  // 5. Rebuild agyhub_summaries_proto.pb
  const protoSynced = syncAgyhubProtoFromDb(paths.summariesDbPath, paths.agyhubProtoPath);

  return {
    remappedCount,
    newProjectsCount: localProjects.length,
    totalProjects,
    protoSynced,
    layoutsAdded,
  };
}
