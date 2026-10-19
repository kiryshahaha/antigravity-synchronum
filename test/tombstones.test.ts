import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TombstoneManager } from '../src/tombstones.js';

describe('TombstoneManager Module', () => {
  const manager = new TombstoneManager();
  const testId = `test_convo_${Date.now()}`;

  it('should initially report unknown session as not deleted', () => {
    assert.equal(manager.isDeleted(`non_existent_${Date.now()}`), false);
  });

  it('should record local tombstone and report it as deleted', () => {
    manager.recordLocalTombstone(testId, 'Test Conversation to Delete');
    assert.equal(manager.isDeleted(testId), true);
  });

  it('should correctly compare deletion time against lastModifiedIso', () => {
    const olderTime = new Date(Date.now() - 60000).toISOString();
    const newerTime = new Date(Date.now() + 60000).toISOString();

    // Deleted after modification -> isDeleted is true
    assert.equal(manager.isDeleted(testId, olderTime), true);

    // Modified after deletion -> isDeleted is false
    assert.equal(manager.isDeleted(testId, newerTime), false);
  });

  it('should merge remote tombstones without losing data', () => {
    const remoteId = `remote_convo_${Date.now()}`;
    manager.mergeRemoteTombstones({
      [remoteId]: {
        conversation_id: remoteId,
        deleted_at: new Date().toISOString(),
        deleted_by_device: 'Laptop-Other',
        title: 'Remote Deleted Session',
      },
    });

    assert.equal(manager.isDeleted(remoteId), true);
  });
});
