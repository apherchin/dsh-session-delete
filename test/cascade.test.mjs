/**
 * 级联删除核心模块的离线单测。
 *
 * 跑法：`node test/cascade.test.mjs`（在**任意 cwd** 下都能跑 —— 路径全靠 import.meta / tmpdir 派生）。
 * 风格照抄同目录 host-smoke.test.mjs：`test(label, fn)` 逐条跑、失败也继续、最后汇总 + `process.exit(1)`。
 *
 * fixture 用 `zlib.zstdCompressSync` **逐帧压缩再拼接**，与真实 `session.v4.jsonl.zstd`（多帧 zstd 拼接）同构。
 * 最后一组用例直接打本机真实文件（DSH_HOME 下的 projcache identity + sessions 日志），
 * 用来证明"实现不是只对自己的 fixture 有效"。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat, readdir, truncate } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import zlib from 'node:zlib';
import path from 'node:path';

import { collectChildSessionIds, frameLengths, MAX_CHILDREN, MAX_COMPRESSED_BYTES } from '../cascade.mjs';

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

/** 本次运行创建过的所有临时目录，收尾统一删除。 */
const createdRoots = [];

/** 稳定的假会话 id（过 SESSION_ID_PATTERN：字母数字开头、只含 [A-Za-z0-9._-]）。 */
function uuid(n) {
	return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** 造一条 {@link https://…} 形状正确的 subagent/catalog 事件。 */
function catalog({ seq, childId, childCreatedAt, mode = 'one-shot' }) {
	return {
		type: 'subagent/catalog',
		seq,
		time: childCreatedAt,
		data: { version: 0, childId, childCreatedAt, mode, label: `child ${childId}` }
	};
}

/**
 * 把事件序列压成**多帧** zstd 拼接（默认一行一帧，`perFrame` 可改）。
 * 数组元素可以是对象（会被 JSON.stringify）或原始字符串（原样写入，用于造坏行）。
 */
function encodeMultiFrame(events, { perFrame = 1 } = {}) {
	const lines = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)) + '\n');
	const frames = [];
	for (let i = 0; i < lines.length; i += perFrame) {
		frames.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + perFrame).join(''), 'utf8')));
	}
	return Buffer.concat(frames);
}

/** 造一个只含给定字节的临时日志文件，返回其绝对路径。 */
async function makeLogFile(buffer) {
	const root = await mkdtemp(path.join(tmpdir(), 'cascade-'));
	createdRoots.push(root);
	const file = path.join(root, 'session.v4.jsonl.zstd');
	await writeFile(file, buffer);
	return file;
}

/**
 * 手工造一个**帧边界合法、但压缩块内容非法**的帧：
 *  - 头：magic + FHD(0x20 = singleSegment=1, fcsFlag=0) + FCS(1 字节 = 64)；
 *  - 块：h = last(1) | type(2=Compressed)<<1 | size(64)<<3 = 0x0205 → LE `05 02 00`；
 *  - 载荷：64 个 0xFF —— zstd 的 literals 段类型取低 2 位 = 0b11（保留值）⇒ 必抛解码错误。
 * 用它验证"单帧解压失败不整体失败"（帧边界仍解析得出来，所以不能算 FRAME_PARSE_FAILED）。
 */
function corruptFrame() {
	const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x40, 0x05, 0x02, 0x00]);
	return Buffer.concat([header, Buffer.alloc(64, 0xff)]);
}

/** 真实文件校验用的两个根（全部从 DSH_HOME 派生，缺文件就 skip，不写死绝对路径猜）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh');
const REAL_SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const REAL_PROJ_CACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

/** 从真实投影缓存里读 `record.identity`（只取本模块要用的两个字段）。 */
async function realIdentity(sessionId) {
	try {
		const raw = await readFileUtf8(path.join(REAL_PROJ_CACHE_DIR, `${sessionId}.json`));
		const identity = JSON.parse(raw)?.record?.identity;
		if (identity === undefined || identity === null) return undefined;
		return { createdAt: identity.createdAt, inheritedEventCount: identity.inheritedEventCount };
	} catch {
		return undefined;
	}
}

/** 真实会话日志文件：在 sessions\<任一项目>\<id>\ 下找 session.v4.jsonl.zst*。 */
async function realLogFile(sessionId) {
	let projects;
	try {
		projects = await readdir(REAL_SESSIONS_ROOT, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = path.join(REAL_SESSIONS_ROOT, project.name, sessionId);
		let entries;
		try {
			entries = await readdir(dir);
		} catch {
			continue;
		}
		const hit = entries.find((name) => name.startsWith('session.v4.jsonl.zst'));
		if (hit !== undefined) return path.join(dir, hit);
	}
	return undefined;
}

/** fs/promises 的 readFile 局部包装，避免顶部再 import 一个名字。 */
async function readFileUtf8(file) {
	const { readFile } = await import('node:fs/promises');
	return await readFile(file, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== 第 1 组：正常路径 ==');

await test('3 个 catalog 事件（seq>0、childCreatedAt>=createdAt）→ 返回 3 个 id', async () => {
	const ids = [uuid(1), uuid(2), uuid(3)];
	const file = await makeLogFile(
		encodeMultiFrame([
			{ type: 'session/meta', seq: 0 },
			catalog({ seq: 1, childId: ids[0], childCreatedAt: 1000 }),
			{ type: 'message/part', seq: 2, data: { text: 'hi' } },
			catalog({ seq: 3, childId: ids[1], childCreatedAt: 1001 }),
			catalog({ seq: 4, childId: ids[2], childCreatedAt: 1002 })
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, ids);
	assert.equal(result.truncated, false);
	assert.equal(result.catalogEvents, 3);
	assert.equal(result.excludedInherited, 0);
});

await test('顺序按日志出现顺序、重复 childId 只留第一次', async () => {
	const a = uuid(11);
	const b = uuid(12);
	const c = uuid(13);
	const file = await makeLogFile(
		encodeMultiFrame([
			catalog({ seq: 1, childId: a, childCreatedAt: 1000 }),
			catalog({ seq: 2, childId: b, childCreatedAt: 1000 }),
			catalog({ seq: 3, childId: a, childCreatedAt: 1000 }),
			catalog({ seq: 4, childId: c, childCreatedAt: 1000 }),
			catalog({ seq: 5, childId: b, childCreatedAt: 1000 })
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.children, [a, b, c]);
	assert.equal(result.droppedDuplicates, 2);
});

await test('非法 childId 被丢弃（不出现、也不计入 children）', async () => {
	const good = uuid(21);
	const file = await makeLogFile(
		encodeMultiFrame([
			catalog({ seq: 1, childId: '../evil', childCreatedAt: 1000 }),
			catalog({ seq: 2, childId: good, childCreatedAt: 1000 }),
			catalog({ seq: 3, childId: '', childCreatedAt: 1000 }),
			catalog({ seq: 4, childId: 42, childCreatedAt: 1000 }),
			catalog({ seq: 5, childId: 'a/b', childCreatedAt: 1000 })
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.children, [good]);
	assert.equal(result.droppedInvalidIds, 4);
});

await test('一行一帧 vs 多行一帧，结果一致（帧切分不影响结论）', async () => {
	const ids = [uuid(31), uuid(32), uuid(33)];
	const events = ids.map((id, i) => catalog({ seq: i + 1, childId: id, childCreatedAt: 1000 }));
	const one = await makeLogFile(encodeMultiFrame(events, { perFrame: 1 }));
	const all = await makeLogFile(encodeMultiFrame(events, { perFrame: 99 }));
	const identity = { createdAt: 1000, inheritedEventCount: 0 };
	assert.deepEqual(collectChildSessionIds({ logFilePath: one, identity }).children, ids);
	assert.deepEqual(collectChildSessionIds({ logFilePath: all, identity }).children, ids);
	assert.equal(frameLengths(await readBuf(all)).length, 1);
	assert.equal(frameLengths(await readBuf(one)).length, 3);
});

await test('一行被拆到两帧里（跨帧断行）也能被认出', async () => {
	// 手写：把一条 catalog 事件的 JSON 从中间切开，前半帧 + 后半帧。
	const a = uuid(41);
	const b = uuid(42);
	const textA = JSON.stringify(catalog({ seq: 1, childId: a, childCreatedAt: 1000 })) + '\n';
	const textB = JSON.stringify(catalog({ seq: 2, childId: b, childCreatedAt: 1000 })) + '\n';
	const cut = 30; // 落在第一条事件内部
	const frame1 = zlib.zstdCompressSync(Buffer.from(textA.slice(0, cut), 'utf8'));
	const frame2 = zlib.zstdCompressSync(Buffer.from(textA.slice(cut) + textB, 'utf8'));
	const file = await makeLogFile(Buffer.concat([frame1, frame2]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [a, b]);
});

await test('末行没有换行符也能收（收尾的残留行必须被处理）', async () => {
	const a = uuid(51);
	// 整条事件**不带**结尾换行 —— 真实文件的最后一行也可能没有 \n
	const file = await makeLogFile(
		zlib.zstdCompressSync(Buffer.from(JSON.stringify(catalog({ seq: 1, childId: a, childCreatedAt: 1000 })), 'utf8'))
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [a]);
});

await test('只读、不改文件、可重复调用（纯函数）', async () => {
	const a = uuid(61);
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: a, childCreatedAt: 1000 })]));
	const before = await stat(file);
	const first = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	const second = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	const after = await stat(file);
	assert.deepEqual(first, second);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 2 组：fork / 继承事件必须被排除（最关键） ==');

await test('fork 场景：14 条 catalog 全部被排除，返回 0 个，且 14 个 id 一个都不出现', async () => {
	const createdAt = 2_000_000;
	const inheritedEventCount = 1272;
	const inheritedIds = [];
	const events = [];
	// 10 条：seq 继承 + 时间早于本会话 ⇒ 两条判据都判"不是自己的"
	for (let i = 0; i < 10; i += 1) {
		inheritedIds.push(uuid(100 + i));
		events.push(catalog({ seq: 100 + i, childId: uuid(100 + i), childCreatedAt: createdAt - 1000 }));
	}
	// 2 条：seq 在继承范围之外，但时间早于本会话 ⇒ 只看 seq 会误收
	for (let i = 0; i < 2; i += 1) {
		inheritedIds.push(uuid(200 + i));
		events.push(catalog({ seq: 5000 + i, childId: uuid(200 + i), childCreatedAt: createdAt - 1 }));
	}
	// 2 条：时间不早于本会话，但 seq 落在继承范围里 ⇒ 只看时间会误收
	for (let i = 0; i < 2; i += 1) {
		inheritedIds.push(uuid(300 + i));
		events.push(catalog({ seq: 10 + i, childId: uuid(300 + i), childCreatedAt: createdAt + 1000 }));
	}
	const file = await makeLogFile(encodeMultiFrame(events));

	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt, inheritedEventCount } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, []);
	assert.equal(result.excludedInherited, 14);
	assert.equal(result.catalogEvents, 14);
	for (const id of inheritedIds) {
		assert.equal(result.children.includes(id), false, `继承来的 childId 泄漏进了结果：${id}`);
	}
});

await test('非 fork 会话（inheritedEventCount=0）里同样的 14 条会被全部收下', async () => {
	// 与上一条形成对照：同一批事件、只有 identity 不同 ⇒ 排除逻辑真的在看 identity，而不是别的东西。
	const createdAt = 2_000_000;
	const events = [];
	for (let i = 0; i < 10; i += 1) events.push(catalog({ seq: 100 + i, childId: uuid(100 + i), childCreatedAt: createdAt - 1000 }));
	const file = await makeLogFile(encodeMultiFrame(events));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1_000_000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true);
	assert.equal(result.children.length, 10);
	assert.equal(result.excludedInherited, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 3 组：混合场景（继承 + 自己的） ==');

await test('只返回 seq>inheritedEventCount 且 childCreatedAt>=createdAt 的那些', async () => {
	const inheritedEventCount = 100;
	const createdAt = 5000;
	const mine1 = uuid(401);
	const mine2 = uuid(402);
	const file = await makeLogFile(
		encodeMultiFrame([
			catalog({ seq: 50, childId: uuid(410), childCreatedAt: 6000 }), // 继承（seq 不够）
			catalog({ seq: 101, childId: mine1, childCreatedAt: 6000 }), // 自己的
			catalog({ seq: 100, childId: uuid(411), childCreatedAt: 6000 }), // seq === 边界 → 不是自己的
			catalog({ seq: 150, childId: uuid(412), childCreatedAt: 4999 }), // 时间早于本会话 → 不是自己的
			catalog({ seq: 151, childId: mine2, childCreatedAt: 5000 }) // 时间相等（闭区间）→ 自己的
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt, inheritedEventCount } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.children, [mine1, mine2]);
	assert.equal(result.excludedInherited, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 4 组：边界 ==');

await test('seq === inheritedEventCount 不算自己的', async () => {
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 100, childId: uuid(501), childCreatedAt: 9999 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1, inheritedEventCount: 100 } });
	assert.equal(result.ok, true);
	assert.deepEqual(result.children, []);
	assert.equal(result.excludedInherited, 1);
});

await test('seq === inheritedEventCount + 1 算自己的', async () => {
	const id = uuid(502);
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 101, childId: id, childCreatedAt: 9999 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1, inheritedEventCount: 100 } });
	assert.deepEqual(result.children, [id]);
});

await test('childCreatedAt === createdAt 算自己的（闭区间）', async () => {
	const id = uuid(503);
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: id, childCreatedAt: 4242 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 4242, inheritedEventCount: 0 } });
	assert.deepEqual(result.children, [id]);
});

await test('childCreatedAt === createdAt - 1 不算自己的', async () => {
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: uuid(504), childCreatedAt: 4241 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 4242, inheritedEventCount: 0 } });
	assert.deepEqual(result.children, []);
	assert.equal(result.excludedInherited, 1);
});

await test('inheritedEventCount === 0 是合法值，不是"缺失"', async () => {
	const id = uuid(505);
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: id, childCreatedAt: 100 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 100, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [id]);
});

await test('inheritedEventCount 极大时（比所有 seq 都大）一个都不收', async () => {
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 999_999, childId: uuid(506), childCreatedAt: 9_999_999 })]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1, inheritedEventCount: 1_000_000 } });
	assert.deepEqual(result.children, []);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 5 组：identity 缺失 / 形态不对 → 必须"无法判定"，绝不是空数组成功 ==');

const badIdentities = [
	['null', null],
	['undefined', undefined],
	['缺省（不传该键）', undefined],
	['空对象', {}],
	['缺 inheritedEventCount', { createdAt: 123 }],
	['缺 createdAt', { inheritedEventCount: 0 }],
	['createdAt 是字符串', { createdAt: '123', inheritedEventCount: 0 }],
	['createdAt 是 NaN', { createdAt: Number.NaN, inheritedEventCount: 0 }],
	['createdAt 是 Infinity', { createdAt: Number.POSITIVE_INFINITY, inheritedEventCount: 0 }],
	['inheritedEventCount 是字符串 "0"', { createdAt: 123, inheritedEventCount: '0' }],
	['inheritedEventCount 是负数', { createdAt: 123, inheritedEventCount: -1 }],
	['inheritedEventCount 是小数', { createdAt: 123, inheritedEventCount: 1.5 }],
	['inheritedEventCount 是 NaN', { createdAt: 123, inheritedEventCount: Number.NaN }],
	['identity 是字符串', 'nope'],
	['identity 是数字', 7]
];

for (const [label, identity] of badIdentities) {
	await test(`identity ${label} → ok:false（不是空数组成功）`, async () => {
		const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: uuid(601), childCreatedAt: 1000 })]));
		const result = collectChildSessionIds({ logFilePath: file, identity });
		assert.equal(result.ok, false, `居然返回了 ok:true：${JSON.stringify(result)}`);
		assert.equal(typeof result.reason, 'string');
		assert.ok(result.reason.length > 0);
		assert.deepEqual(result.children, []);
	});
}

await test('identity 缺失时压根不读盘（日志路径不存在也照样只报 identity 问题）', () => {
	const result = collectChildSessionIds({ logFilePath: 'Z:\\definitely\\missing.zstd', identity: null });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'IDENTITY_UNAVAILABLE');
	assert.deepEqual(result.children, []);
});

await test('logFilePath 非字符串 / 空串 → ok:false', () => {
	for (const bad of [undefined, null, 42, '', {}]) {
		const result = collectChildSessionIds({ logFilePath: bad, identity: { createdAt: 1, inheritedEventCount: 0 } });
		assert.equal(result.ok, false, `logFilePath=${JSON.stringify(bad)} 居然通过了`);
		assert.deepEqual(result.children, []);
	}
});

await test('整个入参为 null / undefined / 缺省 → ok:false，不抛（解构默认值对 null 不生效）', () => {
	for (const bad of [null, undefined]) {
		const result = collectChildSessionIds(bad);
		assert.equal(result.ok, false, `入参 ${bad} 居然通过了`);
		assert.equal(result.reason, 'IDENTITY_UNAVAILABLE');
		assert.deepEqual(result.children, []);
	}
	const noArg = collectChildSessionIds();
	assert.equal(noArg.ok, false);
	assert.equal(noArg.reason, 'IDENTITY_UNAVAILABLE');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 6 组：坏文件 / 资源上限 ==');

await test('非 zstd 内容 → ok:false，不抛', async () => {
	const file = await makeLogFile(Buffer.from('{"type":"subagent/catalog"}\nthis is not zstd at all\n', 'utf8'));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'FRAME_PARSE_FAILED');
	assert.deepEqual(result.children, []);
});

await test('帧中途被截断 → ok:false（帧边界解析失败）', async () => {
	const full = encodeMultiFrame([catalog({ seq: 1, childId: uuid(701), childCreatedAt: 1000 })]);
	const file = await makeLogFile(full.subarray(0, full.length - 2));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'FRAME_PARSE_FAILED');
});

await test('合法帧 + 被截断的后续帧 → ok:false（不因为第一帧好就当成成功）', async () => {
	const good = zlib.zstdCompressSync(Buffer.from(JSON.stringify(catalog({ seq: 1, childId: uuid(702), childCreatedAt: 1000 })) + '\n', 'utf8'));
	const bad = encodeMultiFrame([{ type: 'x' }]);
	assert.ok(bad.length > 2);
	const file = await makeLogFile(Buffer.concat([good, bad.subarray(0, bad.length - 2)]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'FRAME_PARSE_FAILED');
});

await test('文件不存在 → ok:false，不抛', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'cascade-miss-'));
	createdRoots.push(root);
	const result = collectChildSessionIds({
		logFilePath: path.join(root, 'nope', 'session.v4.jsonl.zstd'),
		identity: { createdAt: 0, inheritedEventCount: 0 }
	});
	assert.equal(result.ok, false);
	assert.deepEqual(result.children, []);
});

await test('路径是目录 → ok:false，不抛', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'cascade-dir-'));
	createdRoots.push(root);
	const result = collectChildSessionIds({ logFilePath: root, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.deepEqual(result.children, []);
});

await test('空文件（0 字节）→ ok:false（"没有事件"与"读不到"不作等同）', async () => {
	const file = await makeLogFile(Buffer.alloc(0));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.deepEqual(result.children, []);
});

await test(`超过 ${MAX_COMPRESSED_BYTES} 字节 → ok:false / LOG_TOO_LARGE，且不尝试读取`, async () => {
	const file = await makeLogFile(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
	await truncate(file, MAX_COMPRESSED_BYTES + 1); // 稀疏扩展，不真写 64MB
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, false);
	assert.equal(result.reason, 'LOG_TOO_LARGE');
	assert.deepEqual(result.children, []);
});

await test(`上限判据是 ">" 而非 ">="（常量 = 64 MiB），且正常小文件不被误伤`, async () => {
	assert.equal(MAX_COMPRESSED_BYTES, 64 * 1024 * 1024);
	const file = await makeLogFile(encodeMultiFrame([catalog({ seq: 1, childId: uuid(703), childCreatedAt: 1000 })]));
	const info = await stat(file);
	assert.ok(info.size < MAX_COMPRESSED_BYTES);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 0, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
});

await test('单帧解压失败不整体失败：好帧照收，坏帧只记账', async () => {
	const goodId = uuid(711);
	const laterId = uuid(712);
	const frame1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(catalog({ seq: 1, childId: goodId, childCreatedAt: 1000 })) + '\n', 'utf8'));
	const frame3 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(catalog({ seq: 3, childId: laterId, childCreatedAt: 1000 })) + '\n', 'utf8'));
	const file = await makeLogFile(Buffer.concat([frame1, corruptFrame(), frame3]));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [goodId, laterId]);
	assert.equal(result.frameCount, 3);
	assert.equal(result.scannedFrames, 2);
	assert.equal(result.frameErrors.length, 1);
});

await test('坏行（不是 JSON）只记账，不影响其它行；不含关键字的行根本不进解析', async () => {
	const id = uuid(721);
	const file = await makeLogFile(
		encodeMultiFrame([
			'{"type":"subagent/catalog", broken', // 含关键字 + JSON 坏 → 记账 1
			'subagent/catalog 出现在这里但整行不是 JSON', // 含关键字 + 不是 JSON → 记账 2
			'not json at all', // 不含关键字 → 被预筛跳过，不记账（省 CPU 的有意取舍）
			'{"type":"other"}', // 合法 JSON，类型不对 → 静默跳过
			catalog({ seq: 1, childId: id, childCreatedAt: 1000 })
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [id]);
	assert.equal(result.lineParseErrors, 2);
	assert.equal(result.frameErrors.length, 0);
	assert.equal(result.scannedFrames + result.frameErrors.length, result.frameCount);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 7 组：干扰（正文里出现 "subagent/catalog" 字样但并不是该类型事件） ==');

await test('消息正文含 subagent/catalog 字样 → 不得被误收', async () => {
	const real = uuid(801);
	const file = await makeLogFile(
		encodeMultiFrame([
			{ type: 'message/part', seq: 1, data: { text: '我改的是 subagent/catalog 事件的解析逻辑' } },
			{ type: 'message/part', seq: 2, data: { text: JSON.stringify({ type: 'subagent/catalog', seq: 1, data: { childId: uuid(802), childCreatedAt: 9999 } }) } },
			{ type: 'tool/result', seq: 3, data: { name: 'subagent/catalog', childId: uuid(803), childCreatedAt: 9999 } },
			{ type: 'subagent/catalogXYZ', seq: 4, data: { childId: uuid(804), childCreatedAt: 9999 } },
			{ type: 'xsubagent/catalog', seq: 5, data: { childId: uuid(805), childCreatedAt: 9999 } },
			catalog({ seq: 6, childId: real, childCreatedAt: 9999 })
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, [real]);
	assert.equal(result.catalogEvents, 1);
});

await test('catalog 事件缺 childCreatedAt / seq → 按"无法判定"排除（宁可少删），且不整体失败', async () => {
	const file = await makeLogFile(
		encodeMultiFrame([
			{ type: 'subagent/catalog', seq: 5, data: { childId: uuid(811) } }, // 缺 childCreatedAt
			{ type: 'subagent/catalog', data: { childId: uuid(812), childCreatedAt: 9999 } }, // 缺 seq
			{ type: 'subagent/catalog', seq: '5', data: { childId: uuid(813), childCreatedAt: 9999 } }, // seq 不是数
			{ type: 'subagent/catalog', seq: 8, data: { childId: uuid(814), childCreatedAt: null } }
		])
	);
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.children, []);
	assert.equal(result.unjudgedEvents, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n== 第 8 组：上限 ${MAX_CHILDREN} ==`);

await test(`600 个 catalog 事件 → truncated:true 且返回恰好 ${MAX_CHILDREN} 个（取前 ${MAX_CHILDREN} 个）`, async () => {
	const events = [];
	for (let i = 0; i < 600; i += 1) events.push(catalog({ seq: i + 1, childId: uuid(1000 + i), childCreatedAt: 1000 }));
	const file = await makeLogFile(encodeMultiFrame(events));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.ok, true);
	assert.equal(result.truncated, true);
	assert.equal(result.children.length, MAX_CHILDREN);
	assert.equal(result.children[0], uuid(1000));
	assert.equal(result.children[MAX_CHILDREN - 1], uuid(1000 + MAX_CHILDREN - 1));
	// 有效 id 的集合必须无重复
	assert.equal(new Set(result.children).size, MAX_CHILDREN);
});

await test(`恰好 ${MAX_CHILDREN} 个（不超）→ truncated:false`, async () => {
	const events = [];
	for (let i = 0; i < MAX_CHILDREN; i += 1) events.push(catalog({ seq: i + 1, childId: uuid(2000 + i), childCreatedAt: 1000 }));
	const file = await makeLogFile(encodeMultiFrame(events));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.truncated, false);
	assert.equal(result.children.length, MAX_CHILDREN);
});

await test(`${MAX_CHILDREN + 1} 个 → truncated:true，返回 ${MAX_CHILDREN} 个`, async () => {
	const events = [];
	for (let i = 0; i < MAX_CHILDREN + 1; i += 1) events.push(catalog({ seq: i + 1, childId: uuid(3000 + i), childCreatedAt: 1000 }));
	const file = await makeLogFile(encodeMultiFrame(events));
	const result = collectChildSessionIds({ logFilePath: file, identity: { createdAt: 1000, inheritedEventCount: 0 } });
	assert.equal(result.truncated, true);
	assert.equal(result.children.length, MAX_CHILDREN);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== 第 9 组：真实文件校验（实现不是只对自己的 fixture 有效） ==');

/** 真实会话的期望值。`excludedInherited: undefined` = 不断言该字段。文件缺失则 skip（本机不该缺）。 */
async function realFileCase(label, sessionId, expected) {
	const log = await realLogFile(sessionId);
	const identity = await realIdentity(sessionId);
	if (log === undefined || identity === undefined) {
		console.log(`  skip ${label}（找不到真实日志或 identity）`);
		return;
	}
	await test(`${label}｜${sessionId}`, async () => {
		const started = Date.now();
		const result = collectChildSessionIds({ logFilePath: log, identity });
		const elapsed = Date.now() - started;
		const info = await stat(log);
		console.log(`       log=${log}`);
		console.log(`       ${info.size} B compressed, identity=${JSON.stringify(identity)}`);
		console.log(
			`       → ok=${result.ok} children=${result.children.length} frames=${result.scannedFrames}/${result.frameCount}` +
				` frameErrors=${result.frameErrors?.length ?? 'n/a'} catalogEvents=${result.catalogEvents}` +
				` excludedInherited=${result.excludedInherited} unjudged=${result.unjudgedEvents}` +
				` droppedInvalid=${result.droppedInvalidIds} truncated=${result.truncated} (${elapsed} ms)`
		);
		if (result.children.length > 0) console.log(`       ids: ${result.children.join(', ')}`);
		assert.equal(result.ok, true, JSON.stringify({ ok: result.ok, reason: result.reason }));
		// 不变式：帧数对得上
		assert.equal(result.scannedFrames + result.frameErrors.length, result.frameCount);
		if (expected.excludedInherited !== undefined) assert.equal(result.excludedInherited, expected.excludedInherited);
		if (expected.catalogEvents !== undefined) assert.equal(result.catalogEvents, expected.catalogEvents);
		assert.equal(result.truncated, false);
		if (expected.prefix !== undefined) {
			// ⚠️ 这个会话的日志**正在被写入**（它每派一个子代理就 append 一条 catalog 事件，
			// 而本次测试自己就是它的子代理之一），所以**总数不稳定**、不能硬断言。
			// 稳定的是**前缀**（JSONL 只追加，先出现的永远先出现）—— 用前缀钉住基线。
			assert.deepEqual(result.children.slice(0, expected.prefix.length), expected.prefix);
			const extra = result.children.slice(expected.prefix.length);
			console.log(
				`       baseline=${expected.prefix.length}（与任务书给的 29 对照）  live 之后新增=${extra.length}` +
					(extra.length > 0 ? `：${extra.join(', ')}` : '')
			);
			assert.ok(result.children.length >= expected.prefix.length);
		} else {
			assert.equal(result.children.length, expected.children);
		}
	});
}

/**
 * 任务书实测表里的 29 个（**顺序 = 日志出现顺序**）。
 * 这是**测之前**就存在的 29 条 —— 与父代理独立算出的 29 个对照用。
 */
const BASELINE_29 = [
	'8ff1ed94-a77d-42f4-9446-b7ac59f5f975',
	'5f8665bc-a58b-48d3-9ca6-0714a8aad363',
	'a049422e-560d-47ae-a295-8d4f443e59cb',
	'83d101c3-76fa-4772-bb40-0c8f7d6857c8',
	'bc91149f-55be-42da-b06e-90fc2c6cb027',
	'9758e490-0026-4927-b82f-502a83bee5bb',
	'911d9a09-4e9d-4e2d-880c-326c4e208657',
	'd043eb53-f927-4d86-97c8-a989d7998234',
	'dcf4ca0a-c478-4570-8871-1d763982e443',
	'0f9bab38-e406-44a3-8459-10ff6c4dc527',
	'80d16a7f-0d89-4f73-ba82-b8d3005aea15',
	'0884e1dc-78eb-414b-bcf2-fd721c8a6b47',
	'aea3beba-b9d8-454c-8a74-304505ccfcdb',
	'50ccbb02-7e7c-461f-af2b-6bda26c3d416',
	'019ef37e-b760-4e55-a257-17972de3aa0f',
	'6cee6f78-70af-47fd-8cdd-185ed011378f',
	'a599a6a7-c187-4f94-b909-69d43fef8fe2',
	'82d5225f-7b17-47e0-9c77-e96f430d7a34',
	'c89bf121-bb86-447b-9850-d22258170077',
	'e2755506-dfc0-44e3-b313-f0cda8341c79',
	'12b7f461-bc29-4e1b-ac96-2bd654da739b',
	'47c47304-5fac-4641-9a8b-b1941ca16cdb',
	'0f36fc00-e5b1-4858-bea3-3e91baa4c1dc',
	'90fa0502-2ca8-43a9-9e4c-3cbfc30e72d4',
	'4cb856a8-07ed-437a-b589-7d0693ec6855',
	'5430dbd3-9943-4c38-b25e-cb0eb0967074',
	'a52e5e8e-a1cb-4f5e-85c4-7183c6c3e545',
	'57940377-018f-49a1-8896-a345099682f6',
	'149c030d-57c4-4622-92c5-50745613e2b7'
];

// e2240a3b：任务书标注"无子" ⇒ 严格断言 0。
await realFileCase('无子会话', 'session-e2240a3b-7941-4190-8be5-765f35a8c842', { children: 0, catalogEvents: 0, excludedInherited: 0 });
// 9b09fa88：非 fork（inheritedEventCount=0）⇒ 判据一条都不排除；日志**活着**，故只钉前缀。
await realFileCase('29 个子会话（日志活着，钉前缀）', 'session-9b09fa88-4cb6-4692-8dbb-9ad4579ca5d5', {
	prefix: BASELINE_29,
	excludedInherited: 0
});
// 019ef37e：fork（inheritedEventCount=1272）⇒ 14 条 catalog 全被排除、两条判据都保留 0。
await realFileCase('fork 会话', '019ef37e-b760-4e55-a257-17972de3aa0f', { children: 0, catalogEvents: 14, excludedInherited: 14 });

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed}/${passed + failed} passed`);
await Promise.all(createdRoots.map((r) => rm(r, { recursive: true, force: true }).catch(() => {})));
if (failed > 0) process.exit(1);

/** 读回一个文件为 Buffer（供 frameLengths 直接校验）。 */
async function readBuf(file) {
	const { readFile } = await import('node:fs/promises');
	return await readFile(file);
}
