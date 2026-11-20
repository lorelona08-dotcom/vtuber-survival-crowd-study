// Godot 4.7 PCK v4. New resources live under review/. The project settings select
// the review scene as Main Scene just as the author could do in the Godot editor.
const align = (number, size) => Math.ceil(number / size) * size;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function md5(bytes) {
  const length = align(bytes.length + 9, 64);
  const padded = new Uint8Array(length);
  const words = new DataView(padded.buffer);
  padded.set(bytes);
  padded[bytes.length] = 128;
  words.setBigUint64(length - 8, BigInt(bytes.length) * 8n, true);
  const state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  const constants = Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));
  for (let offset = 0; offset < length; offset += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16);
      let mix, index;
      switch (round) {
        case 0: mix = (b & c) | (~b & d); index = i; break;
        case 1: mix = (d & b) | (~d & c); index = (5 * i + 1) % 16; break;
        case 2: mix = b ^ c ^ d; index = (3 * i + 5) % 16; break;
        default: mix = c ^ (b | ~d); index = (7 * i) % 16;
      }
      const value = (a + mix + constants[i] + words.getUint32(offset + index * 4, true)) >>> 0;
      const shift = shifts[round][i % 4];
      const next = (b + ((value << shift) | (value >>> (32 - shift)))) >>> 0;
      a = d; d = c; c = b; b = next;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
  }
  const digest = new DataView(new ArrayBuffer(16));
  state.forEach((word, i) => digest.setUint32(i * 4, word, true));
  return new Uint8Array(digest.buffer);
}

function changeMainScene(project, entry) {
  const view = new DataView(project.buffer, project.byteOffset, project.byteLength);
  if (decoder.decode(project.subarray(0, 4)) !== "ECFG") throw new Error("Godot 설정을 읽을 수 없습니다.");
  const properties = view.getUint32(4, true);
  let pos = 8;
  for (let i = 0; i < properties; i++) {
    const nameSize = view.getUint32(pos, true);
    const name = decoder.decode(project.subarray(pos + 4, pos + 4 + nameSize));
    pos += 4 + nameSize;
    const valueSize = view.getUint32(pos, true);
    if (pos + 4 + valueSize > project.length) throw new Error("Godot 설정의 길이가 잘못되었습니다.");
    if (name === "application/run/main_scene") {
      const value = pos + 4;
      const length = view.getUint32(value + 4, true);
      const previous = decoder.decode(project.subarray(value + 8, value + 8 + length));
      if (view.getUint32(value, true) !== 4 || previous !== "res://main.tscn") throw new Error("원작의 시작 장면이 달라졌습니다.");
      const scene = encoder.encode(entry);
      const newSize = 8 + align(scene.length, 4);
      const output = new Uint8Array(project.length + newSize - valueSize);
      output.set(project.subarray(0, pos));
      const updated = new DataView(output.buffer);
      updated.setUint32(pos, newSize, true);
      updated.setUint32(value, 4, true);
      updated.setUint32(value + 4, scene.length, true);
      output.set(scene, value + 8);
      output.set(project.subarray(value + valueSize), value + newSize);
      return output;
    }
    pos += 4 + valueSize;
  }
  throw new Error("원작의 시작 장면 설정이 없습니다.");
}

export function buildReviewPack(original, files, entry = "res://review/review_scene.tscn") {
  if (!["res://review/review_scene.tscn", "res://review/normal_scene.tscn"].includes(entry)) {
    throw new Error("지원하지 않는 시작 장면입니다.");
  }
  const header = new DataView(original.buffer, original.byteOffset, original.byteLength);
  if (header.getUint32(0, true) !== 0x43504447 || header.getUint32(4, true) !== 4 || header.getUint32(20, true) !== 2) {
    throw new Error("고정된 배포본의 PCK 형식을 확인할 수 없습니다.");
  }
  const fileBase = Number(header.getBigUint64(24, true));
  const oldDirectory = Number(header.getBigUint64(32, true));
  const count = header.getUint32(oldDirectory, true);
  let descriptor = oldDirectory + 4;
  let projectDescriptor;
  let project;
  for (let i = 0; i < count; i++) {
    const nameSize = header.getUint32(descriptor, true);
    const name = decoder.decode(original.subarray(descriptor + 4, descriptor + 4 + nameSize)).replace(/\0+$/, "");
    descriptor += 4 + nameSize;
    if (name === "project.binary") {
      projectDescriptor = descriptor;
      const start = fileBase + Number(header.getBigUint64(descriptor, true));
      const length = Number(header.getBigUint64(descriptor + 8, true));
      project = changeMainScene(original.subarray(start, start + length), entry);
    }
    descriptor += 36;
  }
  if (!project || descriptor !== original.length) throw new Error("원작의 리소스 목록을 확인할 수 없습니다.");
  const entries = [];
  const projectOffset = align(oldDirectory, 16);
  let nextOffset = projectOffset + project.length;
  let totalEntriesSize = 0;
  for (const {name, content} of files) {
    if (!/^[a-z][a-z0-9_]*\.(gd|tscn)$/.test(name)) throw new Error("실험 파일 이름이 잘못되었습니다.");
    const filename = encoder.encode("review/" + name);
    const nameSize = align(filename.length, 4);
    nextOffset = align(nextOffset, 16);
    entries.push({filename, nameSize, content, offset: nextOffset});
    nextOffset += content.length;
    totalEntriesSize += 4 + nameSize + 36;
  }
  const directory = align(nextOffset, 16);
  const output = new Uint8Array(directory + original.length - oldDirectory + totalEntriesSize);
  const view = new DataView(output.buffer);
  output.set(original.subarray(0, oldDirectory));
  output.set(original.subarray(oldDirectory), directory);
  output.set(project, projectOffset);
  const relocated = directory + projectDescriptor - oldDirectory;
  view.setBigUint64(relocated, BigInt(projectOffset - fileBase), true);
  view.setBigUint64(relocated + 8, BigInt(project.length), true);
  output.set(md5(project), relocated + 16);
  view.setBigUint64(32, BigInt(directory), true);
  view.setUint32(directory, count + entries.length, true);
  let entryOffset = directory + original.length - oldDirectory;
  for (const {filename, nameSize, content, offset} of entries) {
    output.set(content, offset);
    view.setUint32(entryOffset, nameSize, true);
    output.set(filename, entryOffset + 4);
    const descriptor = entryOffset + 4 + nameSize;
    view.setBigUint64(descriptor, BigInt(offset - fileBase), true);
    view.setBigUint64(descriptor + 8, BigInt(content.length), true);
    output.set(md5(content), descriptor + 16);
    entryOffset = descriptor + 36;
  }
  return output;
}
