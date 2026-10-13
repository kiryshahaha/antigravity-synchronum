import fs from 'node:fs';
import path from 'node:path';
import { PathResolver } from './path-resolver.js';
import { AntigravitySqlite } from './sqlite.js';
import { EnhancedConversationSummary, ProjectGroup } from './types.js';

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
