/**
 * session-delete —— 会话右键菜单「删除对话」的 host 半边。
 * 只做接线：路由、活体拒绝、**级联计划**、门控摘记账、广播。文件系统逻辑全在 core.mjs，
 * 「从日志里认出子会话」的逻辑全在 cascade.mjs（本文件**只 import，不改它们**）。
 *
 * Task 8 的两条铁律（改这里之前先读）：
 *  1. **顺序**：`identity` → 定位日志目录 → `collectChildSessionIds()` 全部发生在**任何删除之前**。
 *     子列表的唯一来源就是"待会要被删掉的那个日志"，先删就读不出来了（第 8.3 节有用例守着）。
 *  2. **fail-closed**：目标在 running ⇒ `SESSION_ACTIVE`；**任一子会话**在 running ⇒ `CHILDREN_ACTIVE`
 *     且一个字节都不删。`ok:false` 的级联（identity 缺 / 日志找不到 / 日志超限）一律**不级联**，
 *     但仍然照删目标，并在返回里带 `cascadeReason`（宁可少删，绝不 over-delete）。
 */
import os from "node:os";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { deleteSessionArtifacts, directoryBytes, isValidSessionId, locateSessionDirectory, readCachedTitle } from "./core.mjs";
import { MAX_CHILDREN, collectChildSessionIds } from "./cascade.mjs";

export const name = "session-delete";
// ⚠️ **绝对不要**把 `"sessions"` 加进这个数组：插件级 `inject` 是**硬门禁** —— 名字不被满足时
// `apply` 会**静默永不执行**（整块功能消失、零报错）。而 attached 探测必须"有则用、无则判不了"，
// 所以只能走 `Reflect.get(ctx, "sessions")` + try/catch（见 `attachedOf`），绝不进硬门禁。
export const inject = ["connection", "workspaceRegistry", "agents"];

/** 浏览器侧调用的同源路径。 */
export const SESSION_DELETE_PATH = "/api/session.delete";

/** DSH home：优先用环境变量，回退到 ~/.dsh。 */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".dsh");
}

/** sessions 根目录（与 dsh-base 的 `root: !!js dshHomePath('sessions')` 一致）。 */
export function sessionsRoot() {
	return path.join(dshHome(), "sessions");
}

/** 投影缓存**目录**——core 在其下自行派生 `<sessionId>.json`（调用方无法传任意路径）。 */
export function projectionCacheDir() {
	return path.join(dshHome(), "storages", "session_projcache", "sessions");
}

/** 读审计标题用的缓存文件路径（只读，不参与删除）。 */
export function projectionCacheFile(sessionId) {
	return path.join(projectionCacheDir(), `${sessionId}.json`);
}

//#region 级联计划的只读零件（Task 8）

/** 会话日志文件的后缀。**不写死文件名**：`session.v4.jsonl.zstd` → `session.v10.…` 都要认。 */
const SESSION_LOG_PATTERN = /\.jsonl\.zstd$/;

/** 从 `session.v4.jsonl.zstd` 里取出版本号 `4`；取不到记 0（排序时垫底）。 */
function logVersion(fileName) {
	const matched = /\.v(\d+)\./.exec(fileName);
	return matched === null ? 0 : Number(matched[1]);
}

/**
 * 在会话目录里挑出要读的日志文件。
 * 同一目录里若真有多个版本，取**版本号最大**的那个（同版本号再按名字倒序，保证确定性）——
 * 挑错方向的代价只是**少删**（漏掉一个子会话 ⇒ 留个孤儿），不会 over-delete。
 * 目录读不了、或一个都没匹配到 → `undefined`（调用方按"无法判定"处理 ⇒ 不级联）。
 */
async function findSessionLog(sessionDir) {
	let entries;
	try {
		entries = await readdir(sessionDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const logs = entries
		.filter((entry) => entry.isFile() && SESSION_LOG_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => logVersion(b) - logVersion(a) || (a < b ? 1 : a > b ? -1 : 0));
	return logs.length === 0 ? undefined : path.join(sessionDir, logs[0]);
}

/**
 * 读投影缓存里的 `record.identity` —— 级联判定的**唯一**输入。
 * 读不到（文件不存在 / 坏 JSON / 字段缺失 / 无权限）一律 `null`：`collectChildSessionIds`
 * 会把它判成 `IDENTITY_UNAVAILABLE` ⇒ **放弃级联**。这条兜底是"宁可少删"的实现方式，别放宽。
 */
async function readCachedIdentity(projectionCacheFile) {
	try {
		const raw = await readFile(projectionCacheFile, "utf8");
		const parsed = JSON.parse(raw);
		const identity = parsed?.record?.identity;
		return identity === undefined ? null : identity;
	} catch {
		return null;
	}
}

/** best-effort 量一个会话目录的字节数；量不到（含传 undefined）算 0，**绝不**因此让整体失败。 */
async function measureBytesTolerant(target) {
	if (typeof target !== "string") return 0;
	try {
		return await directoryBytes(target);
	} catch {
		return 0;
	}
}

/**
 * 读级联计划（**纯只读**，不删任何东西、不广播、不打日志）。
 *
 * ⚠️ 调用顺序是契约的一部分：本函数必须在**目标与子会话被删之前**调用，
 * 因为它要读的正是"待会要被删掉的那个日志"。
 *
 * @returns `{ cascade, cascadeReason?, children, skipped, running, sessionDir, truncated }`：
 *   - `cascade` —— **以"最终要不要级联"为准**（而不是"collect 有没有报 ok"）：
 *     `"ok"` 有可级联的子会话 / `"none"` 判定得了但**没有可级联的子会话**
 *     （真的没有，或所有候选都被第 2 层防御丢掉了——丢掉的仍在 `skipped` 里可见）/
 *     `"unavailable"` **无法判定**（identity 缺 / 日志找不到 / 日志超限 / 帧解析失败…）。
 *   - `children` —— 已过滤（丢掉目标自己与非法 id，并截到 `MAX_CHILDREN`）的候选子会话 id。
 *   - `skipped` —— 被第 2 层防御丢掉的条目 `{ id, reason }`（`cascade.mjs` 已挡过一遍，
 *     但调用方**不能**把"上游校验过了"当成自己的保证）。它们**不计入** `children`。
 *   - `running` —— 其中**正在运行**（`agent.status === "running"`）的子会话 id。
 */
async function readCascadePlan(ctx, { root, sessionId }) {
	const identity = await readCachedIdentity(projectionCacheFile(sessionId));
	let sessionDir;
	try {
		sessionDir = await locateSessionDirectory(root, sessionId);
	} catch {
		// 无法判定（ENOTDIR/EACCES…）：**不级联**，原因原样带出去（别伪装成"没有子会话"）。
		return { cascade: "unavailable", cascadeReason: "LOG_DIR_INDETERMINATE", children: [], skipped: [], running: [], sessionDir: undefined, truncated: false };
	}
	if (sessionDir === undefined) {
		return { cascade: "unavailable", cascadeReason: "LOG_DIR_NOT_FOUND", children: [], skipped: [], running: [], sessionDir: undefined, truncated: false };
	}
	const logFilePath = await findSessionLog(sessionDir);
	if (logFilePath === undefined) {
		return { cascade: "unavailable", cascadeReason: "LOG_FILE_NOT_FOUND", children: [], skipped: [], running: [], sessionDir, truncated: false };
	}
	// identity 缺 → cascade.mjs 直接给 ok:false（它连盘都不读），这里的顺序是有意的：
	// identity 先于读盘门控，拿不到就绝不开始读日志。
	const collected = collectChildSessionIds({ logFilePath, identity });
	if (collected.ok !== true) {
		return {
			cascade: "unavailable",
			cascadeReason: String(collected.reason ?? "UNKNOWN"),
			children: [],
			skipped: [],
			running: [],
			sessionDir,
			truncated: false
		};
	}

	// 第 2 层防御（纵深）：cascade.mjs 已经校验过 id 形状，这里**再防一层**并顺手丢掉"目标自己"。
	const children = [];
	const skipped = [];
	const seen = new Set();
	for (const rawId of collected.children ?? []) {
		if (!isValidSessionId(rawId)) {
			skipped.push({ id: String(rawId), reason: "INVALID_ID" });
			continue;
		}
		if (rawId === sessionId) {
			// 自我引用是合法形状，cascade.mjs 拦不住它 —— 若不是这里挡住，目标会被先当子会话删一遍。
			skipped.push({ id: rawId, reason: "SELF_REFERENCE" });
			continue;
		}
		if (seen.has(rawId)) {
			skipped.push({ id: rawId, reason: "DUPLICATE" });
			continue;
		}
		seen.add(rawId);
		children.push(rawId);
		if (children.length >= MAX_CHILDREN) break; // 上限（cascade.mjs 已截过一次，这里再兜一层）
	}

	// 子会话活体判定：与目标**同一判据**（只看 running，不看驻留）。
	const running = children.filter((childId) => ctx.agents.get(childId)?.status === "running");
	return {
		cascade: children.length === 0 ? "none" : "ok",
		cascadeReason: undefined,
		children,
		skipped,
		running,
		sessionDir,
		truncated: collected.truncated === true
	};
}

/**
 * 门控摘记账（归档 / 置顶）：**只有** `logDir ∈ {removed, absent}` 才摘。
 * 目标是"文件已删、记账没摘"只留一个惰性 id；反之"记账先摘而文件没删成"会让会话复活。
 * 目标与**子会话走同一个函数** —— 这样"子会话也走同一条路径"才是真的，而不是两段复制出来的代码。
 * @returns `{ cleared, failures }`，`failures` 每条形如 `{ step, message }`。
 */
async function clearSessionBookkeeping(ctx, sessionId, outcome) {
	const cleared = { archived: false, pinned: false };
	const failures = [];
	if (outcome.logDir !== "removed" && outcome.logDir !== "absent") return { cleared, failures };
	// 两者对"未归档/未置顶"的 id 都是 no-op，所以可以无条件调用。
	try {
		await ctx.workspaceRegistry.unarchiveSession(sessionId);
		cleared.archived = true;
	} catch (error) {
		failures.push({ step: "unarchiveSession", message: String(error?.message ?? error) });
	}
	try {
		await ctx.workspaceRegistry.unpinSession(sessionId);
		cleared.pinned = true;
	} catch (error) {
		failures.push({ step: "unpinSession", message: String(error?.message ?? error) });
	}
	return { cleared, failures };
}

//#endregion

/** 读取注入的 connection 服务。 */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

/**
 * 探测一个会话是否仍 **attached**（还驻留在宿主内存里）。**本函数绝不抛。**
 *
 * 为什么需要它（2026-09-26 根因，证据见 `work\session-delete-20260926\root-cause-stale-row.md`）：
 * 侧栏列表 = **attached**（内存里活着的）+ **persisted**（磁盘上的）
 * （`dsh-api-session-controller\lib\index.js:1832` 的 `ApiSessionList.list()` JSDoc 原文：
 * "Read every visible attached and persisted Session without activating an Agent."）。
 * 我们只能删掉 persisted 那一半；会话只要**被打开过**就仍 attached，官方那条
 * `api-session/removed` 要等它 `session/disposed` 才发（同文件 `:2876-2878`）。
 * 插件**没有公开入口**能摘掉 attached 会话（`sessions` 服务只暴露 create/enter/get/list，
 * detach 释放器是 `enter()` 的返回值，只有当初把它装进内存的那一方持有；客户端 `clearMain()`
 * 是 `dsh-client-ui-workspace` 的私有方法）。⇒ 唯一正确的做法是**如实上报**这个事实，
 * 让客户端告诉用户"这一行会留到关闭标签页 / 重启 DSH"。
 *
 * 判据：`dsh-session` 的 `sessions.get(id)`，其 JSDoc 原文是
 * "Return the exact live entry; detached/prepared objects reject." ⇒ `get(id) !== undefined`
 * 就是 attached。（detached/prepared 的 reject 形态可能是抛错 ⇒ 由下面的 try 兜住。）
 *
 * 返回值**三态**：
 *   - `true`  —— 服务在、`get` 可用、拿到了对象；
 *   - `false` —— 服务在、`get` 可用、返回 `undefined`；
 *   - `undefined` —— **判不了**：取不到服务 / `get` 不是函数 / `get` 抛错 / 连属性访问都抛。
 * `undefined` 由客户端降级成通用兜底文案 —— **绝不猜**：猜 `false` 会把"行会一直显示"的实情
 * 说成"已删除会话"，正是本次故障里用户被误导的形态。
 *
 * @param ctx - Host 上下文。
 * @param sessionId - 会话 id（调用方已校验形状；本函数不再校验）。
 */
function attachedOf(ctx, sessionId) {
	try {
		// 用 `Reflect.get` 而不是 `ctx.sessions`：ctx 是 cordis 的 Proxy，属性访问本身也可能抛，
		// 而这里连"读不到"都必须降级成 undefined 而不是打穿到 route handler（否则删除会 500）。
		// ⚠️ 必须优先 `ctx.get(name)`：`Reflect.get(ctx, name)`（等价于属性访问 `ctx.name`）会被 cordis 的
	// Proxy 拦下 —— 2026-09-27 在 session-rewind 项目里实测原文：
	//     Reflect.get(ctx,"sessions") → throw: cannot get property "sessions" without inject
	// 后果：attached **永远返回 undefined**（本插件从第一天起就是这个 bug，用户看到的一直是"判不了"那条兜底文案）。
	// `ctx.get` 才是非注入式查服务的正规入口（本仓库对照：conversation-client.js:18035 的 scope.get("commandUi")）。
	const sessions = (typeof ctx.get === "function" ? ctx.get("sessions") : undefined) ?? Reflect.get(ctx, "sessions");
		if (sessions === undefined || sessions === null) return undefined;
		const get = Reflect.get(sessions, "get");
		if (typeof get !== "function") return undefined;
		// 用 call 绑定 this：真实服务的方法可能读 this。
		return get.call(sessions, sessionId) !== undefined;
	} catch {
		// 探测是**尽力而为**的信息补充：任何异常都只变成"判不了"，绝不外抛、绝不打日志
		// （日志行是删除本身的审计记录，不该被探测噪音污染）。
		return undefined;
	}
}

/** 把 `childIds` 里仍 attached 的那些挑出来（顺序与入参一致）。 */
function attachedChildrenOf(ctx, childIds) {
	const attached = [];
	for (const childId of childIds) {
		if (attachedOf(ctx, childId) === true) attached.push(childId);
	}
	return attached;
}

/**
 * 执行一次删除请求（纯接线，可被假 ctx 驱动）。
 *
 * 顺序（**最容易写错的地方**，别调换）：
 *   1. 校验 id → 目标**活体拒绝**（`status === "running"` ⇒ `SESSION_ACTIVE`）
 *   2. `dryRun:true` ⇒ 只回计划：**读** targetBytes / 子列表 / 子会话字节，一个字节都不改
 *   3. 读目标 `identity` + 定位日志目录 + `collectChildSessionIds()`（**必须在删目标之前**）
 *   4. 子会话活体判定：任一在 running ⇒ `CHILDREN_ACTIVE`（fail-closed，什么都不碰）
 *   5. 删子会话 → 再删目标（目标走既有流程：门控摘记账、广播）
 *
 * @param ctx - Host 上下文。
 * @param input - `{ sessionId, dryRun? }`（必须传对象字面量，不要直接传解析后的 request body）。
 * @returns 结构化结果；**以对象入参调用时不抛**。
 */
export async function handleSessionDelete(ctx, input) {
	const sessionId = input?.sessionId;
	if (!isValidSessionId(sessionId)) {
		return { ok: false, code: "INVALID_SESSION_ID", message: "会话 id 非法" };
	}
	const dryRun = input?.dryRun === true;

	// 活体判据：**看状态，不看驻留**（2026-09-26 Task 7 修 bug）。
	//
	// 旧代码是 `ctx.agents.get(sessionId) !== undefined` —— 把"**驻留**"当成了"**正在运行**"：
	// 只要 agent 还在内存里（标签页开着）就回 SESSION_ACTIVE，于是**所有"开着但没在跑"的会话
	// 全部删不掉**。用户实测那个会话就是这个形态：最后一回合被**中断**（UI 上显示"已停止"），
	// 但 agent 是 `idle` 且仍驻留 ⇒ 我们误报"正在运行"。
	// ⚠️ "已停止"不在 agent 状态里，它是**回合/块**的状态。那个把 `block.error?.code === "interrupted"`
	// 翻成 "stopped" 的三元式在**四个** `dsh-client-ui-*` 包里各有**一处**（不是 `dsh-client-ui-chat`）：
	// `dsh-client-ui-tool\lib\client.js:278` / `dsh-client-ui-skill\lib\client.js:129` /
	// `dsh-client-ui-cordis\lib\client.js:39` / `dsh-client-ui-deliverables\lib\client.js:528`；
	// `dsh-client-ui-chat` 里只有 locale 键 `"stopped": "kshsua_stopped"`（`:5789`）与
	// `code: "interrupted"`（`:9635`）—— 机制结论不变，只有包名归属曾写错（2026-09-26 评审 nit N1）。
	//
	// 判据取舍（有意为之，别退回保守版）：
	// 枚举只有两值 —— `AgentStatus = 'idle' | 'running'`，本机 9 个包的 `typert` 声明里
	// 逐字一致（dsh-agent-preset-registry、dsh-api-session-controller、dsh-api-terminal-controller、
	// dsh-commands、dsh-goal、dsh-subagent、dsh-session-reference、dsh-client-file-upload、
	// dsh-cordis-host-runner）。所以 `status` **缺失**或**取值奇怪**时，我们**选择允许删除**
	// 而不是保守拒绝：拒绝正是本次用户报告的故障模式（"删不掉"），代价远高于误删一个
	// 已经"不该在跑"的会话（真要误删，用户会看到文件消失，而不是永远删不掉却查不出原因）。
	// 形状漂移不掩盖：用一条 warning 让它可见即可。
	const agent = ctx.agents.get(sessionId);
	if (agent !== undefined && agent.status === "running") {
		return { ok: false, code: "SESSION_ACTIVE", message: "该会话正在运行，请先停止或先归档" };
	}
	// 形状漂移可见（但**不因此拒绝**——拒绝会把用户现在这个 bug 原样复现回来）。
	// dryRun 是**纯只读查询**（每次点菜单都会跑一遍），所以它连日志都不打：
	// "一个字节都不改"这条里包含"不留下任何观测痕迹"，漂移告警留给真删那条路径。
	if (!dryRun && agent !== undefined && agent.status !== "running" && agent.status !== "idle") {
		ctx.logger?.warn?.(
			`session-delete: 会话 ${sessionId} 的 agent.status 非预期值 ${JSON.stringify(agent.status)}，按"未运行"处理`
		);
	}

	const root = sessionsRoot();
	const cacheDir = projectionCacheDir();

	// ── 级联计划：**全部是只读**，且必须在任何删除之前完成 ────────────────────────
	// （子列表的唯一来源就是"待会要被删掉的那个日志"；先删再读只会得到 LOG_FILE_NOT_FOUND。）
	// 拿不到 identity / 找不到日志 / 日志超限 ⇒ cascade="unavailable"：**不级联**，但仍照删目标。
	const plan = await readCascadePlan(ctx, { root, sessionId });

	// ── dryRun：只回计划，一个字节都不删、不广播、不摘记账、不打日志 ──────────────
	if (dryRun) {
		const targetBytes = await measureBytesTolerant(plan.sessionDir);
		let childrenBytes = 0;
		for (const childId of plan.children) {
			let childDir;
			try {
				childDir = await locateSessionDirectory(root, childId);
			} catch {
				childDir = undefined; // 量不到就 0：**绝不**因为测量失败而让统计整体失败
			}
			childrenBytes += await measureBytesTolerant(childDir);
		}
		const body = {
			ok: true,
			dryRun: true,
			sessionId,
			targetBytes,
			// 目标自己是否仍驻留内存（三态：true/false/undefined=判不了）。dryRun 是纯只读，
			// 这里顺带把它量出来，好让弹窗在**确认之前**就能说清"删完这一行还会不会留着"。
			attached: attachedOf(ctx, sessionId),
			children: {
				total: plan.children.length,
				ids: [...plan.children],
				bytes: childrenBytes,
				running: [...plan.running],
				// 仍 attached 的子会话（只为文案；**不**改变删除计划）
				attached: attachedChildrenOf(ctx, plan.children)
			},
			cascade: plan.cascade
		};
		if (plan.cascadeReason !== undefined) body.cascadeReason = plan.cascadeReason;
		return body;
	}

	// ── 子会话活体：fail-closed（**一个字节都不删**、不广播、不摘记账）──────────────
	// 理由：子会话在跑就绝不能碰它的文件；而"跳过它"会让它变成界面上够不到的孤儿
	// ——那正是用户要消灭的东西。所以整单拒绝，而不是部分执行。
	if (plan.running.length > 0) {
		return {
			ok: false,
			code: "CHILDREN_ACTIVE",
			message: `该会话派生了 ${plan.running.length} 个仍在运行的子代理会话，请等它们结束再删除`,
			childrenRunning: [...plan.running]
		};
	}

	const title = await readCachedTitle(projectionCacheFile(sessionId));

	// ── 先删子会话：与目标**同一套** deleteSessionArtifacts（日志目录 + 投影缓存）、
	// 同一套门控摘记账（对子会话通常是 no-op，但走同一条路）、同一套广播（删了谁就广播谁）。
	const childDeleted = [];
	const childFailed = [];
	let childrenFreedBytes = 0;
	for (const childId of plan.children) {
		const childOutcome = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId: childId });
		childrenFreedBytes += childOutcome.freedBytes;
		const childBookkeeping = await clearSessionBookkeeping(ctx, childId, childOutcome);
		if (childOutcome.failed.length > 0 || childBookkeeping.failures.length > 0) {
			const parts = [];
			const firstFailure = childOutcome.failed[0];
			if (firstFailure !== undefined) parts.push(`${firstFailure.phase}/${firstFailure.code}: ${firstFailure.message}`);
			for (const failure of childBookkeeping.failures) parts.push(`${failure.step}: ${failure.message}`);
			// `code` 取第一个失败的码；只有注册表失败时用一个明确的兜底码（别留 undefined）。
			childFailed.push({
				id: childId,
				code: firstFailure?.code ?? "REGISTRY_FAILED",
				message: parts.join("; ")
			});
		} else {
			// `alreadyAbsent` 也算成功（幂等），不额外标注：它没有"需要用户处理"的东西。
			childDeleted.push(childId);
		}
		if (childOutcome.deleted.length > 0) ctx.emit("api-session/removed", childId);
	}

	// ── 再删目标（既有流程，一字未改）────────────────────────────────────────────
	// 顺序：先删文件（破坏性步骤）→ **门控**后摘记账 → 最后才广播。
	// 理由：先摘记账而文件没删成，会话会以"已取消归档"的样子**回到主列表**——用户点的是删除，
	// 却看到它复活，删除被静默降级成取消归档。反过来"文件已删、记账没摘"只留一个惰性 id：
	// 视图按 canonical-cwd 表头索引过滤，日志没了就不显示；unarchiveSession 也不做存在性探测。
	const outcome = await deleteSessionArtifacts({ root, projectionCacheDir: cacheDir, sessionId });

	// 门控：用 outcome.logDir 这个**已判定**的四态，而不是"删除没报错"的推断，
	// 也不是再调一次 locateSessionDirectory（那会共享同一个"读不到≠不存在"的盲点）。
	const { cleared, failures: registryFailures } = await clearSessionBookkeeping(ctx, sessionId, outcome);

	if (outcome.deleted.length > 0) {
		ctx.emit("api-session/removed", sessionId);
	}

	// ── attached 探测（**响应时刻**的状态：删掉磁盘数据不会让会话从内存里消失）──────────
	// 这是「删了但侧栏那一行还在」的如实上报。判定放在删除**之后**是有意的：它要回答的问题是
	// "此刻内存里还有没有"，而不是"删除前有没有"。
	const attached = attachedOf(ctx, sessionId);
	const childrenAttached = attachedChildrenOf(ctx, plan.children);

	const children = {
		total: plan.children.length,
		deleted: childDeleted,
		skipped: plan.skipped,
		failed: childFailed,
		freedBytes: childrenFreedBytes,
		// 仍 attached 的子会话 —— 用户当时正在看的**可能正是子会话**（删父会话时很常见），
		// 它的行同样会一直显示。**只为文案**：绝不影响上面已经做完的删除计划。
		attached: childrenAttached
	};

	// 审计日志：**只有一条**，且只记数量与失败数 —— 子会话 id 只进结构化字段，绝不塞进日志行
	// （500 个子会话 id 能把一行日志撑到几十 KB，既没用又淹没别的信息）。
	// Task 9 新增的两个字段同理：`attached` 是目标自己的三态、`childrenAttached` 只记**数量**。
	ctx.logger?.info?.(
		`session-delete: id=${sessionId} title=${JSON.stringify(title ?? "")} freedBytes=${outcome.freedBytes} ` +
		`deleted=${outcome.deleted.length} failed=${outcome.failed.length} logDir=${outcome.logDir} ` +
		`alreadyAbsent=${outcome.alreadyAbsent} cascade=${plan.cascade}` +
		(plan.cascadeReason === undefined ? "" : ` cascadeReason=${plan.cascadeReason}`) +
		` children=${children.total} childrenDeleted=${children.deleted.length} childrenFailed=${children.failed.length}` +
		` attached=${attached === undefined ? "unknown" : attached} childrenAttached=${childrenAttached.length}`
	);

	// 子会话的失败也要进**顶层** `failed`：客户端只认这个字段来显示明细，
	// 不给它一条可显示的记录，用户就只看到"部分失败"却没有任何线索。
	const failed = [
		...registryFailures,
		...outcome.failed,
		...childFailed.map((failure) => ({ target: failure.id, phase: "child", code: failure.code, message: failure.message }))
	];
	const cascadeFields = plan.cascadeReason === undefined ? {} : { cascadeReason: plan.cascadeReason };
	if (failed.length > 0) {
		return {
			ok: false,
			code: "PARTIAL_FAILURE",
			message: "未完全删除，请查看 failed 明细",
			sessionId,
			// 部分失败也带上（它同样是"真删"那条路径的响应）：客户端据此挑文案。
			attached,
			deleted: outcome.deleted,
			failed,
			cleared,
			logDir: outcome.logDir,
			freedBytes: outcome.freedBytes,
			children,
			cascade: plan.cascade,
			...cascadeFields
		};
	}

	return {
		ok: true,
		sessionId,
		// 三态：true（仍在内存里，侧栏条目会一直显示）/ false / undefined（判不了 ⇒ 客户端兜底文案）。
		// ⚠️ JSON.stringify 会把 undefined **丢掉** ⇒ 线上"判不了"表现为**缺字段**，客户端两条都要接。
		attached,
		deleted: outcome.deleted,
		failed: [],
		clearedArchive: cleared.archived,
		clearedPin: cleared.pinned,
		alreadyAbsent: outcome.alreadyAbsent,
		logDir: outcome.logDir,
		// ⚠️ 顶层 freedBytes 仍是**目标自己**的字节数（既有字段语义不变）；
		// 子会话释放的字节在 `children.freedBytes`，两者**不互相包含**。
		freedBytes: outcome.freedBytes,
		children,
		cascade: plan.cascade,
		...cascadeFields
	};
}

/**
 * 注册 Web 路由。
 * @param ctx - Host 上下文，需含 connection 服务。
 */
export function apply(ctx) {
	ctx.effect(() => connectionOf(ctx).fetch.register({
		path: SESSION_DELETE_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			let body;
			try {
				body = await request.json();
			} catch {
				return Response.json({ ok: false, code: "BAD_JSON", message: "body must be JSON" }, { status: 400 });
			}
			const result = await handleSessionDelete(ctx, body);
			// CHILDREN_ACTIVE 与 SESSION_ACTIVE 同档（都是"现在不能删"），都给 409。
			const status = result.ok
				? 200
				: result.code === "INVALID_SESSION_ID"
					? 400
					: result.code === "SESSION_ACTIVE" || result.code === "CHILDREN_ACTIVE"
						? 409
						: 500;
			return Response.json(result, { status });
		}
	}), "session-delete: route");
}
