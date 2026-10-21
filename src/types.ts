export interface ConversationSummary {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  source: string;
  project_id: string;
  agent_name: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
  battle_id?: string;
  winning_conversation_id?: string;
  not_fully_idle?: number;
  killed?: number;
  last_user_input_time?: string;
  last_user_input_step_index?: number;
  app_data_dir?: string;
  raw_summary?: Buffer | Uint8Array | null;
  group_id?: string;
}

export interface BundleManifest {
  version: number;
  conversation_id: string;
  title: string;
  step_count: number;
  last_modified_time: string;
  summary: Partial<ConversationSummary>;
  git_remote?: string;
  git_branch?: string;
  workspace_relative_path?: string;
  exported_at: string;
  author_device: string;
}

export interface ImportOptions {
  password?: string;
  targetWorkspace?: string;
  conflictStrategy?: 'fork' | 'overwrite' | 'skip';
}

export interface ExportOptions {
  outputPath?: string;
  password?: string;
  includeBrain?: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  updated_at: string;
  sessions_count: number;
  machine_id?: string;
}

export interface EnhancedConversationSummary extends ConversationSummary {
  display_title: string;
  is_project: boolean;
  project_name?: string;
  git_remote?: string;
  git_status: 'git_tracked' | 'local_only' | 'no_workspace';
}

export interface ProjectGroup {
  id: string;
  name: string;
  workspacePath: string;
  workspaceUri: string;
  gitRemote?: string;
  gitStatus: 'git_tracked' | 'local_only' | 'no_workspace';
  lastModifiedTime: string;
  sessions: EnhancedConversationSummary[];
  workspaceHash?: string;
  workspaceFileCount?: number;
  workspaceSizeBytes?: number;
  workspaceSynced?: boolean;
}

export interface WorkspaceMeta {
  project_id: string;
  project_name: string;
  workspace_hash: string;
  file_count: number;
  total_bytes: number;
  last_modified_time: string;
  author_device: string;
}

export interface RemoteWorkspaceEntry {
  project_id: string;
  project_name: string;
  workspace_hash: string;
  file_name: string;
  file_id: string;
  size_bytes: number;
  file_count: number;
  updated_at: string;
  author_device: string;
  deleted?: boolean;
  deleted_at?: string;
}

export interface SessionTombstone {
  conversation_id: string;
  deleted_at: string;
  title?: string;
  author_device?: string;
}

