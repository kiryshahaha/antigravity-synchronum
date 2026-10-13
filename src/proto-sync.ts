import fs from 'node:fs';
import path from 'node:path';
import { AntigravitySqlite } from './sqlite.js';

function encodeVarint(num: number): Buffer {
  const bytes: number[] = [];
  while (num >= 0x80) {
    bytes.push((num & 0x7f) | 0x80);
    num >>>= 7;
  }
  bytes.push(num);
  return Buffer.from(bytes);
}

export function syncAgyhubProtoFromDb(summariesDbPath: string, agyhubProtoPath: string): number {
  if (!fs.existsSync(summariesDbPath)) return 0;

  const sqlite = new AntigravitySqlite(summariesDbPath);
  const rows = sqlite.listSummariesWithRawBlob();
  if (!rows || rows.length === 0) return 0;

  const entryBuffers: Buffer[] = [];
  for (const row of rows) {
    if (!row.raw_summary || row.raw_summary.length === 0) continue;
    const idBuf = Buffer.from(row.conversation_id, 'utf8');
    const rawBuf = Buffer.from(row.raw_summary);

    // Subfield 1: conversation_id (tag 0x0a = field 1, wire 2)
    const f1 = Buffer.concat([Buffer.from([0x0a]), encodeVarint(idBuf.length), idBuf]);
    // Subfield 2: raw_summary (tag 0x12 = field 2, wire 2)
    const f2 = Buffer.concat([Buffer.from([0x12]), encodeVarint(rawBuf.length), rawBuf]);
    const entryContent = Buffer.concat([f1, f2]);

    // Top-level repeated entry (tag 0x0a = field 1, wire 2)
    const entry = Buffer.concat([Buffer.from([0x0a]), encodeVarint(entryContent.length), entryContent]);
    entryBuffers.push(entry);
  }

  const fullBuf = Buffer.concat(entryBuffers);
  fs.mkdirSync(path.dirname(agyhubProtoPath), { recursive: true });
  fs.writeFileSync(agyhubProtoPath, fullBuf);
  return entryBuffers.length;
}
