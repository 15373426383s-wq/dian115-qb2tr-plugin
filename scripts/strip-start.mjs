// 从 wasm 二进制的 export section 中删除 _start 导出，使其成为 reactor 模块
import fs from 'node:fs';

const file = process.argv[2] || 'plugin.wasm';
const buf = fs.readFileSync(file);

function readLEB128(buf, offset) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

function writeLEB128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

let offset = 8; // skip magic(4) + version(4)
while (offset < buf.length) {
  const sectionIdPos = offset;
  const sectionId = buf[offset++];
  const { value: sectionLen, offset: contentStart } = readLEB128(buf, offset);
  const sectionEnd = contentStart + sectionLen;

  if (sectionId === 7) { // export section
    let pos = contentStart;
    const { value: numExports, offset: exportsStart } = readLEB128(buf, pos);
    pos = exportsStart;

    let startEntry = null;
    for (let i = 0; i < numExports; i++) {
      const entryStart = pos;
      const { value: nameLen, offset: nameStart } = readLEB128(buf, pos);
      pos = nameStart;
      const name = buf.toString('utf8', pos, pos + nameLen);
      pos += nameLen;
      pos++; // kind
      const { offset: afterIndex } = readLEB128(buf, pos);
      pos = afterIndex;
      if (name === '_start') {
        startEntry = { start: entryStart, end: pos };
      }
    }

    if (!startEntry) {
      console.log('_start not found, nothing to do');
      process.exit(0);
    }

    // 构建新的 export section content
    const newNumExportsBytes = writeLEB128(numExports - 1);
    const contentBefore = buf.slice(exportsStart, startEntry.start);
    const contentAfter = buf.slice(startEntry.end, sectionEnd);
    const newContent = Buffer.concat([newNumExportsBytes, contentBefore, contentAfter]);

    // 构建新 section
    const newSection = Buffer.concat([
      Buffer.from([7]),
      writeLEB128(newContent.length),
      newContent,
    ]);

    // 拼接最终文件
    const result = Buffer.concat([
      buf.slice(0, sectionIdPos),
      newSection,
      buf.slice(sectionEnd),
    ]);

    fs.writeFileSync(file, result);
    console.log(`Removed _start export. Size: ${buf.length} -> ${result.length} bytes`);
    process.exit(0);
  }

  offset = sectionEnd;
}

console.log('Export section not found');
process.exit(1);
