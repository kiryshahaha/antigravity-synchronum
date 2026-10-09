import crypto from 'node:crypto';

const MAGIC_HEADER = Buffer.from('SYNC_E2EE_V1');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH);
}

export function encryptBuffer(data: Buffer, password: string): Buffer {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    MAGIC_HEADER,
    salt,
    iv,
    tag,
    encrypted,
  ]);
}

export function isEncryptedBuffer(data: Buffer): boolean {
  if (data.length < MAGIC_HEADER.length) return false;
  return data.subarray(0, MAGIC_HEADER.length).equals(MAGIC_HEADER);
}

export function decryptBuffer(data: Buffer, password: string): Buffer {
  if (!isEncryptedBuffer(data)) {
    throw new Error('Data does not contain valid Synchronum encryption header');
  }

  let offset = MAGIC_HEADER.length;
  const salt = data.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;

  const iv = data.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;

  const tag = data.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;

  const encrypted = data.subarray(offset);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error('Decryption failed: Incorrect master password or corrupted data');
  }
}
