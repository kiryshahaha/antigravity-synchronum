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
