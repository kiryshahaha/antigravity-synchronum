import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ConversationSummary } from './types.js';

export class AntigravitySqlite {
  constructor(private summariesDbPath: string) {}

  public walCheckpoint(dbPath: string): void {
    if (!fs.existsSync(dbPath)) return;
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare('PRAGMA wal_checkpoint(PASSIVE)').all();
      db.close();
    } catch (err) {
      console.warn(`[WAL Checkpoint] Warning for ${path.basename(dbPath)}:`, err);
    }
  }

  public listSummaries(limit = 20): ConversationSummary[] {
    const db = new DatabaseSync(this.summariesDbPath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT 
          conversation_id, title, preview, step_count, last_modified_time, 
          workspace_uris, status, source, project_id, agent_name, 
          parent_conversation_id, nesting_depth, battle_id, winning_conversation_id, 
          not_fully_idle, killed, last_user_input_time, last_user_input_step_index, 
          app_data_dir, group_id
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
        LIMIT ?
      `);
      return stmt.all(limit) as unknown as ConversationSummary[];
    } finally {
      db.close();
    }
  }

  public listSummariesWithRawBlob(): { conversation_id: string; raw_summary: Buffer }[] {
    const db = new DatabaseSync(this.summariesDbPath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT conversation_id, raw_summary 
        FROM conversation_summaries
        WHERE raw_summary IS NOT NULL AND length(raw_summary) > 0
        ORDER BY last_modified_time DESC
      `);
      return stmt.all() as unknown as { conversation_id: string; raw_summary: Buffer }[];
    } finally {
      db.close();
    }
  }

  public listAllSummariesWithRaw(): ConversationSummary[] {
    const db = new DatabaseSync(this.summariesDbPath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT * 
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
      `);
      return stmt.all() as unknown as ConversationSummary[];
    } finally {
      db.close();
    }
  }

  public getSummary(conversationId: string): ConversationSummary | null {
    const db = new DatabaseSync(this.summariesDbPath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT * FROM conversation_summaries
        WHERE conversation_id = ?
        LIMIT 1
      `);
      const row = stmt.get(conversationId);
      return (row as unknown as ConversationSummary) || null;
    } finally {
      db.close();
    }
  }

  public upsertSummary(summary: ConversationSummary): void {
    const db = new DatabaseSync(this.summariesDbPath);
    try {
      // Ensure WAL mode and busy timeout to avoid contention with Antigravity
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');

      const stmt = db.prepare(`
        INSERT INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, agent_name,
          parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
          not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
          app_data_dir, raw_summary, group_id
        ) VALUES (
          @conversation_id, @title, @preview, @step_count, @last_modified_time,
          @workspace_uris, @status, @source, @project_id, @agent_name,
          @parent_conversation_id, @nesting_depth, @battle_id, @winning_conversation_id,
          @not_fully_idle, @killed, @last_user_input_time, @last_user_input_step_index,
          @app_data_dir, @raw_summary, @group_id
        )
        ON CONFLICT(conversation_id) DO UPDATE SET
          title = excluded.title,
          preview = excluded.preview,
          step_count = excluded.step_count,
          last_modified_time = excluded.last_modified_time,
          workspace_uris = excluded.workspace_uris,
          status = excluded.status,
          project_id = excluded.project_id,
          raw_summary = COALESCE(excluded.raw_summary, conversation_summaries.raw_summary),
          group_id = excluded.group_id;
      `);

      stmt.run({
        conversation_id: summary.conversation_id,
        title: summary.title ?? '',
        preview: summary.preview ?? '',
        step_count: summary.step_count ?? 0,
        last_modified_time: summary.last_modified_time ?? new Date().toISOString(),
        workspace_uris: summary.workspace_uris ?? '[]',
        status: summary.status ?? 'COMPLETED',
        source: summary.source ?? '',
        project_id: summary.project_id ?? '',
        agent_name: summary.agent_name ?? '',
        parent_conversation_id: summary.parent_conversation_id ?? '',
        nesting_depth: summary.nesting_depth ?? 0,
        battle_id: summary.battle_id ?? '',
        winning_conversation_id: summary.winning_conversation_id ?? '',
        not_fully_idle: summary.not_fully_idle ? 1 : 0,
        killed: summary.killed ? 1 : 0,
        last_user_input_time: summary.last_user_input_time ?? null,
        last_user_input_step_index: summary.last_user_input_step_index ?? -1,
        app_data_dir: summary.app_data_dir ?? '',
        raw_summary: (() => {
          if (!summary.raw_summary) return null;
          if (Buffer.isBuffer(summary.raw_summary)) return summary.raw_summary;
          if (summary.raw_summary instanceof Uint8Array) return Buffer.from(summary.raw_summary);
          if (typeof summary.raw_summary === 'object') {
            if ('data' in summary.raw_summary && Array.isArray((summary.raw_summary as any).data)) {
              return Buffer.from((summary.raw_summary as any).data);
            }
            if (Array.isArray(summary.raw_summary)) {
              return Buffer.from(summary.raw_summary);
            }
            const vals = Object.values(summary.raw_summary);
            if (vals.length > 0 && typeof vals[0] === 'number') {
              return Buffer.from(vals as number[]);
            }
          }
          if (typeof summary.raw_summary === 'string') {
            try {
              return Buffer.from(summary.raw_summary, 'base64');
            } catch {}
          }
          return null;
        })(),
        group_id: summary.group_id ?? ''
      });
    } finally {
      db.close();
    }
  }

  public deleteSummary(conversationId: string): boolean {
    if (!fs.existsSync(this.summariesDbPath)) return false;
    const db = new DatabaseSync(this.summariesDbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 5000;');
      const stmt = db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?');
      const result = stmt.run(conversationId) as any;
      try {
        db.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(conversationId);
      } catch {}
      return Boolean(result && result.changes && result.changes > 0);
    } finally {
      db.close();
    }
  }

  public checkpoint(): void {
    this.walCheckpoint(this.summariesDbPath);
  }

  public deleteConversationFiles(conversationId: string, customAntigravityRoot?: string): void {
    const root = customAntigravityRoot || path.dirname(this.summariesDbPath);
    const convoDb = path.join(root, 'conversations', `${conversationId}.db`);
    const convoDbWal = path.join(root, 'conversations', `${conversationId}.db-wal`);
    const convoDbShm = path.join(root, 'conversations', `${conversationId}.db-shm`);
    const convoPb = path.join(root, 'conversations', `${conversationId}.pb`);
    const brainDir = path.join(root, 'brain', conversationId);

    const removeFileSafe = (p: string) => {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    };

    removeFileSafe(convoDb);
    removeFileSafe(convoDbWal);
    removeFileSafe(convoDbShm);
    removeFileSafe(convoPb);

    try {
      if (fs.existsSync(brainDir)) {
        fs.rmSync(brainDir, { recursive: true, force: true });
      }
    } catch {}

    // Clean layout key in app_storage.json
    try {
      const appStorage = path.join(root, '..', 'app_storage.json');
      if (fs.existsSync(appStorage)) {
        const storage = JSON.parse(fs.readFileSync(appStorage, 'utf8'));
        const layoutKey = `antigravity-multi-conversation-layout-v3-${conversationId}`;
        if (storage[layoutKey]) {
          delete storage[layoutKey];
          fs.writeFileSync(appStorage, JSON.stringify(storage, null, 2), 'utf8');
        }
      }
    } catch {}
  }
}

