import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';

import { isValidSessionId, locateSessionDirectory, deleteSessionArtifacts, directoryBytes, readCachedTitle } from '../core.mjs';
import { MAX_CHILDREN } from '../cascade.mjs';
import { apply, handleSessionDelete, SESSION_DELETE_PATH, sessionsRoot, projectionCacheDir, projectionCacheFile } from '../index.mjs';

let passed = 0;
let failed = 0;
/** 跑一条用例，失败也继续，最后统一汇总。 */
async function test(label, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok   ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${label}\n       ${error.message}`);
	}
}

/** 本次运行创建过的所有临时目录，收尾统一删除，避免往 %TEMP% 里漏垃圾。 */
const createdRoots = [];

/** 造一个假的 sessions root，返回 { root, projectDir, sessionDir }。 */
async function makeRoot(sessionId) {
	const root = await mkdtemp(path.join(tmpdir(), 'sess-del-'));
	createdRoots.push(root);
	const projectDir = path.join(root, '--D-DSH-Day1--');
	const sessionDir = path.join(projectDir, sessionId);
	await mkdir(sessionDir, { recursive: true });
	await writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024, 7));
	return { root, projectDir, sessionDir };
}

console.log('== Task 2: id 校验 ==');
await test('正常 uuid 通过', () => {
	assert.equal(isValidSessionId('09e4d23d-2176-47aa-b763-c6f06685ffc0'), true);
});
await test('带 session- 前缀通过', () => {
	assert.equal(isValidSessionId('session-17b5d9cf-c10a-441a-82ab-5bad3892b05b'), true);
});
await test('.. 被拒', () => assert.equal(isValidSessionId('..'), false));
await test('. 被拒', () => assert.equal(isValidSessionId('.'), false));
await test('前导点被拒', () => assert.equal(isValidSessionId('.hidden'), false));
await test('斜杠被拒', () => assert.equal(isValidSessionId('a/b'), false));
await test('反斜杠被拒', () => assert.equal(isValidSessionId('a\\b'), false));
await test('空格被拒', () => assert.equal(isValidSessionId('a b'), false));
await test('超长（201）被拒', () => assert.equal(isValidSessionId('a'.repeat(201)), false));
await test('非字符串被拒', () => assert.equal(isValidSessionId(42), false));

console.log('== Task 2: 定位 ==');
await test('能在项目目录下精确找到会话目录', async () => {
	const { root, sessionDir } = await makeRoot('11111111-2222-3333-4444-555555555555');
	assert.equal(await locateSessionDirectory(root, '11111111-2222-3333-4444-555555555555'), sessionDir);
});
await test('不存在的 id 返回 undefined', async () => {
	const { root } = await makeRoot('11111111-2222-3333-4444-555555555555');
	assert.equal(await locateSessionDirectory(root, 'no-such-session'), undefined);
});
await test('root 不存在返回 undefined（不抛）', async () => {
	// hermetic：不写死路径，在本次 mkdtemp 出来的目录下拼一个一定不存在的子路径。
	const emptyRoot = await mkdtemp(path.join(tmpdir(), 'sess-del-miss-'));
	createdRoots.push(emptyRoot);
	assert.equal(await locateSessionDirectory(path.join(emptyRoot, 'nope'), 'x'), undefined);
});

console.log('== Task 2: 路径穿越必须被挡住 ==');
for (const bad of ['..', '../..', 'a/b', 'a\\b', '..\\..\\x', 'C:\\Windows', '\\\\?\\C:\\Windows', 'a/b/../../..']) {
	await test(`穿越形态 id 返回 undefined：${JSON.stringify(bad)}`, async () => {
		const { root } = await makeRoot('11111111-2222-3333-4444-555555555555');
		assert.equal(await locateSessionDirectory(root, bad), undefined);
	});
}
await test('归一化后指向已存在目录的 id 仍被拒（只有 basename 断言能挡）', async () => {
	const { root, projectDir } = await makeRoot('11111111-2222-3333-4444-555555555555');
	// 'a/../victim' 与 './victim' 经 path.join 归一化后正好是 root/<proj>/victim，且**真实存在**。
	// 这种形态下深度断言与 startsWith 前缀断言都会放行，唯一拦住它的是 basename 恒等断言。
	await mkdir(path.join(projectDir, 'victim'), { recursive: true });
	assert.equal(await locateSessionDirectory(root, 'a/../victim'), undefined);
	assert.equal(await locateSessionDirectory(root, './victim'), undefined);
});
await test('返回的路径一定落在 root 之内', async () => {
	const id = '11111111-2222-3333-4444-555555555555';
	const { root } = await makeRoot(id);
	const got = await locateSessionDirectory(root, id);
	assert.ok(got !== undefined);
	assert.ok(got.startsWith(root + path.sep), `越出 root：${got}`);
	assert.equal(path.basename(got), id);
});

console.log('== Task 2: 入参卫生 ==');
await test('非字符串 id 返回 undefined（不抛）', async () => {
	const { root } = await makeRoot('11111111-2222-3333-4444-555555555555');
	assert.equal(await locateSessionDirectory(root, undefined), undefined);
	assert.equal(await locateSessionDirectory(root, 42), undefined);
});

console.log('== Task 2: 遍历分支 ==');
await test('项目项是文件而非目录时跳过', async () => {
	const { root } = await makeRoot('11111111-2222-3333-4444-555555555555');
	// 在 root 下放一个与项目目录同名的**文件**，不得因此崩或误命中
	await writeFile(path.join(root, '--not-a-dir--'), 'x');
	assert.equal(await locateSessionDirectory(root, 'no-such-session'), undefined);
});
await test('candidate 存在但不是目录时跳过', async () => {
	const id = '11111111-2222-3333-4444-555555555555';
	const { root } = await makeRoot(id);
	// 同一个 id 在另一个项目目录下是个**文件**，应被跳过而不是返回
	const other = path.join(root, '--other--');
	await mkdir(other, { recursive: true });
	await writeFile(path.join(other, 'file-like-id'), 'x');
	assert.equal(await locateSessionDirectory(root, 'file-like-id'), undefined);
});
await test('命中在第 2 个项目目录时也能找到', async () => {
	const id = '22222222-3333-4444-555555-666666666666';
	const { root } = await makeRoot('33333333-4444-5555-6666-777777777777'); // 第 1 个项目目录里**没有**该 id
	const second = path.join(root, '--second--', id);
	await mkdir(second, { recursive: true });
	assert.equal(await locateSessionDirectory(root, id), second);
});

console.log('== Task 3: 删除序列 ==');

/** 造一个带投影缓存的完整现场：缓存放在 root 之内，保证 hermetic。
 *  返回 cacheDir（声明的缓存**目录**，新签名用）与 cacheFile（= cacheDir/<id>.json，断言用）。 */
async function makeScene(sessionId, { cache = true, title = '测试会话' } = {}) {
	const { root, sessionDir } = await makeRoot(sessionId);
	const cacheDir = path.join(root, 'projcache');
	await mkdir(cacheDir, { recursive: true });
	const cacheFile = path.join(cacheDir, `${sessionId}.json`);
	if (!cache) return { root, sessionDir, cacheDir, cacheFile, cacheBytes: 0 };
	// M6：负载自造 → 字节数可精确算出，不必拿 stat 反推。
	const json = JSON.stringify({ version: 7, record: { rows: { title: { val: title } } } });
	await writeFile(cacheFile, json);
	return { root, sessionDir, cacheDir, cacheFile, cacheBytes: Buffer.byteLength(json, 'utf8') };
}

/** makeRoot 写进日志目录的负载大小（session.v4.jsonl.zstd）。 */
const LOG_BYTES = 1024;

await test('目录与缓存都被删，字节数精确且 logDir=removed', async () => {
	const id = 'aaaa1111-bbbb-2222-cccc-333344445555';
	const { root, sessionDir, cacheDir, cacheFile, cacheBytes } = await makeScene(id);
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'removed');
	assert.equal(result.alreadyAbsent, false);
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.warnings, []);
	assert.deepEqual([...result.deleted].sort(), [sessionDir, cacheFile].sort());
	// M6：精确值，不是 >= 1024
	const expected = LOG_BYTES + cacheBytes;
	assert.equal(result.freedBytes, expected, `freedBytes 应精确等于 ${expected}`);
	await assert.rejects(stat(sessionDir));
	await assert.rejects(stat(cacheFile));
});

await test('幂等：连续删两次，第二次两个目标都已不在', async () => {
	const id = 'idempotent-0000-0000-0000-000000000000';
	const { root, cacheDir, cacheFile } = await makeScene(id);
	const first = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(first.logDir, 'removed');
	assert.equal(first.alreadyAbsent, false);
	// M3：真的是第二次调用，而不是"造一个本来就不存在的现场"。
	const second = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(second.logDir, 'absent');
	assert.equal(second.alreadyAbsent, true);
	assert.deepEqual(second.deleted, []);
	assert.deepEqual(second.failed, []);
	assert.equal(second.freedBytes, 0);
	assert.equal(await locateSessionDirectory(root, id), undefined);
});

await test('两个目标从来就不存在（含缓存父目录也缺失）：alreadyAbsent=true 且不报错', async () => {
	const id = 'neverwas-0000-0000-0000-000000000000';
	const root = await mkdtemp(path.join(tmpdir(), 'sess-del-empty-'));
	createdRoots.push(root);
	// projcache 目录本身也不存在：rm 报 ENOENT 时必须映射为 absent，而不是 failed。
	const cacheDir = path.join(root, 'projcache');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'absent');
	assert.equal(result.alreadyAbsent, true);
	assert.deepEqual(result.deleted, []);
	assert.deepEqual(result.failed, []);
	assert.equal(result.freedBytes, 0);
});

await test('部分失败：日志目录删成功、缓存删不掉，freedBytes 只算成功的那部分', async () => {
	const id = 'partial1-2222-3333-4444-555566667777';
	const { root, sessionDir, cacheDir, cacheFile } = await makeScene(id, { cache: false });
	// hermetic 构造：缓存目标是一个**非空目录**。rm(<非空目录>) 不带 recursive
	// 必然抛 ERR_FS_EISDIR（本机 node v22 实测，有无 force 都一样；见探针）。
	await mkdir(cacheFile, { recursive: true });
	await writeFile(path.join(cacheFile, 'blocker.bin'), Buffer.alloc(64, 3));
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'removed');
	assert.equal(result.alreadyAbsent, false);
	assert.equal(result.deleted.length, 1);
	assert.deepEqual(result.deleted, [sessionDir]);
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].code, 'ERR_FS_EISDIR');
	assert.equal(result.failed[0].target, cacheFile);
	// 失败目标不计入 freedBytes：只剩日志目录那 LOG_BYTES 字节
	assert.equal(result.freedBytes, LOG_BYTES);
	// 缓存目标原地未动
	assert.equal((await stat(path.join(cacheFile, 'blocker.bin'))).size, 64);
	// 日志目录确实已消失
	assert.equal(await locateSessionDirectory(root, id), undefined);
});

await test('root 是普通文件：返回而不抛，logDir=indeterminate 且绝不动删除', async () => {
	const id = 'rootfile-2222-3333-4444-555566667777';
	const { root, cacheDir, cacheFile } = await makeScene(id);
	const notARoot = path.join(root, 'im-a-file');
	await writeFile(notARoot, 'x');
	let result;
	await assert.doesNotReject(async () => {
		result = await deleteSessionArtifacts({ root: notARoot, projectionCacheDir: cacheDir, sessionId: id });
	});
	assert.equal(result.logDir, 'indeterminate'); // 绝不能被伪装成 'absent'
	assert.notEqual(result.failed.length, 0, 'failed 必须非空');
	assert.equal(result.failed[0].phase, 'locate');
	assert.deepEqual(result.deleted, []);
	assert.equal(result.freedBytes, 0);
	assert.equal(result.alreadyAbsent, false);
	// 无法判定时绝不动删除：缓存必须原封不动
	assert.equal((await stat(cacheFile)).isFile(), true);
});

await test('把"文件"当缓存目录传（误用）：响亮记 failed/CACHE_DIR_NOT_A_DIRECTORY，缓存目标一个字节都不删', async () => {
	// 反例回归：过去这个入口吃的是"任意绝对文件路径"，于是 root 外同名文件会被真删。
	// 现在入口是**目录**；若调用方硬把文件当目录（把旧的 path 形态塞进 projectionCacheDir），
	// 派生目标 `<file>/<id>.json` 在本机（Windows/node v22）rm 报 ENOENT → 被映射成 absent。
	//
	// ⚠️ Step 0 硬化（2026-09-26）：那条"静默无事"**被本任务刻意改掉**了。
	// 它虽然安全（一个字节都没删），却把一次"根本没删掉投影缓存"伪装成了成功 ——
	// 正是本项目一路在消灭的**假成功**类型，配置错误被吞掉。
	// 现在的契约：stat 报"存在但不是目录" → 记一条 guard/CACHE_DIR_NOT_A_DIRECTORY，
	// 该目标不做任何删除，且**不影响日志目录**的处理。
	// 本用例此前断言 `failed === []`（记录旧行为），Step 0 起改为断言响亮拒绝。
	const id = 'shape111-2222-3333-4444-555566667777';
	const { root, sessionDir } = await makeScene(id, { cache: false });
	const wrong = path.join(root, 'projcache', 'not-the-session-id.json');
	await writeFile(wrong, 'x');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: wrong, sessionId: id });
	assert.equal(result.logDir, 'removed');
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].phase, 'guard');
	assert.equal(result.failed[0].code, 'CACHE_DIR_NOT_A_DIRECTORY');
	assert.equal(result.failed[0].target, path.resolve(wrong));
	assert.deepEqual(result.deleted, [sessionDir]); // 只有日志目录被删
	assert.equal(result.freedBytes, LOG_BYTES);
	assert.equal(result.alreadyAbsent, false);
	assert.equal((await stat(wrong)).size, 1); // 原地未动
});

await test('缓存目录不存在（ENOENT）仍放行：不因 Step 0 的硬化而误记 failed', async () => {
	// 与上一条配对，锁死"ENOENT 放行 / 非目录拒绝"的分界：缓存目录**本就不存在**是合法状态
	// （neverwas 路径），必须继续当成 absent 走幂等路径，而不是记 failed。
	const id = 'cachedir-2222-3333-4444-555566667777';
	const root = await mkdtemp(path.join(tmpdir(), 'sess-del-nocachedir-'));
	createdRoots.push(root);
	const cacheDir = path.join(root, 'never', 'existed', 'sessions');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'absent');
	assert.deepEqual(result.failed, []);
	assert.deepEqual(result.deleted, []);
	assert.equal(result.alreadyAbsent, true);
});

await test('projectionCacheDir 缺失（undefined）：记 guard/SHAPE_MISMATCH，绝不静默当成"不存在"', async () => {
	const id = 'nocache-2222-3333-4444-555566667777';
	const { root, sessionDir } = await makeScene(id, { cache: false });
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: undefined, sessionId: id });
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].phase, 'guard');
	assert.equal(result.failed[0].code, 'SHAPE_MISMATCH');
	assert.equal(result.failed[0].target, 'undefined'); // recordFailure 对非字符串 target 的 String() 兜底
	assert.equal(result.logDir, 'removed');
	assert.equal(result.alreadyAbsent, false);
	// 缓存这一侧"无法判定"，但日志目录照删（两侧互不牵连）
	assert.deepEqual(result.deleted, [sessionDir]);
});

await test('只有缓存、没有日志目录：仍删缓存且 logDir=absent', async () => {
	const id = 'cacheonly-0000-0000-0000-000000000000';
	const root = await mkdtemp(path.join(tmpdir(), 'sess-del-cacheonly-'));
	createdRoots.push(root);
	const cacheDir = root; // 缓存文件直接放在 root 里：dirname(cacheDir/<id>.json) === cacheDir 仍成立
	const cacheFile = path.join(cacheDir, `${id}.json`);
	await writeFile(cacheFile, '{"v":1}');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'absent');
	assert.equal(result.alreadyAbsent, false);
	assert.deepEqual(result.deleted, [cacheFile]);
});

await test('审计标题能从缓存里读出', async () => {
	const id = 'title111-2222-3333-4444-555566667777';
	const { cacheFile } = await makeScene(id, { title: '核查 DSH 会话删除能力' });
	assert.equal(await readCachedTitle(cacheFile), '核查 DSH 会话删除能力');
});

await test('缓存不可读时标题为 undefined（不抛）', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'sess-del-notitle-'));
	createdRoots.push(root);
	assert.equal(await readCachedTitle(path.join(root, 'missing.json')), undefined);
});

await test('缓存内容是坏 JSON 时 readCachedTitle 返回 undefined', async () => {
	const id = 'badjson1-2222-3333-4444-555566667777';
	const { root } = await makeScene(id, { cache: false });
	const broken = path.join(root, 'projcache', 'broken.json');
	await writeFile(broken, '{ not json at all ');
	assert.equal(await readCachedTitle(broken), undefined);
});

await test('directoryBytes 递归统计', async () => {
	const id = 'bytes111-2222-3333-4444-555566667777';
	const { sessionDir } = await makeScene(id, { cache: false });
	await mkdir(path.join(sessionDir, 'nested'), { recursive: true });
	await writeFile(path.join(sessionDir, 'nested', 'a.bin'), Buffer.alloc(512, 1));
	assert.equal(await directoryBytes(sessionDir), LOG_BYTES + 512);
});

await test('directoryBytes 对不存在的路径返回 0（不抛）', async () => {
	const id = 'byteszero-222-3333-4444-555566667777';
	const { root } = await makeScene(id, { cache: false });
	assert.equal(await directoryBytes(path.join(root, 'no-such-dir')), 0);
});

console.log('== Task 3 复审补: directoryBytes 的 I2 收窄契约 ==');

await test('directoryBytes 对普通文件路径必须抛 ENOTDIR（I2：非 ENOENT 不得静默清零）', async () => {
	// 复审实证：这是**唯一**能证伪 I2 收窄契约的用例 —— 把外层 readdir 的收窄 catch
	// 裸化成 `return 0` 后，只有这一条会变红（其余全绿）。所以**不要**把它放宽成"返回 0 也对"。
	const dir = await mkdtemp(path.join(tmpdir(), 'sess-del-notdir-'));
	createdRoots.push(dir);
	const plain = path.join(dir, 'plain.txt');
	await writeFile(plain, 'x');
	await assert.rejects(directoryBytes(plain), (error) => error.code === 'ENOTDIR');
});

console.log('== Task 3 复审补: 缓存目标的「两个声明根」派生（消灭任意路径原语）==');

await test('越界回归：用旧参数名传 root 外的真实文件，必须一个字节都删不掉', async () => {
	// 复审复现的残余（真实数据丢失面）：缓存守卫过去只校验 basename，于是"root 之外、
	// basename 恰好是 <id>.json"的真实文件会被真删 —— 本模块成了"给任意绝对路径即永久删除"的原语。
	// 修法是把入口换成"声明的缓存**目录** + 已校验 id"，目标由核心自己派生。
	// 这条故意用**旧参数名**传一个 root 外的真实文件，锁定的契约是"path 形态入口已不存在"：
	// 改实现前它是红的（该文件被删掉），改完后必须绿。
	const id = 'outofroot-222-3333-4444-555566667777';
	const { root } = await makeScene(id, { cache: false });
	const outsideDir = await mkdtemp(path.join(tmpdir(), 'sess-del-outside-'));
	createdRoots.push(outsideDir);
	const victim = path.join(outsideDir, `${id}.json`);
	await writeFile(victim, 'must-survive');
	const result = await deleteSessionArtifacts({ root, projectionCacheFile: victim, sessionId: id });
	assert.equal(result.logDir, 'removed');
	assert.equal((await stat(victim)).size, 'must-survive'.length, 'root 之外的同名文件被删掉了');
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].code, 'SHAPE_MISMATCH');
	assert.equal(result.freedBytes, LOG_BYTES);
});

await test('两个声明根：投影缓存目录在 root 之外时，核心自己派生目标并删除', async () => {
	const id = 'tworoots-222-3333-4444-555566667777';
	const { root, sessionDir } = await makeScene(id, { cache: false });
	// 真实部署形状：投影缓存并不在 sessions root 之下。调用方声明**目录**，目标由核心派生。
	const cacheDir = await mkdtemp(path.join(tmpdir(), 'sess-del-cachedir-'));
	createdRoots.push(cacheDir);
	const cacheFile = path.join(cacheDir, `${id}.json`);
	await writeFile(cacheFile, '{"v":1}');
	// 诱饵：另**一个**目录里同名的 <id>.json，绝不能被碰
	const decoyDir = await mkdtemp(path.join(tmpdir(), 'sess-del-decoy-'));
	createdRoots.push(decoyDir);
	const decoy = path.join(decoyDir, `${id}.json`);
	await writeFile(decoy, 'decoy');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: id });
	assert.equal(result.logDir, 'removed');
	assert.deepEqual([...result.deleted].sort(), [sessionDir, cacheFile].sort());
	assert.equal(result.freedBytes, LOG_BYTES + Buffer.byteLength('{"v":1}'));
	assert.deepEqual(result.failed, []);
	assert.equal((await stat(decoy)).size, 'decoy'.length, '另一个目录里的同名文件被碰了');
	await assert.rejects(stat(cacheFile));
});

await test('未经 isValidSessionId 的 id（a/../victim）：派生目标不在声明目录内 → 记 failed 且不删', async () => {
	const { root, cacheDir } = await makeScene('decoy111-2222-3333-4444-555566667777', { cache: false });
	// path.join(cacheDir, 'a/../victim.json') 归一化后是 cacheDir/victim.json：父目录恒等断言会放行，
	// 唯一拦得住它的是 basename 恒等断言（与 locateSessionDirectory 的纵深防御对称）。
	const decoyReal = path.join(cacheDir, 'victim.json');
	await writeFile(decoyReal, 'survive');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: 'a/../victim' });
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].phase, 'guard');
	assert.equal(result.failed[0].code, 'SHAPE_MISMATCH');
	assert.equal(result.failed[0].target, decoyReal, 'failed.target 应是核心派生出的那个目标');
	assert.equal((await stat(decoyReal)).size, 'survive'.length);
	assert.equal(result.alreadyAbsent, false);
});

await test('带分隔符的 id（x/y）：派生目标不在声明目录内 → 记 failed 且不删', async () => {
	const { root, cacheDir } = await makeScene('sep11111-2222-3333-4444-555566667777', { cache: false });
	await mkdir(path.join(cacheDir, 'x'), { recursive: true });
	const decoyReal = path.join(cacheDir, 'x', 'y.json');
	await writeFile(decoyReal, 'survive');
	const result = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: 'x/y' });
	assert.equal(result.failed.length, 1, `failed 应恰好 1 条，实际 ${JSON.stringify(result.failed)}`);
	assert.equal(result.failed[0].phase, 'guard');
	assert.equal(result.failed[0].code, 'SHAPE_MISMATCH');
	assert.equal((await stat(decoyReal)).size, 'survive'.length);
});

console.log('== Task 3 复审补: logDir=failed（目录被占住 → EBUSY）==');

/** 占位子进程：先进到目标目录，再把"我已就位"（含自报 cwd）写进 ready 文件。 */
const HOLDER_SCRIPT = `
const fs = require('fs');
if (process.env.HOLD_DIR) process.chdir(process.env.HOLD_DIR);
fs.writeFileSync(process.env.HOLD_READY_FILE, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
setTimeout(() => {}, 60000);
`;

/** 本次运行起过的占位子进程（无论死活），收尾统一清点。 */
const holders = [];
/** 杀不掉的子进程 pid：收尾必须显式报告，绝不静默。 */
const leakedHolders = [];

/** 等子进程退出，最多 timeoutMs；超时返回 false（不抛）。 */
function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** 杀掉占位子进程并等它真的退出（先 SIGTERM 再 SIGKILL）；杀不掉只记账，交给收尾报告。 */
async function killHolder(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill();
	if (await waitForExit(child, 5000)) return;
	child.kill('SIGKILL');
	if (await waitForExit(child, 5000)) return;
	leakedHolders.push(child.pid);
}

/**
 * 让子进程把 dir 当作 cwd 占住：**轮询 ready 文件**直到它自报 cwd 已就位（不猜 sleep）。
 * 实测依据（本机 node v22.21/Windows）：cwd 锁就位后 `rm(dir, { recursive: true, maxRetries: 5 })`
 * 稳定抛 EBUSY（约 1.5s 重试耗尽）。未就位就动手删除则会**删成功**，所以握手不是装饰。
 */
async function holdDirectoryAsCwd(dir, readyFile) {
	const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT], {
		cwd: dir,
		stdio: 'ignore',
		env: { ...process.env, HOLD_DIR: dir, HOLD_READY_FILE: readyFile }
	});
	holders.push(child);
	const deadline = Date.now() + 10000;
	for (;;) {
		let report;
		try {
			report = JSON.parse(await readFile(readyFile, 'utf8'));
		} catch (error) {
			if (error.code === 'ENOENT' || error instanceof SyntaxError) {
				if (Date.now() > deadline) throw new Error(`等待占位子进程就位超时（${dir}，pid=${child.pid}）`);
				await new Promise((r) => setTimeout(r, 20));
				continue;
			}
			throw error;
		}
		if (path.resolve(report.cwd) !== path.resolve(dir)) {
			throw new Error(`占位子进程自报 cwd=${report.cwd}，期望 ${dir}`);
		}
		return child;
	}
}

/**
 * 跑一次"日志目录被占住"的场景，**轮询重试直到观测到** logDir === 'failed' 才返回（不猜时间）；
 * 超时则抛错并带上历次实测的 logDir（明确失败，不静默跳过）。
 * @returns `{ attempt, id, result, scene }`。
 */
async function runBusyScene(label, { withCache }) {
	const deadline = Date.now() + 30000;
	const observed = [];
	for (let attempt = 1; ; attempt += 1) {
		const id = `busy-${withCache ? 'cache' : 'nocache'}-${attempt}-0000-0000000000`;
		const scene = await makeScene(id, { cache: withCache });
		const stateDir = await mkdtemp(path.join(tmpdir(), 'sess-del-holder-'));
		createdRoots.push(stateDir);
		let holder;
		try {
			holder = await holdDirectoryAsCwd(scene.sessionDir, path.join(stateDir, 'ready.json'));
			const result = await deleteSessionArtifacts({
				root: scene.root,
				projectionCacheDir: scene.cacheDir,
				sessionId: id
			});
			if (result.logDir === 'failed') return { attempt, id, result, scene };
			observed.push(result.logDir);
		} finally {
			await killHolder(holder);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`[${label}] 轮询 ${attempt} 次仍未观测到 logDir="failed"；实测依次为 ${JSON.stringify(observed)}`
					+ '（构造在本机不稳定，需人工介入，不静默跳过）'
			);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}

await test('logDir=failed（EBUSY）：alreadyAbsent=false，且缓存照删、freedBytes 只算缓存', async () => {
	const { attempt, result, scene } = await runBusyScene('cache-present', { withCache: true });
	assert.equal(result.logDir, 'failed', `第 ${attempt} 次轮询才观测到 failed`);
	const logdirFailures = result.failed.filter((f) => f.phase === 'logdir');
	assert.equal(logdirFailures.length, 1, JSON.stringify(result.failed));
	assert.equal(logdirFailures[0].code, 'EBUSY');
	assert.equal(logdirFailures[0].target, scene.sessionDir);
	// 堵住 MUT-J（alreadyAbsent 忽略 logDir）：目录删不掉时绝不能说成"本来就不存在"
	assert.equal(result.alreadyAbsent, false);
	// 目录删不掉 ≠ 缓存不处理：缓存照删，字节精确计入
	assert.deepEqual(result.deleted, [scene.cacheFile]);
	assert.equal(result.freedBytes, scene.cacheBytes);
	await assert.rejects(stat(scene.cacheFile));
	assert.equal((await stat(scene.sessionDir)).isDirectory(), true);
	assert.equal(result.failed.length, 1, '失败只应有一条（cache 不该混进 failed）');
});

await test('logDir=failed 且缓存本就不存在：alreadyAbsent 仍必须为 false（堵 MUT-J）', async () => {
	const { result, scene } = await runBusyScene('cache-absent', { withCache: false });
	assert.equal(result.logDir, 'failed');
	assert.equal(result.failed.length, 1, JSON.stringify(result.failed));
	assert.equal(result.failed[0].phase, 'logdir');
	assert.equal(result.failed[0].code, 'EBUSY');
	// 忽略 logDir 的变异实现（alreadyAbsent = cacheAbsent）在这一行给 true，本用例即变红
	assert.equal(result.alreadyAbsent, false);
	assert.deepEqual(result.deleted, []);
	assert.equal(result.freedBytes, 0);
	assert.equal((await stat(scene.sessionDir)).isDirectory(), true);
});

console.log('== Task 4: cordis 包装 ==');

/**
 * 造一个假 ctx：记录 effect、route、emit 与调用过的 registry 方法。
 * ⚠️ **不要**往 ctx 里塞 root/cacheFile：`index.mjs` 不接受根路径入参，它只从 `DSH_HOME` 推导
 * （`sessionsRoot()` / `projectionCacheDir()`）。所以用例必须用 `withHome()` 控制环境变量，
 * 并按**真实布局**造现场 —— 旧参考用例里的 `ctx.paths = { root, cacheFile }` 是废的（实现从不读它）。
 *
 * ⚠️ **`liveIds` 的语义是「正在运行」，不是「驻留」**（2026-09-26 Task 7 修正）。
 * 旧实现把这批 id 当作"驻留即拒绝"，返回的对象**没有 `status`**，与真实的
 * `AgentStatus = 'idle' | 'running'`（9 个包的 typert 声明）不符 —— 用户的会话"显示已停止"
 * （回合被中断）却回 `SESSION_ACTIVE` 删不掉，就是被这个假现场掩盖的。
 * 现在：`liveIds` → `{ id, status: 'running' }`（真在跑）；`residentStatuses` → 任意 status
 * （含 `undefined`，用来覆盖"有驻留对象但拿不到 status"这一最极端的形状漂移）。
 */
function makeFakeCtx({ liveIds = [], residentStatuses = {}, registryThrows = false, attachedIds = [], sessionsMode = 'ok' } = {}) {
	const calls = { emitted: [], unarchived: [], unpinned: [], effects: 0, logs: [], warns: [], route: undefined, sessionGets: [] };
	const live = new Set(liveIds);
	const resident = new Map(Object.entries(residentStatuses));
	const attached = new Set(attachedIds);
	const ctx = {
		effect: (fn) => { calls.effects += 1; return fn(); },
		emit: (event, id) => { calls.emitted.push([event, id]); },
		agents: {
			get: (id) => {
				if (live.has(id)) return { id, status: 'running' };
				if (resident.has(id)) return { id, status: resident.get(id) };
				return undefined;
			}
		},
		workspaceRegistry: {
			unarchiveSession: async (id) => {
				if (registryThrows) throw new Error('registry down');
				calls.unarchived.push(id);
			},
			unpinSession: async (id) => { calls.unpinned.push(id); }
		},
		connection: { fetch: { register: (route) => { calls.route = route; return () => {}; } } },
		logger: {
			info: (message) => { calls.logs.push(message); },
			warn: (message) => { calls.warns.push(message); }
		}
	};
	// ── `sessions` 服务（Task 9 的 attached 探测用）─────────────────────────────
	// 真实契约：`dsh-session` 的 `sessions.get(id)`，其 JSDoc 原文是
	// "Return the exact live entry; detached/prepared objects reject." ⇒ `get(id) !== undefined`
	// 就是 attached 的判据。这里按 `sessionsMode` 造出**五种**形态，把"判不了"这一支钉死
	// （客户端的兜底文案全靠它）：
	//   "ok"     —— 服务在、get 可用；`attachedIds` 里的 id 返回对象，其余返回 undefined
	//   "absent" —— **根本没有** sessions 服务 ⇒ `attached` 必须是 undefined，**不是** false
	//   "throw"  —— get 存在但抛错（detached/prepared 的 reject 形态）
	//   "no-get" —— 服务在但 get 不是函数（形状漂移）
	//   "trap"   —— 连 `ctx.sessions` 这个**属性访问本身**都抛（所以实现必须用 Reflect.get + try）
	if (sessionsMode === 'ok') {
		ctx.sessions = {
			get: (id) => {
				calls.sessionGets.push(id);
				return attached.has(id) ? { id } : undefined;
			}
		};
	} else if (sessionsMode === 'throw') {
		ctx.sessions = {
			get: (id) => {
				calls.sessionGets.push(id);
				throw new Error('sessions.get down');
			}
		};
	} else if (sessionsMode === 'no-get') {
		ctx.sessions = { enter: () => {} };
	} else if (sessionsMode === 'trap') {
		Object.defineProperty(ctx, 'sessions', {
			configurable: true,
			get() { throw new Error('sessions property trap'); }
		});
	}
	return { ctx, calls, live };
}

/** 临时把 DSH_HOME 指向 home，用完一定还原（含"原本就没设置"的情形）。 */
async function withHome(home, fn) {
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
}

/** 造 `<home>/sessions/<项目目录>/<id>/session.v4.jsonl.zstd`；返回 { home, root, sessionDir }。 */
async function makeSessionHome(sessionId) {
	const home = await mkdtemp(path.join(tmpdir(), 'sess-del-home-'));
	createdRoots.push(home);
	const root = path.join(home, 'sessions');
	const sessionDir = path.join(root, '--D-DSH-Day1--', sessionId);
	await mkdir(sessionDir, { recursive: true });
	await writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024, 7));
	return { home, root, sessionDir };
}

/** 投影缓存**目录**在 home 里的规范落点（必须与 index.mjs 的 projectionCacheDir() 一致）。 */
function homeCacheDir(home) {
	return path.join(home, 'storages', 'session_projcache', 'sessions');
}

/** 在 home 里造出缓存目录，并在给了 payload 时写入 `<id>.json`。 */
async function seedCache(home, sessionId, { payload = null } = {}) {
	const cacheDir = homeCacheDir(home);
	await mkdir(cacheDir, { recursive: true });
	const cacheFile = path.join(cacheDir, `${sessionId}.json`);
	const cacheBytes = payload === null ? 0 : Buffer.byteLength(payload, 'utf8');
	if (payload !== null) await writeFile(cacheFile, payload);
	return { cacheDir, cacheFile, cacheBytes };
}

/** 缓存负载与其字节数：造现场和断言都用同一份。 */
const CACHE_PAYLOAD = '{"v":1}';
const CACHE_BYTES = Buffer.byteLength(CACHE_PAYLOAD, 'utf8');
/** 假日志目录负载字节数（与 makeRoot 写进 session.v4.jsonl.zstd 的一致）。 */
const HOME_LOG_BYTES = 1024;

await test('sessionsRoot/projectionCacheDir/projectionCacheFile 都从 DSH_HOME 推导', async () => {
	const home = await mkdtemp(path.join(tmpdir(), 'sess-del-home-'));
	createdRoots.push(home);
	const id = 'layout11-222-3333-4444-555566667777';
	await withHome(home, () => {
		assert.equal(sessionsRoot(), path.join(home, 'sessions'));
		assert.equal(projectionCacheDir(), homeCacheDir(home));
		assert.equal(projectionCacheFile(id), path.join(homeCacheDir(home), `${id}.json`));
	});
});

await test('apply 注册了 effect 与 POST 路由（路径 + buffered requestBody）', async () => {
	const { ctx, calls } = makeFakeCtx({});
	apply(ctx);
	assert.equal(calls.effects, 1);
	assert.equal(SESSION_DELETE_PATH, '/api/session.delete');
	assert.equal(calls.route.path, SESSION_DELETE_PATH);
	assert.deepEqual(calls.route.methods, ['POST']);
	assert.equal(calls.route.requestBody, 'buffered');
	assert.equal(typeof calls.route.fetch, 'function');
});

await test('运行中的会话被拒（status=running）：不删文件、不广播、不摘记账', async () => {
	const id = 'live1111-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	// 注意：`liveIds` 现在返回 `{ id, status: 'running' }`（旧版返回无 status 的 `{ id }`，
	// 那是"驻留即拒绝"的假现场）。语义升级：被拒的唯一理由是**正在运行**，不是"驻留"。
	const { ctx, calls } = makeFakeCtx({ liveIds: [id] });
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, false);
	assert.equal(result.code, 'SESSION_ACTIVE');
	assert.deepEqual(result, { ok: false, code: 'SESSION_ACTIVE', message: '该会话正在运行，请先停止或先归档' });
	// 三件"什么都不做"都要断言：不广播、不摘记账（两步）、不删文件
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(calls.unarchived, []);
	assert.deepEqual(calls.unpinned, []);
	assert.equal(calls.logs.length, 0);
	assert.equal((await stat(sessionDir)).isDirectory(), true);
	assert.equal((await stat(cacheFile)).size, CACHE_BYTES);
	// 正常拒绝不该打形状漂移告警（status 就是枚举里的 running）
	assert.deepEqual(calls.warns, []);
});

await test('驻留但已停止（status=idle）：允许删除 —— 修「显示已停止却删不掉」', async () => {
	// 这是用户 2026-09-26 实测报的 bug 的回归用例：agent **仍驻留**（标签页开着、`ctx.agents.get`
	// 拿得到对象），但 `status === 'idle'`（最后一回合被中断，UI 显示"已停止"）。
	// 旧实现的判据是"驻留即拒绝"⇒ 回 SESSION_ACTIVE，用户删不掉。
	const id = 'idle1111-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile, cacheBytes } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls } = makeFakeCtx({ residentStatuses: { [id]: 'idle' } });
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.code, undefined);
	assert.equal(result.logDir, 'removed');
	assert.deepEqual(result.failed, []);
	assert.equal(result.freedBytes, HOME_LOG_BYTES + cacheBytes);
	// 文件**真的**被删掉了（不是只回了个 ok）
	await assert.rejects(stat(sessionDir), '日志目录必须真被删掉');
	await assert.rejects(stat(cacheFile), '投影缓存必须真被删掉');
	// 记账照摘、广播照发（idle 不是"不能删"的理由）
	assert.deepEqual(calls.unarchived, [id]);
	assert.deepEqual(calls.unpinned, [id]);
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
	assert.equal(calls.logs.length, 1);
	assert.match(calls.logs[0], /logDir=removed/);
	// 这是正常路径（status 就在枚举里），不该有形状漂移告警
	assert.deepEqual(calls.warns, []);
});

await test('agent.status 非预期值 / 缺失：按「未运行」处理（允许删除），漂移只留一条 warning', async () => {
	// 判据取舍（必须写进实现注释、也必须有用例守住）：
	// 枚举只有两值（9 个包的 typert 一致声明 `AgentStatus = 'idle' | 'running'`）。
	// status 奇怪时**选择允许删除**，而不是保守拒绝 —— "拒绝"正是本次用户报告的故障模式
	// （把"驻留"当"运行"）；形状漂移用一条 warning 让它可见就够了，绝不能因此又变成删不掉。
	for (const [label, status] of [['非预期值', 'paused'], ['缺失', undefined]]) {
		const id = `weird${label === '缺失' ? 'nul' : 'bad'}-222-3333-4444-555566667777`;
		const { home, sessionDir } = await makeSessionHome(id);
		const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
		const { ctx, calls } = makeFakeCtx({ residentStatuses: { [id]: status } });
		const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
		assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
		await assert.rejects(stat(sessionDir), `${label}: 日志目录必须真被删掉`);
		await assert.rejects(stat(cacheFile), `${label}: 投影缓存必须真被删掉`);
		assert.deepEqual(calls.emitted, [['api-session/removed', id]], label);
		// 漂移必须**可见**：恰好一条 warning，且带 id、带 "status"、带原始值
		assert.equal(calls.warns.length, 1, `${label}: ${JSON.stringify(calls.warns)}`);
		assert.match(calls.warns[0], /session-delete/, label);
		assert.match(calls.warns[0], /status/, label);
		assert.ok(calls.warns[0].includes(id), `${label}: warning 里必须有会话 id`);
		assert.ok(calls.warns[0].includes(JSON.stringify(status)), `${label}: warning 里必须有原始值`);
	}
});

await test('非法 id 被拒：不碰文件系统、不广播、不摘记账', async () => {
	const id = 'invalid1-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: '../etc/passwd' }));
	// 早退形状：连 sessionId 都不回，更没有 deleted/failed —— 证明根本没走到文件系统那一段
	assert.deepEqual(result, { ok: false, code: 'INVALID_SESSION_ID', message: '会话 id 非法' });
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(calls.unarchived, []);
	assert.deepEqual(calls.unpinned, []);
	assert.equal(calls.logs.length, 0);
	// 现场（含**合法 id 的**日志目录与缓存）一字节未动
	assert.equal((await stat(sessionDir)).isDirectory(), true);
	assert.equal((await stat(cacheFile)).size, CACHE_BYTES);
	// 连 body 根本不是对象也一样（route handler 传的就是解析后的 body，可能是 null）
	assert.equal((await withHome(home, () => handleSessionDelete(ctx, null))).code, 'INVALID_SESSION_ID');
	assert.equal((await withHome(home, () => handleSessionDelete(ctx, undefined))).code, 'INVALID_SESSION_ID');
	assert.equal((await withHome(home, () => handleSessionDelete(ctx, {}))).code, 'INVALID_SESSION_ID');
});

await test('正常删除：清归档 + 清置顶 + 恰好广播一次 + 字节数>0 + 两个目标都消失', async () => {
	const id = 'ok111111-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile, cacheBytes } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.code, undefined);
	assert.equal(result.logDir, 'removed');
	assert.equal(result.clearedArchive, true);
	assert.equal(result.clearedPin, true);
	assert.equal(result.alreadyAbsent, false);
	assert.deepEqual(result.failed, []);
	assert.deepEqual(calls.unarchived, [id]);
	assert.deepEqual(calls.unpinned, [id]);
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
	assert.equal(calls.emitted.length, 1, '必须恰好广播一次');
	assert.ok(result.freedBytes > 0);
	assert.equal(result.freedBytes, HOME_LOG_BYTES + cacheBytes);
	assert.deepEqual([...result.deleted].sort(), [sessionDir, cacheFile].sort());
	await assert.rejects(stat(sessionDir));
	await assert.rejects(stat(cacheFile));
	// 审计日志走 ctx.logger.info，且带 logDir/字节数
	assert.equal(calls.logs.length, 1);
	assert.match(calls.logs[0], /logDir=removed/);
	assert.match(calls.logs[0], new RegExp(`freedBytes=${HOME_LOG_BYTES + cacheBytes}`));
});

await test('logDir=indeterminate（sessions 本身是普通文件）：绝不摘记账，且报 PARTIAL_FAILURE', async () => {
	const id = 'indet111-222-3333-4444-555566667777';
	const home = await mkdtemp(path.join(tmpdir(), 'sess-del-home-'));
	createdRoots.push(home);
	// 让 <home>/sessions 本身是个**文件** → locateSessionDirectory 抛 ENOTDIR → indeterminate。
	// 判据：indeterminate ≠ absent，所以宁可什么都不摘，也不能替用户"取消归档"。
	await writeFile(path.join(home, 'sessions'), 'x');
	const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, false);
	assert.equal(result.code, 'PARTIAL_FAILURE');
	assert.equal(result.logDir, 'indeterminate');
	// ⚠️ PARTIAL_FAILURE 路径回的是 `cleared: {archived, pinned}`（成功路径才摊平成
	// clearedArchive/clearedPin 两个布尔）—— 以 index.mjs 的权威实现为准，别照抄任务书里的字段名。
	assert.deepEqual(result.cleared, { archived: false, pinned: false });
	assert.notEqual(result.cleared.archived, true);
	assert.notEqual(result.cleared.pinned, true);
	assert.deepEqual(calls.unarchived, [], 'unarchiveSession 绝不能被调用');
	assert.deepEqual(calls.unpinned, [], 'unpinSession 绝不能被调用');
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(result.deleted, []);
	assert.equal(result.freedBytes, 0);
	assert.equal(result.failed.length, 1);
	assert.equal(result.failed[0].phase, 'locate');
	// 无法判定时缓存照旧原封不动（core 在定位阶段就早退了）
	assert.equal((await stat(cacheFile)).size, CACHE_BYTES);
});

await test('logDir=absent（幂等路径）：允许摘记账 —— 与 indeterminate 区分开', async () => {
	const id = 'absent11-222-3333-4444-555566667777';
	const home = await mkdtemp(path.join(tmpdir(), 'sess-del-home-'));
	createdRoots.push(home);
	await mkdir(path.join(home, 'sessions'), { recursive: true }); // root 存在，但没有该 id 的目录
	await seedCache(home, id); // 缓存目录在、缓存文件不在
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.logDir, 'absent');
	assert.equal(result.alreadyAbsent, true);
	// 这条用例的全部价值就在这两行：absent 要摘记账，indeterminate 不许摘
	assert.equal(result.clearedArchive, true);
	assert.equal(result.clearedPin, true);
	assert.deepEqual(calls.unarchived, [id]);
	assert.deepEqual(calls.unpinned, [id]);
	// 什么都没删 → 不该广播
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(result.deleted, []);
	assert.equal(result.freedBytes, 0);
});

await test('注册表摘标记失败：PARTIAL_FAILURE，但文件仍被删、仍广播、另一步照跑', async () => {
	const id = 'regfail1-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls } = makeFakeCtx({ registryThrows: true });
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, false);
	assert.equal(result.code, 'PARTIAL_FAILURE');
	assert.equal(result.logDir, 'removed');
	assert.equal(result.failed.length, 1, JSON.stringify(result.failed));
	assert.equal(result.failed[0].step, 'unarchiveSession');
	assert.match(result.failed[0].message, /registry down/);
	assert.equal(result.cleared.archived, false);
	assert.equal(result.cleared.pinned, true, '一步失败不得跳过另一步');
	assert.deepEqual(calls.unpinned, [id]);
	// 破坏性步骤已经做成 → 照样广播，否则侧栏会留一行点不动的僵尸
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
	assert.ok(result.deleted.length > 0);
	assert.equal(result.freedBytes, HOME_LOG_BYTES + CACHE_BYTES);
	await assert.rejects(stat(sessionDir));
	await assert.rejects(stat(cacheFile));
});

await test('投影缓存目录被换成普通文件：响亮 PARTIAL_FAILURE，日志目录照删', async () => {
	const id = 'cachefile-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const cacheDir = homeCacheDir(home);
	await mkdir(path.dirname(cacheDir), { recursive: true });
	await writeFile(cacheDir, 'not a directory');
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(home, () => handleSessionDelete(ctx, { sessionId: id }));
	assert.equal(result.ok, false);
	assert.equal(result.code, 'PARTIAL_FAILURE');
	assert.equal(result.logDir, 'removed');
	assert.equal(result.failed.length, 1, JSON.stringify(result.failed));
	assert.equal(result.failed[0].phase, 'guard');
	assert.equal(result.failed[0].code, 'CACHE_DIR_NOT_A_DIRECTORY');
	assert.deepEqual(result.deleted, [sessionDir]);
	assert.equal(result.freedBytes, HOME_LOG_BYTES);
	// 日志目录确实删掉了 → 仍摘记账、仍广播；缓存侧只是"响亮地没做"
	// （PARTIAL_FAILURE 路径回 `cleared` 对象，成功路径才摊平成 clearedArchive/clearedPin）
	assert.deepEqual(result.cleared, { archived: true, pinned: true });
	assert.deepEqual(calls.unarchived, [id]);
	assert.deepEqual(calls.unpinned, [id]);
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
	assert.equal((await stat(cacheDir)).size, 'not a directory'.length, '那个"目录"必须原地未动');
	await assert.rejects(stat(sessionDir));
});

await test('route handler 状态码映射：坏 JSON 400 / 非法 id 400 / 运行中 409 / 成功 200 / 部分失败 500', async () => {
	const id = 'route111-222-3333-4444-555566667777';
	const { home, sessionDir } = await makeSessionHome(id);
	const { cacheFile } = await seedCache(home, id, { payload: CACHE_PAYLOAD });
	const { ctx, calls, live } = makeFakeCtx({ liveIds: [id] });
	apply(ctx);
	const handler = calls.route.fetch;
	const asBody = (body) => ({ json: async () => body });

	// 坏 JSON → 400 BAD_JSON（解析失败绝不进业务逻辑）
	const badJson = await handler({ json: async () => { throw new SyntaxError('bad'); } });
	assert.equal(badJson.status, 400);
	assert.equal((await badJson.json()).code, 'BAD_JSON');

	// 非法 id → 400
	const invalid = await handler(asBody({ sessionId: '../etc' }));
	assert.equal(invalid.status, 400);
	assert.equal((await invalid.json()).code, 'INVALID_SESSION_ID');

	// 运行中（status=running）→ 409，且文件一字节没动
	const active = await withHome(home, () => handler(asBody({ sessionId: id })));
	assert.equal(active.status, 409);
	assert.equal((await active.json()).code, 'SESSION_ACTIVE');
	assert.equal((await stat(sessionDir)).isDirectory(), true);
	assert.equal((await stat(cacheFile)).size, CACHE_BYTES);

	// 成功 → 200；body 必须带 logDir，且**没有** spike（Task 1 的临时标记必须已消失）
	live.clear();
	const ok = await withHome(home, () => handler(asBody({ sessionId: id })));
	assert.equal(ok.status, 200);
	const okBody = await ok.json();
	assert.equal(okBody.ok, true);
	assert.equal(okBody.logDir, 'removed');
	assert.equal('spike' in okBody, false);
	await assert.rejects(stat(sessionDir));

	// 部分失败 → 500
	const brokenHome = await mkdtemp(path.join(tmpdir(), 'sess-del-home-'));
	createdRoots.push(brokenHome);
	await writeFile(path.join(brokenHome, 'sessions'), 'x'); // root 是文件 → indeterminate
	const partial = await withHome(brokenHome, () => handler(asBody({ sessionId: id })));
	assert.equal(partial.status, 500);
	assert.equal((await partial.json()).code, 'PARTIAL_FAILURE');
});

// ═════════════════════════════════════════════════════════════════════════
// Task 8：级联删除（cascade）的接线
//
// 现场一律是**真实形态**：`<home>/sessions/<项目>/<id>/session.v4.jsonl.zstd` 是
// **逐帧压缩再拼接**的多帧 zstd（`cascade.mjs` 的 `frameLengths()` 就是按多帧解析的），
// 投影缓存里写 `record.identity`。**绝不依赖真实用户数据。**
// ═════════════════════════════════════════════════════════════════════════
console.log('== Task 8: 级联删除（cascade）==');

/**
 * 用**逐帧压缩再拼接**造多帧 zstd 日志载荷。
 * ⚠️ 不要图省事改成"把整段文本压一次"：那只会产出**单帧**，`frameLengths()` 的逐帧路径
 * 就完全测不到了（本机实测：单帧文件解出来是完整的，但帧表长度恒为 1）。
 */
function zstdFrames(lines) {
	return Buffer.concat(lines.map((line) => zlib.zstdCompressSync(Buffer.from(line, 'utf8'))));
}

/** 一条 `subagent/catalog` 事件行（与 DSH 写盘格式同构：顶层 type + seq + data.childId/childCreatedAt）。 */
function catalogLine(seq, childId, childCreatedAt) {
	return `${JSON.stringify({ type: 'subagent/catalog', seq, data: { childId, childCreatedAt } })}\n`;
}

/** 新建一个 home（登记进 createdRoots，收尾统一清）。 */
async function makeCascadeHome() {
	const home = await mkdtemp(path.join(tmpdir(), 'sess-del-cascade-'));
	createdRoots.push(home);
	return home;
}

/** 在 home 里写一个会话的多帧 zstd 日志；返回 `{ dir, file, bytes }`。 */
async function writeSessionLog(home, sessionId, lines) {
	const dir = path.join(home, 'sessions', '--D-DSH-Day1--', sessionId);
	await mkdir(dir, { recursive: true });
	const buffer = zstdFrames(lines);
	const file = path.join(dir, 'session.v4.jsonl.zstd');
	await writeFile(file, buffer);
	return { dir, file, bytes: buffer.length };
}

/** 在 home 里写一个会话的投影缓存；`identity` 传 null = **有缓存、没有 identity**。 */
async function writeSessionCache(home, sessionId, { identity = null, title = '测试会话' } = {}) {
	const record = { rows: { title: { val: title } } };
	if (identity !== null) record.identity = identity;
	const payload = JSON.stringify({ version: 7, record });
	const dir = homeCacheDir(home);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.json`);
	await writeFile(file, payload);
	return { file, bytes: Buffer.byteLength(payload, 'utf8') };
}

/**
 * 递归清单（相对路径 + 每文件字节数）。
 * 用来断言 dryRun「一个字节都不改」——只看"文件还在"不够，大小也必须在清单里。
 */
async function treeManifest(dir, prefix = '') {
	const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const out = [];
	for (const entry of entries) {
		const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(`${rel}/`);
			out.push(...(await treeManifest(full, rel)));
		} else {
			out.push(`${rel}:${(await stat(full)).size}`);
		}
	}
	return out;
}

/** 完整级联现场：父会话 + 若干子会话（各有真实多帧日志与投影缓存），父缓存里带 `record.identity`。 */
async function makeCascadeScene({
	parentId,
	parentCreatedAt = 1000,
	inheritedEventCount = 0,
	children = [],
	rawLogLines = [],
	identity = 'present'
}) {
	const home = await makeCascadeHome();
	const lines = [];
	let seq = inheritedEventCount + 1;
	for (const child of children) {
		lines.push(catalogLine(child.seq ?? seq, child.id, child.createdAt));
		seq += 1;
	}
	lines.push(...rawLogLines);
	// 每个 catalog 事件单独一帧 + 末尾一帧普通事件：真正的多帧文件。
	const parentLog = await writeSessionLog(home, parentId, lines.concat(['{"type":"session/end"}\n']));
	const parentIdentity =
		identity === 'present'
			? { createdAt: parentCreatedAt, inheritedEventCount }
			: identity === 'broken'
				? { createdAt: 'not-a-number', inheritedEventCount }
				: null;
	const parentCache = await writeSessionCache(home, parentId, { identity: parentIdentity });
	const childScenes = [];
	for (const child of children) {
		const log = await writeSessionLog(home, child.id, ['{"type":"session/start"}\n']);
		const cache = await writeSessionCache(home, child.id, {
			identity: { createdAt: child.createdAt, inheritedEventCount: 0 }
		});
		childScenes.push({
			id: child.id,
			dir: log.dir,
			logFile: log.file,
			bytes: log.bytes,
			cacheFile: cache.file,
			cacheBytes: cache.bytes
		});
	}
	return {
		home,
		root: path.join(home, 'sessions'),
		parentDir: parentLog.dir,
		parentLogFile: parentLog.file,
		parentLogBytes: parentLog.bytes,
		parentCacheFile: parentCache.file,
		parentCacheBytes: parentCache.bytes,
		childScenes
	};
}

const P_ID = 'parent01-222-3333-4444-555566667777';
const C1_ID = 'child001-222-3333-4444-555566667777';
const C2_ID = 'child002-222-3333-4444-555566667777';
/** 父会话派生了 C1_ID 与 C2_ID 的标准现场。 */
const twoChildren = [
	{ id: C1_ID, createdAt: 1100 },
	{ id: C2_ID, createdAt: 1200 }
];

console.log('-- Task 8.1: dryRun（只读计划）--');

await test('dryRun:true 一个字节都不改，且计划正确（targetBytes / children / cascade=ok）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({});
	const before = await treeManifest(scene.home);
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.dryRun, true);
	assert.equal(result.sessionId, P_ID);
	// targetBytes 用 directoryBytes 量（父日志目录里只有那一个多帧日志文件）
	assert.equal(result.targetBytes, scene.parentLogBytes);
	assert.equal(result.cascade, 'ok');
	assert.equal(result.cascadeReason, undefined);
	assert.equal(result.children.total, 2);
	assert.deepEqual([...result.children.ids].sort(), [C1_ID, C2_ID].sort());
	assert.deepEqual(result.children.running, []);
	// children.bytes = 各子会话**日志目录**字节和（directoryBytes；不含投影缓存，与 freedBytes 口径不同）
	assert.equal(result.children.bytes, scene.childScenes.reduce((sum, s) => sum + s.bytes, 0));

	// 六件"什么都不做"：广播 / 摘归档 / 摘置顶 / 审计日志 / 告警 / 文件系统
	assert.deepEqual(calls.emitted, [], 'dryRun 绝不广播');
	assert.deepEqual(calls.unarchived, [], 'dryRun 绝不摘归档');
	assert.deepEqual(calls.unpinned, [], 'dryRun 绝不摘置顶');
	assert.deepEqual(calls.logs, [], 'dryRun 不产生审计日志');
	assert.deepEqual(calls.warns, []);
	assert.deepEqual(await treeManifest(scene.home), before, 'dryRun 必须一个字节都不改');
});

await test('dryRun + 有子会话在运行：ok:true 且带回 running（**不**拒绝——弹窗要在确认前就能警告并禁用）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ liveIds: [C1_ID] });
	const before = await treeManifest(scene.home);
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.dryRun, true);
	assert.equal(result.children.total, 2);
	assert.deepEqual(result.children.running, [C1_ID], '运行的子会话必须原样带出来给弹窗');
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(await treeManifest(scene.home), before);
});

await test('dryRun + identity 缺失：ok:true / cascade=unavailable + cascadeReason（仍可删目标）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren, identity: 'absent' });
	const { ctx, calls } = makeFakeCtx({});
	const before = await treeManifest(scene.home);
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.dryRun, true);
	assert.equal(result.cascade, 'unavailable');
	assert.equal(result.cascadeReason, 'IDENTITY_UNAVAILABLE');
	assert.equal(result.children.total, 0);
	assert.deepEqual(result.children.ids, []);
	assert.equal(result.children.bytes, 0);
	assert.deepEqual(result.children.running, []);
	assert.equal(result.targetBytes, scene.parentLogBytes, '拿不到 identity 也要照常量目标字节数');
	assert.deepEqual(await treeManifest(scene.home), before);
});

await test('dryRun 也走目标活体判定：目标 running ⇒ SESSION_ACTIVE（级联绝不绕过活体判定的入口）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ liveIds: [P_ID] });
	const before = await treeManifest(scene.home);
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.deepEqual(result, { ok: false, code: 'SESSION_ACTIVE', message: '该会话正在运行，请先停止或先归档' });
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(calls.logs, []);
	assert.deepEqual(await treeManifest(scene.home), before);
});

await test('dryRun 的 children.bytes 容错：子会话目录不存在 ⇒ 计 0，绝不因此失败', async () => {
	// 父日志里写了一个磁盘上根本不存在的子会话 id（真实场景：子会话已被单独删掉）。
	const ghost = 'ghost001-222-3333-4444-555566667777';
	const scene = await makeCascadeScene({ parentId: P_ID, rawLogLines: [catalogLine(1, ghost, 1100)] });
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.children.total, 1);
	assert.deepEqual(result.children.ids, [ghost]);
	assert.equal(result.children.bytes, 0, '量不到字节必须计 0，而不是失败');
	assert.ok(result.targetBytes > 0);
});

console.log('-- Task 8.2: 真删（子会话 → 目标）--');

await test('有子会话：子会话的日志+缓存+记账全删、children 明细与 freedBytes 正确、每个被删会话各广播一次', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.cascade, 'ok');
	assert.equal(result.cascadeReason, undefined);
	assert.equal(result.children.total, 2);
	assert.deepEqual([...result.children.deleted].sort(), [C1_ID, C2_ID].sort());
	assert.deepEqual(result.children.failed, []);
	assert.deepEqual(result.children.skipped, []);
	// children.freedBytes = 子会话**日志目录 + 投影缓存**的字节和（与 deleteSessionArtifacts 同口径）
	assert.equal(
		result.children.freedBytes,
		scene.childScenes.reduce((sum, s) => sum + s.bytes + s.cacheBytes, 0)
	);
	// 顶层 freedBytes 仍是目标自己的字节数（既有字段语义不变；子会话的字节进 children.freedBytes）
	assert.equal(result.freedBytes, scene.parentLogBytes + scene.parentCacheBytes);

	// 磁盘：父与两个子会话的日志目录 + 投影缓存**全部**消失
	for (const child of scene.childScenes) {
		await assert.rejects(stat(child.dir), `子会话日志目录必须被删：${child.id}`);
		await assert.rejects(stat(child.cacheFile), `子会话投影缓存必须被删：${child.id}`);
	}
	await assert.rejects(stat(scene.parentDir));
	await assert.rejects(stat(scene.parentCacheFile));

	// 记账：子会话走**同一条**路径（先子后目标）
	assert.deepEqual([...calls.unarchived].sort(), [C1_ID, C2_ID, P_ID].sort());
	assert.deepEqual([...calls.unpinned].sort(), [C1_ID, C2_ID, P_ID].sort());

	// 广播：删了谁就广播谁，各恰好一次
	assert.equal(calls.emitted.length, 3, JSON.stringify(calls.emitted));
	assert.ok(calls.emitted.every(([event]) => event === 'api-session/removed'), JSON.stringify(calls.emitted));
	assert.deepEqual([...calls.emitted.map(([, id]) => id)].sort(), [C1_ID, C2_ID, P_ID].sort());

	// 审计日志：仍**只有一条**，且只记数量与失败数 —— 绝不把 id 塞进日志行
	assert.equal(calls.logs.length, 1);
	assert.match(calls.logs[0], /logDir=removed/);
	assert.match(calls.logs[0], /cascade=ok/);
	assert.match(calls.logs[0], /children=2/);
	assert.ok(!calls.logs[0].includes(C1_ID) && !calls.logs[0].includes(C2_ID), `日志行不得塞入子会话 id：${calls.logs[0]}`);
});

await test('任一子会话在运行 ⇒ CHILDREN_ACTIVE（fail-closed）：整体拒绝、一个字节都不删、不广播', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ liveIds: [C1_ID] });
	const before = await treeManifest(scene.home);
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.deepEqual(result, {
		ok: false,
		code: 'CHILDREN_ACTIVE',
		message: '该会话派生了 1 个仍在运行的子代理会话，请等它们结束再删除',
		childrenRunning: [C1_ID]
	});
	// 一个字节都不删（目标与两个子会话都在）+ 不广播 + 不摘记账 + 不写审计日志
	assert.deepEqual(await treeManifest(scene.home), before);
	assert.deepEqual(calls.emitted, []);
	assert.deepEqual(calls.unarchived, []);
	assert.deepEqual(calls.unpinned, []);
	assert.deepEqual(calls.logs, []);
});

await test('identity 缺失 ⇒ cascade=unavailable + cascadeReason，**仍删目标**、不碰子会话', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren, identity: 'absent' });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.cascade, 'unavailable');
	assert.equal(result.cascadeReason, 'IDENTITY_UNAVAILABLE');
	assert.equal(result.children.total, 0);
	assert.deepEqual(result.children.deleted, []);
	assert.equal(result.children.freedBytes, 0);
	// 目标照删
	await assert.rejects(stat(scene.parentDir));
	await assert.rejects(stat(scene.parentCacheFile));
	// 子会话一个字节都不动
	for (const child of scene.childScenes) {
		assert.equal((await stat(child.dir)).isDirectory(), true, `${child.id} 的日志目录必须原地未动`);
		assert.equal((await stat(child.cacheFile)).isFile(), true);
	}
	assert.deepEqual(calls.emitted, [['api-session/removed', P_ID]], '只有目标的广播');
	assert.match(calls.logs[0], /cascade=unavailable/);
	assert.match(calls.logs[0], /cascadeReason=IDENTITY_UNAVAILABLE/);
});

await test('子会话删除失败 ⇒ 整体 PARTIAL_FAILURE + children.failed 明细（目标照删）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const [first, second] = scene.childScenes;
	// hermetic 构造：把第一个子会话的**缓存目标**换成非空目录 ⇒ 非递归 rm 必抛 ERR_FS_EISDIR
	// （与既有 Task 3 用例同一套构造）。它的日志目录仍会被删掉，所以这是一次**真·部分失败**。
	await rm(first.cacheFile, { force: true });
	await mkdir(first.cacheFile, { recursive: true });
	await writeFile(path.join(first.cacheFile, 'blocker.bin'), Buffer.alloc(64, 3));
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, false);
	assert.equal(result.code, 'PARTIAL_FAILURE');
	assert.equal(result.children.total, 2);
	assert.deepEqual(result.children.deleted, [second.id], '只有删干净的那个进 deleted');
	assert.equal(result.children.failed.length, 1, JSON.stringify(result.children.failed));
	assert.equal(result.children.failed[0].id, first.id);
	assert.equal(result.children.failed[0].code, 'ERR_FS_EISDIR');
	assert.match(result.children.failed[0].message, /EISDIR|directory/i);
	// 失败的那部分字节（缓存）不计入；日志已删所以计入
	assert.equal(result.children.freedBytes, first.bytes + second.bytes + second.cacheBytes);
	// 顶层 failed 里也要有一条能让弹窗显示的明细（否则用户只看到"部分失败"却没有线索）
	assert.equal(result.failed.length, 1, JSON.stringify(result.failed));
	assert.equal(result.failed[0].target, first.id);
	assert.equal(result.failed[0].phase, 'child');
	assert.equal(result.failed[0].code, 'ERR_FS_EISDIR');
	// 目标与干净的那个子会话都已删除；被占住的缓存原地未动
	await assert.rejects(stat(scene.parentDir));
	await assert.rejects(stat(second.dir));
	await assert.rejects(stat(first.dir), '失败子会话的**日志目录**仍应被删掉');
	assert.equal((await stat(path.join(first.cacheFile, 'blocker.bin'))).size, 64);
	// 广播仍是"删了谁就广播谁"：三个会话的日志都被删了 ⇒ 三次广播
	assert.deepEqual([...calls.emitted.map(([, id]) => id)].sort(), [C1_ID, C2_ID, P_ID].sort());
});

await test('子会话本就不存在（alreadyAbsent）⇒ 算**成功**：不进 failed、不报错、也不广播', async () => {
	// 幂等路径：父日志里记着一个磁盘上早就没有的子会话（子会话被单独删过）。
	// 契约是"alreadyAbsent 的子会话算成功"——否则用户会看到一个永远删不掉的幽灵子会话。
	const ghost = 'ghost002-222-3333-4444-555566667777';
	const scene = await makeCascadeScene({ parentId: P_ID, rawLogLines: [catalogLine(1, ghost, 1100)] });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.cascade, 'ok');
	assert.deepEqual(result.children.deleted, [ghost], 'alreadyAbsent 也算删成功');
	assert.deepEqual(result.children.failed, []);
	assert.equal(result.children.freedBytes, 0);
	// "删了谁就广播谁"：它一个字节都没删 ⇒ 不该广播（与目标的 absent 路径同口径）
	assert.deepEqual(calls.emitted, [['api-session/removed', P_ID]]);
	await assert.rejects(stat(scene.parentDir));
});

console.log('-- Task 8.2b: 日志文件的识别（不写死文件名 / 多版本 / 坏文件）--');

await test('日志文件名**不写死**：session.v9.jsonl.zstd（未来版本号）照样认得出', async () => {
	// 版本号会变（v4 → v5 → …），所以只按 `.jsonl.zstd` 后缀匹配；写死 `session.v4.jsonl.zstd`
	// 会让本功能在某次升级后**静默失效**（cascade 永远 unavailable，用户只看到"不级联"）。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	await rename(scene.parentLogFile, path.join(scene.parentDir, 'session.v9.jsonl.zstd'));
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.equal(result.cascade, 'ok', JSON.stringify(result));
	assert.equal(result.children.total, 2);
	assert.equal(result.targetBytes, scene.parentLogBytes);
});

await test('同目录多个版本：取**版本号最大**的那个（确定性，不是"读到哪个算哪个"）', async () => {
	// v4 里有两条 catalog 事件、v9 里没有。取 v9 ⇒ 0 个子会话；取 v4 ⇒ 2 个。
	// 这条把"选哪个文件"这个隐性决策钉死成可断言的行为（当前版本号的那个才是真日志）。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	await writeFile(path.join(scene.parentDir, 'session.v9.jsonl.zstd'), zstdFrames(['{"type":"session/start"}\n']));
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.equal(result.cascade, 'none', `必须取 v9（无条件/顺序取文件会得到 2）：${JSON.stringify(result.children)}`);
	assert.equal(result.children.total, 0);
});

await test('日志损坏（帧解析失败）⇒ 同样**不级联**、仍删目标，并把 reason 带出来', async () => {
	// `ok:false` 的所有形态都必须走"放弃级联"这一条（宁可少删）：这里覆盖 FRAME_PARSE_FAILED，
	// identity 缺失与日志不存在分别由另外两条用例覆盖。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	await writeFile(scene.parentLogFile, Buffer.from('not a zstd frame at all', 'utf8'));
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.cascade, 'unavailable');
	assert.equal(result.cascadeReason, 'FRAME_PARSE_FAILED');
	assert.equal(result.children.total, 0);
	// 子会话一个字节都没动；目标照删
	for (const child of scene.childScenes) {
		assert.equal((await stat(child.dir)).isDirectory(), true, `${child.id} 必须原地未动`);
	}
	await assert.rejects(stat(scene.parentDir));
});

console.log('-- Task 8.3: 顺序不变量（先读子列表，再删目标）--');

await test('顺序：父日志被同一次调用删掉，子列表仍完整（删完再读必然是 LOG_FILE_NOT_FOUND）', async () => {
	// 这是**行为级**的顺序断言，不是对调用栈的猜测：
	// 父会话日志是子列表的唯一来源，而它被本次调用删除。若实现先删目标再读日志，
	// `collectChildSessionIds` 只会得到 LOG_FILE_NOT_FOUND ⇒ cascade=unavailable、children 全空。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.cascade, 'ok', JSON.stringify(result));
	assert.equal(result.children.total, 2, '子列表必须在删目标之前读到');
	assert.equal(result.children.deleted.length, 2);
	await assert.rejects(stat(scene.parentLogFile), '父日志确实已被这次调用删除');
});

await test('对照组：父日志本就不存在 ⇒ cascade=unavailable / LOG_FILE_NOT_FOUND（证明上一条的判据有区分度）', async () => {
	// 只删日志文件、保留父会话目录与缓存（identity 还在）⇒ 必须**无法判定**，
	// 而不是"没找到子会话"。这条同时锁住"日志读不到就必须放弃级联"这条兜底。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	await rm(scene.parentLogFile, { force: true });
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.cascade, 'unavailable');
	assert.equal(result.cascadeReason, 'LOG_FILE_NOT_FOUND');
	assert.equal(result.children.total, 0);
	assert.deepEqual(result.children.deleted, []);
	// 目标仍照删（级联放弃 ≠ 目标不删）
	assert.equal(result.logDir, 'removed');
	await assert.rejects(stat(scene.parentDir));
});

console.log('-- Task 8.4: 第 2 层防御（cascade.mjs 已校验，调用方再防一层）--');

await test('子列表里出现**目标自己** ⇒ 丢弃（进 skipped，不计入 total），绝不当成子会话去删', async () => {
	// 自我引用是**合法形状**的 id，`cascade.mjs` 拦不住（它只管 id 形状与继承判据），
	// 所以这一层必须由调用方挡住 —— 否则会把目标当"子会话"先删一遍。
	const scene = await makeCascadeScene({ parentId: P_ID, rawLogLines: [catalogLine(1, P_ID, 1001)] });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));

	// `cascade` 记的是"**最终要不要级联**"：候选被第 2 层防御丢光 ⇒ 没有可级联的东西 ⇒ "none"
	// （丢掉的条目仍在 `skipped` 里可见，信息没丢）。它**不是**"collect 有没有返回 ok"的复述。
	assert.equal(result.cascade, 'none', '候选被丢光 ⇒ 无可级联 ⇒ none');
	assert.equal(result.children.total, 0, '目标自己不计入 total');
	assert.deepEqual(result.children.skipped, [{ id: P_ID, reason: 'SELF_REFERENCE' }]);
	assert.deepEqual(result.children.deleted, []);
	// 记账与广播**各只有一次**（就是目标自己那一次）——绝没有"先当子删、再删目标"的第二遍
	assert.deepEqual(calls.unarchived, [P_ID]);
	assert.deepEqual(calls.unpinned, [P_ID]);
	assert.deepEqual(calls.emitted, [['api-session/removed', P_ID]]);
	await assert.rejects(stat(scene.parentDir));
});

await test('子列表里出现非法 id（穿越形态）⇒ 绝不进入删除计划、绝不碰 root 之外', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, rawLogLines: [catalogLine(1, '../evil', 1001)] });
	const { ctx, calls } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.children.total, 0);
	assert.deepEqual(result.children.deleted, []);
	assert.deepEqual(calls.emitted, [['api-session/removed', P_ID]]);
	await assert.rejects(stat(path.join(scene.home, 'sessions', 'evil')));
	await assert.rejects(stat(path.join(scene.home, 'evil')));
});

await test('上限沿用 MAX_CHILDREN：计划里的子会话数永不超过它', async () => {
	// 这里不造 501 个子会话（成本高且 cascade.mjs 的截断已在自己的测试里覆盖），
	// 只锁住"返回体里的计划长度不会突破上限"这条对外契约。
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx } = makeFakeCtx({});
	const result = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.ok(result.children.total <= MAX_CHILDREN, `${result.children.total} > ${MAX_CHILDREN}`);
});

console.log('-- Task 8.5: route handler 的状态码映射 --');

await test('route handler：dryRun → 200、CHILDREN_ACTIVE → 409（与 SESSION_ACTIVE 同档）、且两者都没删东西', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ liveIds: [C1_ID] });
	apply(ctx);
	const handler = calls.route.fetch;
	const asBody = (body) => ({ json: async () => body });
	const before = await treeManifest(scene.home);

	// 真删被 fail-closed 拒绝 → 409
	const rejected = await withHome(scene.home, () => handler(asBody({ sessionId: P_ID })));
	assert.equal(rejected.status, 409);
	assert.equal((await rejected.json()).code, 'CHILDREN_ACTIVE');

	// dryRun → 200，且把"有一个在跑"带出来给弹窗
	const planned = await withHome(scene.home, () => handler(asBody({ sessionId: P_ID, dryRun: true })));
	assert.equal(planned.status, 200);
	const planBody = await planned.json();
	assert.equal(planBody.ok, true);
	assert.equal(planBody.dryRun, true);
	assert.deepEqual(planBody.children.running, [C1_ID]);

	assert.deepEqual(await treeManifest(scene.home), before, '两条路径都不许动文件');
});

// ═════════════════════════════════════════════════════════════════════════
// Task 9：attached 探测（「删了但侧栏行还在」的如实上报）
//
// 根因（2026-09-26 已定位，证据见 work\session-delete-20260926\root-cause-stale-row.md）：
// 侧栏会话列表 = **attached**（内存里活着的）+ **persisted**（磁盘上的）
// （`dsh-api-session-controller\lib\index.js:1832` 的 JSDoc 原文就是
// "Read every visible attached and persisted Session without activating an Agent."）。
// 我们只能删掉 persisted 那一半；会话只要被**打开过**就仍 attached，官方那条
// `api-session/removed` 要等它 `session/disposed` 才发（同文件 `:2876-2878`）。
// 插件**没有公开入口**能摘掉 attached 会话（`sessions` 服务只暴露 create/enter/get/list，
// detach 释放器是 `enter()` 的返回值，只有当初把它装进内存的那一方持有）。
// ⇒ 唯一正确的做法是**如实上报**：宿主在响应里带 `attached`，客户端据此说清
//   "这一行会留到关闭它的标签页 / 重启 DSH 为止"。
// 判据 = `sessions.get(id) !== undefined`（见 makeFakeCtx 的注释）。
// 三态：`true` / `false` / **`undefined`（判不了）** —— 判不了必须原样带出去、**绝不猜**：
// 猜成 false 会把"行会一直显示"的实情说成"已删除会话"，正是本次故障的形态。
// ═════════════════════════════════════════════════════════════════════════
console.log('== Task 9: attached 探测（宿主的如实上报）==');

/**
 * dryRun 与真删**两条**响应都必须带 `attached`（三态原样），且都不许抛。
 * ⚠️ 顺序：dryRun 是只读的，必须**先**跑 —— 真删会把现场删掉。
 */
async function attachedBothWays(home, ctx, { sessionId, expected }) {
	const dry = await withHome(home, () => handleSessionDelete(ctx, { sessionId, dryRun: true }));
	assert.equal(dry.ok, true, JSON.stringify(dry));
	assert.ok('attached' in dry, 'dryRun 响应必须**带** attached 字段（值可以为 undefined）');
	assert.equal(dry.attached, expected, `dryRun.attached 应为 ${String(expected)}，实得 ${String(dry.attached)}`);
	const live = await withHome(home, () => handleSessionDelete(ctx, { sessionId }));
	assert.equal(live.ok, true, JSON.stringify(live));
	assert.ok('attached' in live, '真删响应必须**带** attached 字段');
	assert.equal(live.attached, expected, `真删 attached 应为 ${String(expected)}，实得 ${String(live.attached)}`);
	return { dry, live };
}

/** 只有目标、没有子会话的最小现场（日志是坏的 zstd ⇒ cascade 一定 unavailable）。 */
async function makeAttachedHome(sessionId) {
	const { home, sessionDir } = await makeSessionHome(sessionId);
	const { cacheFile } = await seedCache(home, sessionId, { payload: CACHE_PAYLOAD });
	return { home, sessionDir, cacheFile };
}

await test('attached=true（get 拿到对象）：dryRun 与真删都回 true，且**照删不误**（attached 不是拒绝的理由）', async () => {
	const id = 'attach01-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx, calls } = makeFakeCtx({ attachedIds: [id] });
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: id, expected: true });
	assert.equal(dry.dryRun, true);
	assert.deepEqual(dry.children.attached, [], '没有子会话 ⇒ 空数组（而不是缺字段）');
	assert.deepEqual(live.children.attached, []);
	// 活体判据只看 `agents.get(id).status === "running"`，与 attached（sessions 服务）是**两件事**：
	// attached 只影响**文案**，绝不改删除语义（否则又会退回"开着就删不掉"那个 bug）。
	await assert.rejects(stat(scene.sessionDir), 'attached 也照删磁盘');
	await assert.rejects(stat(scene.cacheFile), 'attached 也照删缓存');
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
	assert.deepEqual(calls.sessionGets, [id, id], 'dryRun 与真删各探测目标一次');
});

await test('attached=false（get 返回 undefined）：两条都回布尔 false（"侧栏不会留行"这一支）', async () => {
	const id = 'attach02-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx, calls } = makeFakeCtx({}); // sessionsMode 默认 "ok"，attachedIds 为空
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: id, expected: false });
	assert.equal(dry.attached === false, true, '必须是**布尔 false**，不是 undefined');
	assert.equal(live.attached === false, true);
	assert.deepEqual(calls.sessionGets, [id, id]);
});

await test('attached=undefined（取不到 sessions 服务）：两条都回 undefined 且不抛 —— 判不了就说判不了', async () => {
	const id = 'attach03-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx, calls } = makeFakeCtx({ sessionsMode: 'absent' });
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: id, expected: undefined });
	// 关键：**绝不是** false —— 猜 false 会让客户端给出"已删除会话"这种不实文案
	assert.notEqual(dry.attached, false);
	assert.notEqual(live.attached, false);
	assert.deepEqual(calls.sessionGets, [], '服务都没有，一次都不该问');
	assert.deepEqual(calls.warns, [], '探测不喧哗：取不到服务不是告警');
	await assert.rejects(stat(scene.sessionDir));
});

await test('attached=undefined（sessions.get 抛错，即 detached/prepared 的 reject 形态）：不抛、不打日志', async () => {
	const id = 'attach04-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx, calls } = makeFakeCtx({ sessionsMode: 'throw' });
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: id, expected: undefined });
	assert.notEqual(dry.attached, false);
	assert.notEqual(live.attached, false);
	assert.deepEqual(calls.sessionGets, [id, id], '确实问过（问了才抛），不是没问');
	// 探测把异常**吞掉**：既不当告警，也不塞进审计日志（那是删除本身的记录）
	assert.deepEqual(calls.warns, []);
	assert.equal(calls.logs.length, 1, 'dryRun 不打日志；真删那一条是删除本身的审计行');
	assert.ok(!calls.logs[0].includes('sessions.get down'), `探测的异常不得进审计日志：${calls.logs[0]}`);
});

await test('attached=undefined（服务在但 get 不是函数）：undefined —— 绝不把"问不了"当成 false', async () => {
	const id = 'attach05-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx } = makeFakeCtx({ sessionsMode: 'no-get' });
	await attachedBothWays(scene.home, ctx, { sessionId: id, expected: undefined });
});

await test('attached=undefined（连 ctx.sessions 的属性访问都抛）：不抛 —— Reflect.get + try 是必需的', async () => {
	const id = 'attach06-222-3333-4444-555566667777';
	const scene = await makeAttachedHome(id);
	const { ctx, calls } = makeFakeCtx({ sessionsMode: 'trap' });
	// 属性访问抛错时，`ctx.sessions` 这种裸读会把异常打穿到 route handler（500）——
	// 所以实现必须用 `Reflect.get` + try/catch 把它归成"判不了"。
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: id, expected: undefined });
	assert.notEqual(dry.attached, false);
	assert.deepEqual(calls.warns, []);
	// 探测不影响删除本身：文件照删、广播照发
	await assert.rejects(stat(scene.sessionDir));
	assert.deepEqual(calls.emitted, [['api-session/removed', id]]);
});

await test('children.attached：仍 attached 的子会话被点名（用户当时正在看的可能正是子会话）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ attachedIds: [C1_ID] }); // 只有 C1 还活在内存里
	const { dry, live } = await attachedBothWays(scene.home, ctx, { sessionId: P_ID, expected: false });
	// 目标自己没 attached（没开它的标签页），但子会话 C1 attached ⇒ C1 的行也会一直显示
	assert.deepEqual(dry.children.attached, [C1_ID]);
	assert.deepEqual(live.children.attached, [C1_ID]);
	// attached 只是**标注**，绝不改变计划：两个子会话照样都删
	assert.deepEqual(dry.children.ids, [C1_ID, C2_ID]);
	assert.deepEqual([...live.children.deleted].sort(), [C1_ID, C2_ID].sort());
	// 每个会话各自探测、每条响应各一轮（顺序不作断言：那是实现细节）
	assert.deepEqual(
		[...calls.sessionGets].sort(),
		[P_ID, P_ID, C1_ID, C1_ID, C2_ID, C2_ID].sort(),
		JSON.stringify(calls.sessionGets)
	);
});

await test('children.attached：有子会话但都不 attached ⇒ 空数组（区别于"缺字段"）', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx } = makeFakeCtx({});
	const dry = await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID, dryRun: true }));
	assert.equal(dry.children.total, 2);
	assert.ok('attached' in dry.children, 'children.attached 必须在，值才是空数组');
	assert.deepEqual(dry.children.attached, []);
});

await test('审计日志行：仍 attached 的子会话只记**数量**，id 绝不进日志行', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ attachedIds: [C1_ID] });
	await withHome(scene.home, () => handleSessionDelete(ctx, { sessionId: P_ID }));
	// 审计日志行：只加**数量**（既有约束：日志行只记数量，500 个 id 能把一行撑到几十 KB）
	assert.equal(calls.logs.length, 1);
	const line = calls.logs[0];
	assert.match(line, /attached=false/, '目标自己的 attached 状态要可查');
	assert.match(line, /childrenAttached=1/, '仍 attached 的子会话只记数量');
	assert.ok(!line.includes(C1_ID) && !line.includes(C2_ID), `日志行不得塞入子会话 id：${line}`);
});

await test('route handler：200 响应体里真的带 attached（JSON 层），dryRun 与真删都是', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ attachedIds: [P_ID] });
	apply(ctx);
	const handler = calls.route.fetch;
	const asBody = (body) => ({ json: async () => body });
	const dry = await withHome(scene.home, () => handler(asBody({ sessionId: P_ID, dryRun: true })));
	assert.equal(dry.status, 200);
	const dryBody = await dry.json();
	assert.equal(dryBody.attached, true);
	assert.deepEqual(dryBody.children.attached, []);
	const ok = await withHome(scene.home, () => handler(asBody({ sessionId: P_ID })));
	assert.equal(ok.status, 200);
	assert.equal((await ok.json()).attached, true);
});

await test('route handler：attached=undefined 时该键在 JSON 里**消失** ⇒ 客户端只能走通用兜底文案', async () => {
	const scene = await makeCascadeScene({ parentId: P_ID, children: twoChildren });
	const { ctx, calls } = makeFakeCtx({ sessionsMode: 'absent' });
	apply(ctx);
	const handler = calls.route.fetch;
	const asBody = (body) => ({ json: async () => body });
	const ok = await withHome(scene.home, () => handler(asBody({ sessionId: P_ID })));
	assert.equal(ok.status, 200);
	const body = await ok.json();
	// `JSON.stringify` 会把 `undefined` 丢掉 ⇒ 线上"判不了"就是**缺字段**，
	// 这正是客户端必须把"缺字段"和 `undefined` 都当兜底的原因（两边各有一条断言守着）。
	assert.equal('attached' in body, false, 'JSON 里不该有这个键');
	assert.equal(body.attached, undefined);
});

// 收尾：把占位子进程全部清掉（前面的用例失败也不留进程），杀不掉的必须显式报告。
for (const child of holders) await killHolder(child);
if (leakedHolders.length > 0) {
	failed += 1;
	console.log(`  FAIL 占位子进程未清干净，pid=${leakedHolders.join(', ')}`);
}

console.log(`\n${passed}/${passed + failed} passed`);
// M1：清掉本次运行创建的所有临时目录，不留 %TEMP% 垃圾。
await Promise.all(createdRoots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
if (failed > 0) process.exit(1);
