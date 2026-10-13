import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAntigravityPaths } from './paths.js';
import { PathResolver } from './path-resolver.js';
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

export function findLocalProjectMatch(
  projectName: string,
  gitRemote?: string,
  workspaceUri?: string
): { id: string; name: string; folderUri: string } | null {
  const paths = getAntigravityPaths();
  if (!fs.existsSync(paths.configProjectsDir)) return null;

  const files = fs.readdirSync(paths.configProjectsDir).filter((f) => f.endsWith('.json') && f !== 'outside-of-project.json');
  const localProjects: Array<{ id: string; name: string; folderUri: string }> = [];

  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(paths.configProjectsDir, f), 'utf8'));
      const folderUri = p.projectResources?.resources?.[0]?.gitFolder?.folderUri || '';
      localProjects.push({ id: p.id, name: p.name, folderUri });
    } catch {}
  }

  const cleanName = (n: string) => n.toLowerCase().trim().replace(/[-_]/g, '');

  // 1. Match by git remote if available
  if (gitRemote) {
    for (const lp of localProjects) {
      if (lp.folderUri) {
        const localPath = PathResolver.uriToPath(lp.folderUri);
        const localRemote = PathResolver.getGitRemote(localPath);
        if (localRemote && (localRemote === gitRemote || localRemote.endsWith(gitRemote) || gitRemote.endsWith(localRemote))) {
          return lp;
        }
      }
    }
  }

  // 2. Match by exact folder name or project name
  for (const lp of localProjects) {
    if (cleanName(lp.name) === cleanName(projectName)) {
      return lp;
    }
    if (lp.folderUri) {
      const lpFolderName = path.basename(PathResolver.uriToPath(lp.folderUri));
      if (cleanName(lpFolderName) === cleanName(projectName)) {
        return lp;
      }
    }
  }

  // 3. Match substrings (e.g. synchronum vs antigravity-synchronum)
  for (const lp of localProjects) {
    const lpn = cleanName(lp.name);
    const pn = cleanName(projectName);
    if ((lpn.includes(pn) || pn.includes(lpn)) && lpn.length >= 5 && pn.length >= 5) {
      return lp;
    }
  }

  return null;
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
