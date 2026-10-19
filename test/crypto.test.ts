import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptBuffer, deriveKey, encryptBuffer, isEncryptedBuffer } from '../src/crypto.js';

describe('Crypto Module (Zero-Knowledge E2EE)', () => {
  const password = 'SuperSecretMasterPassword123!';
  const plainText = 'Hello Antigravity 2.0! This is secret conversation context.';
  const plainBuffer = Buffer.from(plainText, 'utf-8');

  it('should derive deterministic 32-byte key for same salt', () => {
    const salt = Buffer.alloc(16, 42);
    const key1 = deriveKey(password, salt);
    const key2 = deriveKey(password, salt);

    assert.equal(key1.length, 32);
    assert.deepEqual(key1, key2);
  });

  it('should correctly encrypt and detect encrypted buffer header', () => {
    const encrypted = encryptBuffer(plainBuffer, password);

    assert.ok(isEncryptedBuffer(encrypted));
    assert.notDeepEqual(encrypted, plainBuffer);
    assert.ok(encrypted.length > plainBuffer.length);
  });

  it('should correctly decrypt with valid password', () => {
    const encrypted = encryptBuffer(plainBuffer, password);
    const decrypted = decryptBuffer(encrypted, password);

    assert.equal(decrypted.toString('utf-8'), plainText);
  });

  it('should fail decryption when password is wrong', () => {
    const encrypted = encryptBuffer(plainBuffer, password);

    assert.throws(
      () => decryptBuffer(encrypted, 'WrongPassword'),
      /Decryption failed: Incorrect master password or corrupted data/
    );
  });

  it('should reject unencrypted plain buffer', () => {
    assert.equal(isEncryptedBuffer(plainBuffer), false);
    assert.throws(
      () => decryptBuffer(plainBuffer, password),
      /Data does not contain valid Synchronum encryption header/
    );
  });
});
