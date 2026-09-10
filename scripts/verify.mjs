// 验证 .d115p 包结构、integrity、签名、manifest 字段
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'dist', 'qb2tr-transfer.d115p');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
}

console.log('=== 验证 .d115p 包 ===\n');

const buf = fs.readFileSync(PKG_PATH);
const zip = await JSZip.loadAsync(buf);
const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
console.log('ZIP 文件列表:');
names.forEach(n => console.log('  ', n, zip.files[n]._data?.uncompressedSize || '?', 'bytes'));

// 1. 必需文件
console.log('\n1. 必需文件检查');
check('manifest.json 存在', names.includes('manifest.json'));
check('runtime/plugin.wasm 存在', names.includes('runtime/plugin.wasm'));
check('frontend/dist/assets/remoteEntry.js 存在', names.includes('frontend/dist/assets/remoteEntry.js'));
check('integrity.json 存在', names.includes('integrity.json'));
check('signature.json 存在', names.includes('signature.json'));

// 2. 包大小限制
console.log('\n2. 包大小限制');
check('ZIP < 32 MiB', buf.length < 32 * 1024 * 1024, `${(buf.length / 1024 / 1024).toFixed(2)} MiB`);
check('ZIP 成员数 < 1024', names.length < 1024, `${names.length} 个`);

// 3. manifest.json 字段检查
console.log('\n3. manifest.json 字段检查');
const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
check('schema_version=1', manifest.schema_version === 1);
check('id 合法', /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/.test(manifest.id), manifest.id);
check('name 非空', !!manifest.name);
check('version 是 SemVer', /^\d+\.\d+\.\d+/.test(manifest.version), manifest.version);
check('description 非空', !!manifest.description);
check('default_locale', !!manifest.default_locale);
check('publisher.name', !!manifest.publisher?.name);
check('publisher.key_id 格式', /^ed25519:[A-Za-z0-9_-]+$/.test(manifest.publisher?.key_id || ''), manifest.publisher?.key_id);
check('compatibility.dian115', !!manifest.compatibility?.dian115);
check('compatibility.plugin_api', !!manifest.compatibility?.plugin_api);
check('runtime.kind=wasm', manifest.runtime?.kind === 'wasm');
check('runtime.entry=runtime/plugin.wasm', manifest.runtime?.entry === 'runtime/plugin.wasm');
check('runtime.protocol=dian115:wasm@1', manifest.runtime?.protocol === 'dian115:wasm@1');
check('permissions.apis 存在', Array.isArray(manifest.permissions?.apis));
check('permissions.network 每项有 origin+reason', (manifest.permissions?.network || []).every(n => n.origin && n.reason));
check('ui.mode=federation', manifest.ui?.mode === 'federation');
check('ui.federation.entry', !!manifest.ui?.federation?.entry);
check('ui.federation.assets_root', !!manifest.ui?.federation?.assets_root);

// 4. integrity.json 校验
console.log('\n4. integrity.json 校验');
const integrity = JSON.parse(await zip.file('integrity.json').async('string'));
check('schema_version=1', integrity.schema_version === 1);
check('algorithm=sha256', integrity.algorithm === 'sha256');
check('files 是数组', Array.isArray(integrity.files));

let integrityOk = true;
for (const f of integrity.files) {
  const zipFile = zip.file(f.path);
  if (!zipFile) { check(`integrity 条目 ${f.path} 存在`, false); integrityOk = false; continue; }
  const content = await zipFile.async('nodebuffer');
  const actualSha = crypto.createHash('sha256').update(content).digest('hex');
  const actualSize = content.length;
  if (actualSha !== f.sha256 || actualSize !== f.size) {
    check(`integrity ${f.path} sha256+size`, false, `expected ${f.sha256.slice(0,16)}... got ${actualSha.slice(0,16)}...`);
    integrityOk = false;
  }
}
check('所有 integrity 条目校验通过', integrityOk);

// 检查 integrity 是否覆盖了除自身和 signature 外的所有文件
const expectedPaths = names.filter(n => n !== 'integrity.json' && n !== 'signature.json').sort();
const integrityPaths = integrity.files.map(f => f.path).sort();
check('integrity 覆盖所有包内文件（除自身和 signature）', JSON.stringify(expectedPaths) === JSON.stringify(integrityPaths),
  `expected ${expectedPaths.length} got ${integrityPaths.length}`);

// 5. signature.json 校验
console.log('\n5. signature.json 校验');
const sig = JSON.parse(await zip.file('signature.json').async('string'));
check('algorithm=Ed25519', sig.algorithm === 'Ed25519');
check('canonicalization=RFC8785-JCS', sig.canonicalization === 'RFC8785-JCS');
check('domain 正确', sig.domain === 'DIAN115-PLUGIN-PACKAGE-V1');
check('key_id 与 manifest 一致', sig.key_id === manifest.publisher.key_id);
check('public_key 存在', !!sig.public_key);
check('signature 存在', !!sig.signature);

// 验证签名
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
const pubKeyJwk = crypto.createPublicKey({
  format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', x: sig.public_key },
});
const signingInput = Buffer.concat([
  Buffer.from('DIAN115-PLUGIN-PACKAGE-V1', 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(manifest), 'utf8'),
  Buffer.from([0]),
  Buffer.from(canonicalize(integrity), 'utf8'),
]);
const sigBytes = Buffer.from(sig.signature, 'base64url');
const sigValid = crypto.verify(null, signingInput, pubKeyJwk, sigBytes);
check('Ed25519 签名验证通过', sigValid);

// 6. WASM ABI 检查
console.log('\n6. WASM ABI 检查');
const wasmBuf = await zip.file('runtime/plugin.wasm').async('nodebuffer');
const wasmMod = new WebAssembly.Module(wasmBuf);
const exports = WebAssembly.Module.exports(wasmMod);
const imports = WebAssembly.Module.imports(wasmMod);
check('导出 dian115_alloc', exports.some(e => e.name === 'dian115_alloc' && e.kind === 'function'));
check('导出 dian115_handle', exports.some(e => e.name === 'dian115_handle' && e.kind === 'function'));
check('导出 memory', exports.some(e => e.name === 'memory' && e.kind === 'memory'));
check('不导出 _start', !exports.some(e => e.name === '_start'));
check('导入 dian115.host_call', imports.some(i => i.module === 'dian115' && i.name === 'host_call'));
check('导入 dian115.host_read', imports.some(i => i.module === 'dian115' && i.name === 'host_read'));

// 7. 市场索引检查
console.log('\n7. plugin-market/index.json 检查');
const market = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin-market', 'index.json'), 'utf8'));
check('repository 只有 id/name/homepage', Object.keys(market.repository).every(k => ['id','name','homepage'].includes(k)));
const plugin = market.plugins[0];
check('plugin.id 与 manifest 一致', plugin.id === manifest.id);
check('plugin.version 与 manifest 一致', plugin.version === manifest.version);
check('plugin.package_url 存在', !!plugin.package_url);
check('plugin.sha256 是 64 位 hex', /^[0-9a-f]{64}$/.test(plugin.sha256), plugin.sha256.slice(0,16) + '...');
check('plugin.sha256 与实际包一致', plugin.sha256 === crypto.createHash('sha256').update(buf).digest('hex'));
check('plugin.runtime.autostart=true', plugin.runtime?.autostart === true);
check('plugin.permissions 存在', !!plugin.permissions);
check('plugin.permissions.apis 存在', Array.isArray(plugin.permissions?.apis));

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
