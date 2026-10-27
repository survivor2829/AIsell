// Minimal read-only SQLite reader: walks table b-trees and decodes records. It covers what the
// WeChat receipts need (full scans of a few tables in decrypted copies) without a native module.
"use strict";

function readVarint(buffer, offset) {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    const byte = buffer[offset + index];
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, length: index + 1 };
  }
  value = (value << 8n) | BigInt(buffer[offset + 8]);
  return { value, length: 9 };
}

function decodeValue(serialType, buffer, offset) {
  const type = Number(serialType);
  switch (type) {
    case 0: return { value: null, length: 0 };
    case 1: return { value: buffer.readInt8(offset), length: 1 };
    case 2: return { value: buffer.readInt16BE(offset), length: 2 };
    case 3: return { value: buffer.readIntBE(offset, 3), length: 3 };
    case 4: return { value: buffer.readInt32BE(offset), length: 4 };
    case 5: return { value: Number(buffer.readIntBE(offset, 6)), length: 6 };
    // 64-bit ids (e.g. Moments tids) keep full precision as decimal strings.
    case 6: { const big = buffer.readBigInt64BE(offset); return { value: Number.isSafeInteger(Number(big)) ? Number(big) : big.toString(), length: 8 }; }
    case 7: return { value: buffer.readDoubleBE(offset), length: 8 };
    case 8: return { value: 0, length: 0 };
    case 9: return { value: 1, length: 0 };
    default: {
      if (type >= 12 && type % 2 === 0) { const length = (type - 12) / 2; return { value: buffer.subarray(offset, offset + length), length }; }
      if (type >= 13) { const length = (type - 13) / 2; return { value: buffer.subarray(offset, offset + length).toString("utf8"), length }; }
      throw new Error(`unsupported serial type ${type}`);
    }
  }
}

function decodeRecord(payload) {
  const header = readVarint(payload, 0);
  const headerSize = Number(header.value);
  const types = [];
  let cursor = header.length;
  while (cursor < headerSize) { const item = readVarint(payload, cursor); types.push(item.value); cursor += item.length; }
  const values = [];
  let body = headerSize;
  for (const type of types) { const decoded = decodeValue(type, payload, body); values.push(decoded.value); body += decoded.length; }
  return values;
}

function openDatabase(buffer) {
  if (buffer.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("not a SQLite database");
  let pageSize = buffer.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const reserved = buffer[20];
  const usable = pageSize - reserved;
  const page = (number) => buffer.subarray((number - 1) * pageSize, number * pageSize);

  function payloadOf(pageBuffer, cellOffset, payloadSize, headerLength) {
    const maxLocal = usable - 35;
    const start = cellOffset + headerLength;
    if (payloadSize <= maxLocal) return pageBuffer.subarray(start, start + payloadSize);
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
    let local = minLocal + ((payloadSize - minLocal) % (usable - 4));
    if (local > maxLocal) local = minLocal;
    const parts = [pageBuffer.subarray(start, start + local)];
    let remaining = payloadSize - local;
    let overflow = pageBuffer.readUInt32BE(start + local);
    while (remaining > 0 && overflow) {
      const next = page(overflow);
      const take = Math.min(remaining, usable - 4);
      parts.push(next.subarray(4, 4 + take));
      remaining -= take;
      overflow = next.readUInt32BE(0);
    }
    return Buffer.concat(parts);
  }

  function* scanTable(rootPage) {
    const stack = [rootPage];
    while (stack.length) {
      const number = stack.pop();
      const pageBuffer = page(number);
      const base = number === 1 ? 100 : 0;
      const kind = pageBuffer[base];
      const cells = pageBuffer.readUInt16BE(base + 3);
      const headerSize = kind === 0x05 || kind === 0x02 ? 12 : 8;
      if (kind === 0x05) {
        // Interior table page: visit children right to left so the stack yields rows in order.
        const children = [];
        for (let index = 0; index < cells; index += 1) children.push(pageBuffer.readUInt32BE(pageBuffer.readUInt16BE(base + headerSize + index * 2)));
        children.push(pageBuffer.readUInt32BE(base + 8));
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
        continue;
      }
      if (kind !== 0x0d) continue;
      for (let index = 0; index < cells; index += 1) {
        const cellOffset = pageBuffer.readUInt16BE(base + headerSize + index * 2);
        const size = readVarint(pageBuffer, cellOffset);
        const rowid = readVarint(pageBuffer, cellOffset + size.length);
        const payload = payloadOf(pageBuffer, cellOffset, Number(size.value), size.length + rowid.length);
        yield { rowid: Number(rowid.value), values: decodeRecord(payload) };
      }
    }
  }

  const schema = [...scanTable(1)].map(({ values }) => ({ type: values[0], name: values[1], table: values[2], rootPage: values[3], sql: values[4] }));
  function columns(table) {
    const entry = schema.find((item) => item.type === "table" && item.name === table);
    if (!entry) return null;
    const body = String(entry.sql).slice(String(entry.sql).indexOf("(") + 1, String(entry.sql).lastIndexOf(")"));
    const names = [];
    let depth = 0, current = "";
    for (const character of body) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) { names.push(current); current = ""; } else current += character;
    }
    names.push(current);
    return names.map((part) => part.trim()).filter((part) => part && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/iu.test(part))
      .map((part) => part.split(/\s+/u)[0].replace(/^["`[]|["`\]]$/gu, ""));
  }
  return {
    tables: () => schema.filter((item) => item.type === "table").map((item) => item.name),
    // Rows as objects; an INTEGER PRIMARY KEY column (stored as NULL) takes the rowid.
    *rows(table) {
      const entry = schema.find((item) => item.type === "table" && item.name === table);
      if (!entry) return;
      const names = columns(table);
      for (const { rowid, values } of scanTable(entry.rootPage)) {
        const row = {};
        names.forEach((name, index) => { row[name] = values[index] === undefined || values[index] === null ? (index === 0 ? rowid : null) : values[index]; });
        yield row;
      }
    }
  };
}

module.exports = { openDatabase, decodeRecord, readVarint };
