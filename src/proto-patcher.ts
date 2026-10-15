export interface ProtoField {
  fieldNum: number;
  wireType: number;
  val: any;
}

export function decodeVarint(buf: Buffer, offset: number): { value: bigint; bytesRead: number } {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const b = BigInt(buf[offset + bytesRead]);
    bytesRead++;
    value |= (b & 0x7fn) << shift;
    if (!(b & 0x80n)) break;
    shift += 7n;
  }

  return { value, bytesRead };
}

export function encodeVarint(val: bigint | number): Buffer {
  let v = BigInt(val);
  const bytes: number[] = [];

  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return Buffer.from(bytes);
}

export function decodeProtoFields(buf: Buffer): ProtoField[] {
  let offset = 0;
  const fields: ProtoField[] = [];

  while (offset < buf.length) {
    const { value: tagBig, bytesRead: tagBytes } = decodeVarint(buf, offset);
    if (tagBytes === 0) break;
    offset += tagBytes;

    const tag = Number(tagBig);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNum === 0) break;

    let val: any;
    if (wireType === 0) {
      // Varint
      const { value, bytesRead } = decodeVarint(buf, offset);
      val = value;
      offset += bytesRead;
    } else if (wireType === 1) {
      // 64-bit
      if (offset + 8 > buf.length) break;
      val = buf.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 5) {
      // 32-bit
      if (offset + 4 > buf.length) break;
      val = buf.subarray(offset, offset + 4);
      offset += 4;
    } else if (wireType === 2) {
      // Length-delimited
      const { value: lenBig, bytesRead: lenBytes } = decodeVarint(buf, offset);
      offset += lenBytes;
      const len = Number(lenBig);
      if (offset + len > buf.length) break;
      val = buf.subarray(offset, offset + len);
      offset += len;
    } else {
      // Unsupported wire type (group deprecated etc.)
      break;
    }

    fields.push({ fieldNum, wireType, val });
  }

  return fields;
}

export function encodeProtoFields(fields: ProtoField[]): Buffer {
  const chunks: Buffer[] = [];

  for (const f of fields) {
    const tag = (f.fieldNum << 3) | f.wireType;
    chunks.push(encodeVarint(tag));

    if (f.wireType === 0) {
      chunks.push(encodeVarint(f.val));
    } else if (f.wireType === 1 || f.wireType === 5) {
      chunks.push(f.val);
    } else if (f.wireType === 2) {
      chunks.push(encodeVarint(f.val.length));
      chunks.push(f.val);
    }
  }

  return Buffer.concat(chunks);
}

export function patchProtoTree(buf: Buffer, replacements: [string, string][]): Buffer {
  if (!buf || buf.length === 0 || replacements.length === 0) return buf;

  let fields: ProtoField[];
  try {
    fields = decodeProtoFields(buf);
    if (fields.length === 0) return buf;
  } catch {
    return buf;
  }

  let modified = false;

  for (const f of fields) {
    if (f.wireType === 2 && Buffer.isBuffer(f.val)) {
      // Check if it's a valid submessage
      try {
        const subfields = decodeProtoFields(f.val);
        // Valid submessages must re-encode to the exact same bytes before patching
        if (subfields.length > 0) {
          const reencoded = encodeProtoFields(subfields);
          if (reencoded.equals(f.val)) {
            const patchedSub = patchProtoTree(f.val, replacements);
            if (!patchedSub.equals(f.val)) {
              f.val = patchedSub;
              modified = true;
              continue;
            }
          }
        }
      } catch {}

      // Treat as string or leaf bytes
      let str = f.val.toString('utf-8');
      let strChanged = false;
      for (const [from, to] of replacements) {
        if (from && to && str.includes(from)) {
          str = str.replaceAll(from, to);
          strChanged = true;
        }
      }

      if (strChanged) {
        f.val = Buffer.from(str, 'utf-8');
        modified = true;
      }
    }
  }

  return modified ? encodeProtoFields(fields) : buf;
}

export function buildUriReplacements(fromUri: string, toUri: string): [string, string][] {
  if (!fromUri || !toUri || fromUri === toUri) return [];

  const pairs: [string, string][] = [];

  // Plain uri (e.g. file:///c:/Users/...)
  const plainFrom = fromUri.replace(/%3a/gi, ':');
  const plainTo = toUri.replace(/%3a/gi, ':');
  pairs.push([plainFrom, plainTo]);

  // URL encoded drive colon (e.g. file:///c%3A/Users/...)
  const encodedFrom = plainFrom.replace(/file:\/\/\/([a-zA-Z]):/, 'file:///$1%3A');
  const encodedTo = plainTo.replace(/file:\/\/\/([a-zA-Z]):/, 'file:///$1%3A');
  if (encodedFrom !== plainFrom || encodedTo !== plainTo) {
    pairs.push([encodedFrom, encodedTo]);
  }

  // Double encoded if any
  const doubleEncodedFrom = plainFrom.replace(/file:\/\/\/([a-zA-Z]):/, 'file:///$1%253A');
  const doubleEncodedTo = plainTo.replace(/file:\/\/\/([a-zA-Z]):/, 'file:///$1%253A');
  pairs.push([doubleEncodedFrom, doubleEncodedTo]);

  // Backslash windows path variants (e.g. C:\Users\... or c:\Users\...)
  return pairs;
}
