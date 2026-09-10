// DIAN115 插件打包签名脚本
// 用法：node scripts/package.mjs
// 生成 dist/qb2tr-transfer.d115p，并更新 plugin-market/index.json 的 sha256
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yazl from 'yazl';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEY_PATH = path.join(ROOT, 'scripts', 'publisher.pem');
const OUT_PATH = path.join(ROOT, 'dist', 'qb2tr-transfer.d115p');

// ========== RFC8785 JCS 简化实现（适用于本插件的 JSON 结构）==========
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function base64url(buf) {
  return buf.toString('base64url');
}

// ========== 1. 密钥管理 ==========
let privateKey, publicKey;
if (fs.existsSync(KEY_PATH)) {
  const pem = fs.readFileSync(KEY_PATH, 'utf8');
  privateKey = crypto.createPrivateKey(pem);
  publicKey = crypto.createPublicKey(privateKey);
  console.log('使用已有签名密钥:', KEY_PATH);
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(KEY_PATH, pem);
  console.log('已生成新签名密钥:', KEY_PATH);
}

const jwk = publicKey.export({ format: 'jwk' });
const rawPubkey = Buffer.from(jwk.x, 'base64url');
const keyId = 'ed25519:' + base64url(crypto.createHash('sha256').update(rawPubkey).digest());
console.log('key_id:', keyId);

// ========== 2. 生成 manifest.json（注入 key_id）==========
const manifestTemplate = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const manifestStr = manifestTemplate.replace('__KEY_ID__', keyId);
const manifest = JSON.parse(manifestStr);
console.log('manifest id:', manifest.id, 'version:', manifest.version);

// ========== 3. 收集待打包文件 ==========
const files = []; // { path, content }

// manifest.json
files.push({ path: 'manifest.json', content: Buffer.from(manifestStr, 'utf8') });

// runtime/plugin.wasm
const wasmPath = path.join(ROOT, 'runtime', 'plugin.wasm');
if (!fs.existsSync(wasmPath)) {
  console.error('错误: runtime/plugin.wasm 不存在，请先编译');
  process.exit(1);
}
files.push({ path: 'runtime/plugin.wasm', content: fs.readFileSync(wasmPath) });

// frontend/dist/assets/*
const assetsDir = path.join(ROOT, 'frontend', 'dist', 'assets');
if (!fs.existsSync(assetsDir)) {
  console.error('错误: frontend/dist/assets 不存在，请先构建前端');
  process.exit(1);
}
const assetFiles = fs.readdirSync(assetsDir);
for (const f of assetFiles) {
  const fullPath = path.join(assetsDir, f);
  if (fs.statSync(fullPath).isFile()) {
    files.push({
      path: 'frontend/dist/assets/' + f,
      content: fs.readFileSync(fullPath),
    });
  }
}

console.log('打包文件数:', files.length);
files.forEach(f => console.log('  ', f.path, f.content.length, 'bytes'));

// ========== 4. 生成 integrity.json ==========
const integrityFiles = files
  .map(f => ({
    path: f.path,
    size: f.content.length,
    sha256: crypto.createHash('sha256').update(f.content).digest('hex'),
  }))
  .sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));

const integrity = {
  schema_version: 1,
  algorithm: 'sha256',
  files: integrityFiles,
};
const integrityStr = JSON.stringify(integrity, null, 2);

// ========== 5. 生成 signature.json ==========
const domain = 'DIAN115-PLUGIN-PACKAGE-V1';
const signingInput = Buffer.concat([
  Buffer.from(domain, 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(manifest), 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(integrity), 'utf8'),
]);
const signature = crypto.sign(null, signingInput, privateKey);

const signatureObj = {
  schema_version: 1,
  algorithm: 'Ed25519',
  canonicalization: 'RFC8785-JCS',
  domain,
  key_id: keyId,
  public_key: base64url(rawPubkey),
  signature: base64url(signature),
};
const signatureStr = JSON.stringify(signatureObj, null, 2);

// ========== 6. 打包 ZIP（yazl 不生成目录条目，符合 DIAN115 规范）==========
const zipfile = new yazl.ZipFile();
for (const f of files) {
  zipfile.addBuffer(f.content, f.path, { compress: true });
}
zipfile.addBuffer(Buffer.from(integrityStr, 'utf8'), 'integrity.json', { compress: true });
zipfile.addBuffer(Buffer.from(signatureStr, 'utf8'), 'signature.json', { compress: true });

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
await new Promise((resolve, reject) => {
  zipfile.outputStream.pipe(fs.createWriteStream(OUT_PATH))
    .on('close', resolve)
    .on('error', reject);
  zipfile.end();
});
const zipBuffer = fs.readFileSync(OUT_PATH);
const packageSha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');

console.log('\n打包完成:', OUT_PATH);
console.log('包大小:', zipBuffer.length, 'bytes');
console.log('包 SHA-256:', packageSha256);

// ========== 7. 更新市场索引 sha256 ==========
const marketPath = path.join(ROOT, 'plugin-market', 'index.json');
let marketStr = fs.readFileSync(marketPath, 'utf8');
// 兼容首次运行（占位符）和后续运行（已有 sha256）
if (marketStr.includes('__PACKAGE_SHA256__')) {
  marketStr = marketStr.replace('__PACKAGE_SHA256__', packageSha256);
} else {
  marketStr = marketStr.replace(/"sha256":\s*"[0-9a-f]{64}"/, `"sha256": "${packageSha256}"`);
}
fs.writeFileSync(marketPath, marketStr);
console.log('已更新 plugin-market/index.json 的 sha256');

// ========== 8. 验证签名 ==========
const verifyOk = crypto.verify(null, signingInput, publicKey, signature);
console.log('签名验证:', verifyOk ? '通过' : '失败');
if (!verifyOk) process.exit(1);

console.log('\n全部完成！');
