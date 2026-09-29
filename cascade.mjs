/**
 * 「级联删除」核心模块：从一个会话的日志里**精确**找出它派生的子代理会话 id。
 *
 * 设计约束（都来自本工作区实测，改动前先读这一节）：
 *
 * 1. **只读、纯函数**：本模块不删任何东西、不写盘、不改全局状态，只读调用方给的日志文件。
 *    返回结构化结果，由调用方决定"要不要级联、级联失败怎么办"。
 *
 * 2. **多帧 zstd**：`session.v4.jsonl.zstd` 是**多帧 zstd 拼接**，不是单个 zstd 流。
 *    `zlib.zstdDecompressSync(整个文件)` 只解出**第一帧**（实测一个 3.9MB 文件只解出 193 字节，
 *    而正确解得 1174 帧 / 1250 万字符）⇒ 必须先手工解析出每帧边界，再逐帧解。
 *    帧边界算法**复刻自** `tools\session-repair\zstd.js` 的 `frameLengths()`
 *    （算法来源：`D:\DSH\Day1\tools\session-repair\zstd.js`，已逐帧对齐验证）。
 *    这里**故意不 import 那个文件**：本插件是按**绝对路径**加载的、以后可能被搬走，
 *    不能让插件模块依赖工作区里的路径。所以那 45 行原样内联在本文件里。
 *
 * 3. **继承事件必须排除**（本模块最关键的正确性要求）：fork/继承会话会把父会话的事件历史
 *    **复制进自己的日志**，里面有不属于它的 `subagent/catalog` 事件。不排除的话，删一个 fork
 *    会把**原会话真正派生的子会话**一起删掉（数据丢失）。判据（两条都要满足）：
 *      `seq > identity.inheritedEventCount` **且** `data.childCreatedAt >= identity.createdAt`。
 *
 * 4. **"无法判定" ≠ "空数组"**：identity 取不到（缺文件/解析失败/字段缺失/形态不对）时返回
 *    `ok: false`，调用方据此**放弃级联** —— 宁可少删（留孤儿），绝不 over-delete。
 *    `inheritedEventCount === 0` 是**合法值**，不是缺失。
 *
 * 5. **资源上限**：压缩文件 > 64 MiB 直接拒（不读进内存）；children 最多 500 个（超出置
 *    `truncated: true` 并提前停止扫描）。逐帧扫描，**绝不**把整个解压文本拼成一个大字符串。
 *
 * @module
 */
import { readFileSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

import { isValidSessionId } from './core.mjs';

/** 单次调用最多返回多少个子会话 id；超出部分丢弃并把 `truncated` 置 true。 */
export const MAX_CHILDREN = 500;

/** 压缩日志的字节上限（64 MiB）；超过直接返回 ok:false，不读进内存。 */
export const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;

/** zstd 帧 magic number（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 逐帧解析 zstd 帧边界（只看帧头与 block 头，不解压）。
 *
 * **算法来源：`D:\DSH\Day1\tools\session-repair\zstd.js` 的 `frameLengths()`，已逐帧对齐验证。**
 * 原样复刻的第二个原因见文件头第 2 条：插件按绝对路径加载，不能依赖工作区里的相对/绝对路径。
 *
 * @param buf - 整个文件的字节。
 * @returns `[{ start, len, frameContentSize, windowDescriptor }]`，按出现顺序。
 * @throws {Error} 坏 magic / block 头截断 / 帧越界 —— 一律表示"帧边界解析失败"，
 *   调用方必须把它当成 `ok:false`（**不能**当成"没有子会话"）。
 */
export function frameLengths(buf) {
	const lens = [];
	let pos = 0;
	while (pos < buf.length) {
		if (buf.length - pos < 4 || !buf.subarray(pos, pos + 4).equals(ZSTD_MAGIC)) {
			throw new Error(`bad magic at ${pos}`);
		}
		const start = pos;
		let p = pos + 4;
		const fhd = buf[p++];
		const fcsFlag = fhd >> 6;
		const singleSegment = (fhd >> 5) & 1;
		const checksum = (fhd >> 2) & 1;
		const didFlag = fhd & 3;
		let windowDescriptor = null;
		if (!singleSegment) windowDescriptor = buf[p++];
		const didSize = [0, 1, 2, 4][didFlag];
		p += didSize;
		// FCS_Field_Size: flag 0 means 1 byte only in single-segment mode; otherwise 1 << flag.
		const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : 1 << fcsFlag;
		const fcsBytes = buf.subarray(p, p + fcsSize);
		p += fcsSize;
		let frameContentSize = null;
		if (fcsSize === 1) frameContentSize = fcsBytes[0];
		else if (fcsSize === 2) frameContentSize = fcsBytes.readUInt16LE(0) + 256;
		else if (fcsSize === 4) frameContentSize = fcsBytes.readUInt32LE(0);
		else if (fcsSize === 8) frameContentSize = Number(fcsBytes.readBigUInt64LE(0));
		// blocks
		for (;;) {
			if (buf.length - p < 3) throw new Error(`truncated block header at ${p}`);
			const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
			p += 3;
			const last = h & 1;
			const type = (h >> 1) & 3;
			const size = h >> 3;
			if (type === 0 || type === 2) p += size;
			else if (type === 1) p += 1;
			else throw new Error(`reserved block type at ${p - 3}`);
			if (last) break;
		}
		if (checksum) p += 4;
		if (p <= start || p > buf.length) throw new Error(`frame overruns at ${start}`);
		lens.push({ start, len: p - start, frameContentSize, windowDescriptor });
		pos = p;
	}
	return lens;
}

/** `{}` 形态的失败结果。所有 `ok:false` 都带 `children: []`，调用方不可能误当成"没有子会话"。 */
function fail(reason, detail) {
	return detail === undefined ? { ok: false, reason, children: [] } : { ok: false, reason, detail: String(detail), children: [] };
}

/**
 * 校验 identity 形态。**只有两个字段都合法才算判定得了**；`inheritedEventCount === 0` 合法。
 * @returns 规范化后的 `{ createdAt, inheritedEventCount }`，或 `undefined`（= 无法判定）。
 */
function normalizeIdentity(identity) {
	if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) return undefined;
	const { createdAt, inheritedEventCount } = identity;
	if (!Number.isFinite(createdAt)) return undefined;
	if (!Number.isInteger(inheritedEventCount) || inheritedEventCount < 0) return undefined;
	return { createdAt, inheritedEventCount };
}

/**
 * 从一个会话日志里收集它**自己派生**的子会话 id。
 *
 * 同步、只读、无副作用；**永不抛**（所有异常都被转成结构化结果）。
 *
 * @param input - `{ logFilePath, identity }`：
 *   - `logFilePath` —— 会话日志文件（`session.v4.jsonl.zstd`）的绝对路径；必须是非空字符串。
 *   - `identity` —— `{ createdAt, inheritedEventCount } | null`，来自投影缓存
 *     `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 的 `record.identity`。
 *     取不到就传 `null`（或缺失字段的对象）—— 那会得到 `ok:false`，这是**有意的**。
 * @returns `ok:true` 时：
 *   - `children` —— 子会话 id 数组，**按日志出现顺序**、已去重、每个都过了 `isValidSessionId`，
 *     最多 `MAX_CHILDREN` 个。
 *   - `scannedFrames` —— **成功解压并扫描**的帧数。
 *   - `frameCount` —— 帧表解析出的总帧数。**未触发 `truncated` 时**
 *     `scannedFrames + frameErrors.length` 恒等于它；命中上限后提前停扫，剩余帧既不解压也不计数。
 *   - `frameErrors` —— 逐帧解压失败的帧 `[{ index, message }]`；**不导致整体失败**。
 *   - `lineParseErrors` —— 含 `subagent/catalog` 字样但 JSON.parse 不了的行数。
 *   - `catalogEvents` —— 顶层 `type === "subagent/catalog"` 的事件总数。
 *   - `excludedInherited` —— 被"本会话自己的子"判据排除掉的事件数（继承来的 / 时间早于本会话的）。
 *   - `unjudgedEvents` —— `seq` 或 `data.childCreatedAt` 不是有限数 ⇒ 无法判定，
 *     **按"不是自己的"排除**（宁可少删）。
 *   - `droppedInvalidIds` / `droppedDuplicates` —— 未过 `isValidSessionId` / 重复的 childId 数。
 *   - `truncated` —— 因命中 `MAX_CHILDREN` 上限而提前停止扫描（结果**不完整**）。
 *   或 `ok:false` 时：`{ ok:false, reason, children: [] }`（可能带 `detail`）。`reason` ∈
 *   `IDENTITY_UNAVAILABLE` / `INVALID_LOG_PATH` / `LOG_NOT_FOUND` / `LOG_UNREADABLE` /
 *   `LOG_TOO_LARGE` / `EMPTY_LOG` / `FRAME_PARSE_FAILED`。
 *   **`ok:false` 只表示"无法判定"**，调用方必须据此**放弃级联**，绝不能当成空结果继续。
 */
export function collectChildSessionIds(input) {
	// `input ?? {}`：解构默认值只对 `undefined` 生效，`null` 会直接抛 TypeError ——
	// 而本函数承诺"永不抛"，所以 `null` 必须显式兜住（它会被判成 IDENTITY_UNAVAILABLE）。
	const { logFilePath, identity } = input ?? {};

	// ── 1) identity 先行：拿不到就**不读盘**，直接"无法判定"。 ──────────────────
	const own = normalizeIdentity(identity);
	if (own === undefined) return fail('IDENTITY_UNAVAILABLE');

	// ── 2) 路径与大小门控（先 stat 再读，避免把超大文件读进内存）。 ──────────────
	if (typeof logFilePath !== 'string' || logFilePath.length === 0) return fail('INVALID_LOG_PATH');
	let size;
	try {
		const info = statSync(logFilePath);
		if (!info.isFile()) return fail('LOG_NOT_FOUND', 'not a regular file');
		size = info.size;
	} catch (error) {
		return fail(error?.code === 'ENOENT' ? 'LOG_NOT_FOUND' : 'LOG_UNREADABLE', error?.message ?? error);
	}
	if (size === 0) return fail('EMPTY_LOG', '0 字节日志里不可能有事件，按"无法判定"处理');
	if (size > MAX_COMPRESSED_BYTES) {
		return fail('LOG_TOO_LARGE', `${size} > ${MAX_COMPRESSED_BYTES}`);
	}
	let buffer;
	try {
		buffer = readFileSync(logFilePath);
	} catch (error) {
		return fail('LOG_UNREADABLE', error?.message ?? error);
	}

	// ── 3) 帧边界：**只有**这一步失败才算整体失败（坏 magic / 截断）。 ────────────
	let frames;
	try {
		frames = frameLengths(buffer);
	} catch (error) {
		return fail('FRAME_PARSE_FAILED', error?.message ?? error);
	}
	if (frames.length === 0) return fail('EMPTY_LOG', '帧表为空');

	// ── 4) 逐帧解压 + 逐行扫描（绝不拼成一个大字符串）。 ────────────────────────
	const children = [];
	const seen = new Set();
	const frameErrors = [];
	let scannedFrames = 0;
	let lineParseErrors = 0;
	let catalogEvents = 0;
	let excludedInherited = 0;
	let unjudgedEvents = 0;
	let droppedInvalidIds = 0;
	let droppedDuplicates = 0;
	let truncated = false;
	/** 上一帧末尾那个**没有换行符**的残行 —— 一行可能被切在两帧之间。 */
	let carry = '';
	/** 命中上限后立刻停止扫描（剩余帧不再解压），靠 `stop` 逐层退出。 */
	let stop = false;

	/** 处理一整行。返回 false 表示已命中上限、要停止扫描。 */
	const handleLine = (line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return true;
		// 便宜的预筛：真实 DSH 用 JSON.stringify 写盘，`/` 不会被转义，所以原文里一定有这个子串。
		// （万一将来被写成 `subagent\/catalog`，这里会漏掉 ⇒ 少删一个子会话，属安全方向。）
		if (!trimmed.includes('subagent/catalog')) return true;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			lineParseErrors += 1;
			return true;
		}
		// **顶层** type 必须精确相等：消息正文里出现同样的字样、或 data 里嵌了一个 catalog 形状的对象，
		// 都不是本会话的目录事件。
		if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'subagent/catalog') return true;
		catalogEvents += 1;
		const data = parsed.data;
		const childId = data?.childId;
		if (!isValidSessionId(childId)) {
			droppedInvalidIds += 1;
			return true;
		}
		const { seq } = parsed;
		const childCreatedAt = data?.childCreatedAt;
		// 单条事件判不了（缺字段/类型不对）：沿用"无法判定 ⇒ 排除"，但要记账。
		if (!Number.isFinite(seq) || !Number.isFinite(childCreatedAt)) {
			unjudgedEvents += 1;
			return true;
		}
		// 两条判据**都要**满足：seq 在继承范围之外，且子会话创建时间不早于本会话创建时间。
		if (!(seq > own.inheritedEventCount && childCreatedAt >= own.createdAt)) {
			excludedInherited += 1;
			return true;
		}
		if (seen.has(childId)) {
			droppedDuplicates += 1;
			return true;
		}
		seen.add(childId);
		children.push(childId);
		if (children.length > MAX_CHILDREN) {
			children.length = MAX_CHILDREN;
			truncated = true;
			return false;
		}
		return true;
	};

	for (let i = 0; i < frames.length && !stop; i += 1) {
		const frame = frames[i];
		let text;
		try {
			text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.start + frame.len)).toString('utf8');
		} catch (error) {
			// 单帧解压失败**不整体失败**：记一笔、继续。残行必须丢掉 —— 它的后半截已经没了，
			// 留着会与下一帧的开头拼成一条假行。
			frameErrors.push({ index: i, message: String(error?.message ?? error) });
			carry = '';
			continue;
		}
		scannedFrames += 1;
		const combined = carry + text;
		const lastNewline = combined.lastIndexOf('\n');
		if (lastNewline === -1) {
			carry = combined; // 整帧都在半行里
			continue;
		}
		carry = combined.slice(lastNewline + 1);
		const complete = combined.slice(0, lastNewline);
		for (const line of complete.split('\n')) {
			if (!handleLine(line)) {
				stop = true;
				break;
			}
		}
	}
	// 收尾：最后一行可能没有换行符，也要处理（真丢了这条就是漏一个子会话）。
	if (!stop && carry.length > 0) handleLine(carry);

	return {
		ok: true,
		children,
		scannedFrames,
		frameCount: frames.length,
		frameErrors,
		lineParseErrors,
		catalogEvents,
		excludedInherited,
		unjudgedEvents,
		droppedInvalidIds,
		droppedDuplicates,
		truncated
	};
}
