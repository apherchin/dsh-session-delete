import { readdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 允许的会话 id 形状。必须以字母数字开头 —— 这一点同时排除 `.`、`..` 与前导点，
 * 也保证 JSONL 后端的"注入式安全段转义"对该 id 是恒等映射（磁盘目录名 === id）。
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * @param value - 待校验值。
 * @returns 是否是安全的会话 id。
 */
export function isValidSessionId(value) {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/**
 * 在 sessions root 的第一层项目目录下，按 basename 精确定位会话目录。
 * 不重实现 cwd→目录名的归一化规则，只做精确匹配，避免与后端转义逻辑漂移。
 *
 * **「找不到」与「无法判定」是两件事**：只有「root 确实不存在（ENOENT）」才返回 undefined；
 * 其余"读不到/看不下来"的错误一律抛出，由调用方决定降级口径 —— 这样权限类错误不会被
 * 伪装成"不存在"，从而不会在下游门控最该起作用的时候把它变成静默放行。
 *
 * @param root - sessions 根目录（绝对路径）。
 * @param sessionId - 已通过 isValidSessionId 的 id；本函数仍自行做入参类型兜底，不依赖调用方。
 * @returns 会话目录绝对路径；**root 确不存在（ENOENT）或没有匹配的目录**时返回 undefined。
 * @throws {NodeJS.ErrnoException} root 存在但读不成（ENOTDIR、EACCES、EPERM…），
 *   或某个候选路径 `stat` 出现非 ENOENT 的错误时。调用方必须自行 try/catch。
 */
export async function locateSessionDirectory(root, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	const rootResolved = path.resolve(root);
	// root 若本身以分隔符结尾（如盘符根 "C:\"），直接拼 path.sep 会出现双分隔符、
	// 让 startsWith 恒假并造成静默假阴性，所以先归一化前缀。
	const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
	let projects;
	try {
		projects = await readdir(rootResolved, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const candidate = path.join(rootResolved, project.name, sessionId);
		// 三重防穿越断言，实为**互为冗余的纵深防御**：
		//   1) 结构断言——候选的父目录必须是 root 的**直接**子目录，因而候选只能落在 root 内；
		//   2) startsWith(prefix)——事实上被 1) 蕴含（冗余但保留，作显式校验）；
		//   3) basename 恒等——唯一**可被单独观测**的一条。
		// 变异测试实测：删掉 3) 会让用例变红；删掉 1) 或 2) 用例仍全绿（构造上不可能让它们成为
		// 唯一拒绝者）。所以**不要以为 1)/2) 兜着就可以删 3)**：id 形如 "a/../victim" 经 path.join
		// 归一化后会指向真实存在的目录，只有 3) 拦得住。
		if (path.dirname(path.dirname(candidate)) !== rootResolved) continue;
		if (!candidate.startsWith(prefix)) continue;
		if (path.basename(candidate) !== sessionId) continue;
		let info;
		try {
			info = await stat(candidate);
		} catch (error) {
			// 候选确实不存在 → 跳过它，继续找别的项目目录；
			// 其余（EACCES/EPERM/EIO…）是"无法判定"，不吞、也不 continue。
			if (error.code === "ENOENT") continue;
			throw error;
		}
		if (info.isDirectory()) return candidate;
	}
	return undefined;
}

/**
 * 递归统计目录内所有普通文件的字节数（符号链接/目录本身不计）。
 * @param target - 目录绝对路径。
 * @returns 总字节数；**target 确不存在（ENOENT）** 时返回 0。
 * @throws {NodeJS.ErrnoException} 非 ENOENT 的 readdir/stat 失败（EACCES、EPERM、ENOTDIR…）
 *   会抛出，不做静默清零 —— "量不到字节"必须由调用方显式降级（记 warning），
 *   不能伪装成"这个目标没有字节"。
 */
export async function directoryBytes(target) {
	let total = 0;
	let entries;
	try {
		entries = await readdir(target, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
	for (const entry of entries) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(child);
		else if (entry.isFile()) {
			let info;
			try {
				info = await stat(child);
			} catch (error) {
				// 并发删除（ENOENT）→ 这个子项确实不在了，不计入也不算错；
				// 其余错误抛出，让调用方降级成 warning（freedBytes 少计），而不是进 failed。
				if (error.code === "ENOENT") continue;
				throw error;
			}
			total += info.size;
		}
	}
	return total;
}

/**
 * 读投影缓存里的会话标题，**仅供审计日志**；客户端传来的标题一律不采信。
 * 读不到（不存在 / 坏 JSON / 无权限）一律 undefined：本函数没有失败上报通道，
 * 且它的输出只进审计日志，不参与删除与记账判定。
 * @param projectionCacheFile - `<id>.json` 绝对路径。
 * @returns 标题字符串，读不到返回 undefined。
 */
export async function readCachedTitle(projectionCacheFile) {
	try {
		const raw = await readFile(projectionCacheFile, "utf8");
		const parsed = JSON.parse(raw);
		const title = parsed?.record?.rows?.title?.val;
		return typeof title === "string" && title.length > 0 ? title : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 删除一个会话的全部磁盘产物（**不可逆操作**）。幂等：不存在的目标不算失败。
 * **以对象入参调用时永不抛**：所有非预期异常都被转成结构化结果（`failed` / `logDir: "indeterminate"`）。
 * ⚠️ 唯一的抛错路径是"入参为 `null`/`undefined`（含完全省略）"：解构发生在会话目录定位（I1）的
 * try **之外**，实测 `deleteSessionArtifacts()` / `(null)` / `(undefined)` 抛 `TypeError`。
 * 其余形态都不抛 —— 实测：`{ root: undefined }` → `logDir: "indeterminate"`；
 * `projectionCacheDir` 非字符串 → `guard`/`SHAPE_MISMATCH`；连 `42`、`"body"` 这类原始值也只是
 * 走 `guard`（解构对非 null 原始值不抛）。所以调用方**必须传对象**，不要把解析后的 request body
 * 直接传进来（它可能是 `null`）；也**不要**再加 `input = {}` 之类的兜底把 `root=undefined`
 * 降级成 `absent` —— 那是凭空多造一条假 `absent` 路径，正是下游门控最该起作用时失效的根因。
 *
 * 威胁模型（TOCTOU）：定位/测量与 `rm` 之间存在时间窗，路径可被并发替换
 * （换成符号链接、目录换文件等）；本模块不做 open-then-unlink 级别的原子性保证。
 * 本机威胁模型是"用户删自己的数据"（单用户、调用方是同源且已鉴权的路由），
 * 本地攻击者主动抢这个窗口不在防御范围内。
 *
 * **两个"声明的根"**：本函数只接受这两个根 + 一个已校验的 id，**不接受任何调用方给的绝对文件路径** ——
 * 这是"给任意绝对路径即永久删除"这个原语被消灭的方式（调用方无法再指名一个任意的**文件**）。
 *   - `root` —— sessions 根目录（会话日志目录所在），沿用 `locateSessionDirectory` 的三重断言；
 *   - `projectionCacheDir` —— 投影缓存**目录**。缓存目标由本函数自己派生为
 *     `path.join(path.resolve(projectionCacheDir), `${sessionId}.json`)`。
 * 两个根**不必互相包含**：真实部署里投影缓存本来就不在 sessions root 之下。
 * 派生后校验"父目录恒等 resolve 后的 `projectionCacheDir`"且"basename 恒等 `${sessionId}.json`"，
 * 不符 → 记 `failed`（`SHAPE_MISMATCH`）且**该目标不做任何删除**。
 * 另外 `projectionCacheDir` 本身必须是**目录**：它 `stat` 报 ENOENT 时**放行**（缓存目录可能确实还没建，
 * 走幂等路径）；存在但**不是目录**时记 `failed`（`CACHE_DIR_NOT_A_DIRECTORY`）且不删 —— 否则一次
 * "根本没删掉投影缓存"会被 rm 的 ENOENT 伪装成 `absent`，变成静默的假成功。
 *
 * @param input - **必须传对象字面量** `{ root, projectionCacheDir, sessionId }`（原因见上文的抛错说明）。
 *   前置条件：`sessionId` **必须已通过 isValidSessionId**（本函数不重复校验其形状），
 *   `projectionCacheDir` 必须是字符串。违反前置条件时的兜底：日志目录的落点仍由
 *   `locateSessionDirectory` 的 basename 恒等断言兜住，缓存落点由上面的两条派生断言兜住。
 * @returns `{ deleted, failed, freedBytes, alreadyAbsent, logDir, warnings }`：
 *   - `deleted`: **确实被 `rm` 移除**的目标绝对路径（不是"尝试过"的）。
 *   - `failed`: **未能移除**的目标，每条形如 `{ target, phase, code, message }`；
 *     `phase` ∈ `"locate"`（无法定位）/`"logdir"`/`"cache"`/`"guard"`（入参形状或缓存目录形态不符）。
 *     "删了但量不到大小"不属于这里（见 `warnings`）。
 *   - `freedBytes`: **成功移除的那部分**字节数之和；失败目标与量不到大小的目标都不计入。
 *   - `alreadyAbsent`: 两个目标本就不存在（且没有 `indeterminate`）。
 *   - `logDir`: root 下的会话日志目录的判定结论，四态之一 ——
 *     `"removed"` 已成功删除 / `"absent"` 本就不存在（幂等路径）/
 *     `"failed"` 找到了但删不掉（已记入 `failed`）/
 *     `"indeterminate"` 无法判定（定位阶段抛错，**绝不能被当成 `"absent"`**）。
 *     下游**只应**在 `"removed"` 或 `"absent"` 时才去摘归档/置顶记账；
 *     有了这个字段，下游不必再自己探测一次（重复探测会共享同一个盲点）。
 *   - `warnings`: **只说明"附带动作不完美"，不说明删除成功与否**（例如测量大小时非 ENOENT 失败，
 *     导致 `freedBytes` 少计）。push 发生在 `rm` **之前且无条件**，所以同一条 `warnings` 完全可能
 *     伴随着该目标的删除随后失败、并另记进 `failed`。**不要塞进 `failed`**，
 *     否则一次干净的删除会被下游判成 PARTIAL_FAILURE。
 */
export async function deleteSessionArtifacts({ root, projectionCacheDir, sessionId }) {
	const deleted = [];
	const failed = [];
	const warnings = [];
	let freedBytes = 0;
	let logDir;
	let cacheAbsent = false;

	/** failed 记录的唯一出口（原本两处逐字重复的 catch→push 收敛到这里）。 */
	const recordFailure = (phase, target, error) => {
		failed.push({
			target: typeof target === "string" ? target : String(target),
			phase,
			code: error?.code ?? "UNKNOWN",
			message: String(error?.message ?? error)
		});
	};

	/**
	 * best-effort 量大小，**不作为存在性判据**（存在性一律由 `rm` 自己回答）。
	 * 非 ENOENT 失败向上抛，由调用方记 warning —— 这是"量不准"，不是"删不掉"。
	 */
	const measureBytes = async (target) => {
		let info;
		try {
			info = await stat(target);
		} catch (error) {
			if (error?.code === "ENOENT") return 0; // 确实不存在：0 字节
			throw error; // 无法判定大小 → 调用方降级成 warning
		}
		if (info.isDirectory()) return await directoryBytes(target);
		return info.isFile() ? info.size : 0;
	};

	/**
	 * 删一个目标：先 best-effort 量大小，再由 `rm` 本身回答"存在性"。
	 * @param rmOptions - **调用方不得传 `force: true`**（它会把 ENOENT 吞掉，令
	 *   本函数无法区分 "removed" 与 "absent"，理由见文件末尾）。
	 * @returns `"removed"` 成功移除 | `"absent"`（rm 报 ENOENT，本就不存在）| `"failed"`。
	 */
	const removeTarget = async (phase, target, rmOptions) => {
		let size = 0;
		try {
			size = await measureBytes(target);
		} catch (error) {
			warnings.push(`无法测量 ${target} 的大小，freedBytes 将少计：${error?.code ?? "UNKNOWN"} ${String(error?.message ?? error)}`);
		}
		try {
			await rm(target, rmOptions);
		} catch (error) {
			if (error?.code === "ENOENT") return "absent"; // 本就不存在：幂等路径
			recordFailure(phase, target, error);
			return "failed";
		}
		deleted.push(target);
		freedBytes += size;
		return "removed";
	};

	let sessionDir;
	try {
		sessionDir = await locateSessionDirectory(root, sessionId);
	} catch (error) {
		// 无法判定（ENOTDIR/EACCES/EPERM…）：**绝不动删除与记账**，如实上报 indeterminate。
		// 把"无法判定"伪装成"不存在"，正是下游门控在最该起作用时失效的根因。
		logDir = "indeterminate";
		recordFailure("locate", root, error);
		return { deleted, failed, freedBytes, alreadyAbsent: false, logDir, warnings };
	}
	if (sessionDir === undefined) {
		logDir = "absent";
	} else {
		// 日志目录是树：recursive。**故意不传 force** —— 理由见文件末尾。
		logDir = await removeTarget("logdir", sessionDir, { recursive: true, maxRetries: 5, retryDelay: 100 });
	}

	// 缓存目标由**声明的缓存目录 + 已校验的 id** 在核心内部派生：调用方再也无法把任意绝对文件路径
	// 送进 rm。三条断言与 locateSessionDirectory 的 basename 恒等兜底对称：
	//   1) projectionCacheDir 必须是字符串 —— 否则 path.resolve 会抛 TypeError，破坏
	//      "以对象入参调用时永不抛"这条承诺，所以先挡在 resolve 之前；
	//   2) 派生目标的父目录必须恒等 resolve 后的 projectionCacheDir（拦 '../x' 形态）；
	//   3) 派生目标的 basename 必须恒等 `${sessionId}.json`（拦 'a/../victim' 形态 ——
	//      该形态下 1)/2) 都会放行，只有 3) 拦得住，与日志目录那侧同理）。
	let cacheDirResolved;
	let cacheFile;
	if (typeof projectionCacheDir === "string") {
		cacheDirResolved = path.resolve(projectionCacheDir);
		cacheFile = path.join(cacheDirResolved, `${sessionId}.json`);
	}
	if (
		cacheDirResolved === undefined ||
		path.dirname(cacheFile) !== cacheDirResolved ||
		path.basename(cacheFile) !== `${sessionId}.json`
	) {
		const reason =
			cacheDirResolved === undefined
				? "projectionCacheDir 不是字符串，解析不出缓存目录"
				: path.dirname(cacheFile) !== cacheDirResolved
					? `派生目标 ${cacheFile} 的父目录不是声明的缓存目录 ${cacheDirResolved}`
					: `派生目标 ${cacheFile} 的 basename 与 ${sessionId}.json 不恒等（sessionId 未过 isValidSessionId？）`;
		recordFailure("guard", cacheFile ?? projectionCacheDir, {
			code: "SHAPE_MISMATCH",
			message: `${reason}；本目标不做任何删除`
		});
	} else {
		// Step 0 硬化（2026-09-26）：先看**声明的缓存目录**本身是什么，再决定要不要派生删除目标。
		// 动机：签名从"文件路径"改成"目录"之后，调用方若把**一个文件**当目录传进来，
		// 派生目标 `<file>/<id>.json` 在本机（Windows/node v22）rm 报 ENOENT → 被映射成 "absent"，
		// 于是**静默无事**：一个字节没删（安全方向），却把"根本没删掉投影缓存"伪装成了成功 ——
		// 正是本项目一路在消灭的**假成功**类型（配置错误被吞掉）。
		// 三态收窄，与 locateSessionDirectory / directoryBytes 同一套原则：
		//   1) ENOENT          → **放行**（缓存目录可能确实还不存在；neverwas 用例依赖这一点）；
		//   2) 存在但不是目录   → `guard`/`CACHE_DIR_NOT_A_DIRECTORY`，**该目标不做任何删除**；
		//   3) 其余 stat 错误   → 原样记 failed（读不到 ≠ 不存在，不裸吞）。
		// 本步只影响**缓存这一侧**：日志目录的处置已在上面完成，两侧互不牵连。
		let cacheDirInfo;
		let cacheDirError;
		try {
			cacheDirInfo = await stat(cacheDirResolved);
		} catch (error) {
			cacheDirError = error;
		}
		if (cacheDirError === undefined && !cacheDirInfo.isDirectory()) {
			recordFailure("guard", cacheDirResolved, {
				code: "CACHE_DIR_NOT_A_DIRECTORY",
				message:
					`声明的投影缓存目录 ${cacheDirResolved} 存在但不是目录；` +
					`派生目标 ${cacheFile} 不做任何删除`
			});
		} else if (cacheDirError !== undefined && cacheDirError?.code !== "ENOENT") {
			recordFailure("guard", cacheDirResolved, cacheDirError);
		} else {
			// 缓存是**文件**：故意不传 recursive —— 若该路径实际是非空目录，
			// rm 会以 ERR_FS_EISDIR 失败，而不是替调用方递归删掉一整棵树。
			// 也故意不传 force：见文件末尾"为什么不用 force"。
			const outcome = await removeTarget("cache", cacheFile, {});
			if (outcome === "absent") cacheAbsent = true;
		}
	}

	return {
		deleted,
		failed,
		freedBytes,
		alreadyAbsent: logDir === "absent" && cacheAbsent,
		logDir,
		warnings
	};
}

// M7（选择与理由，写在这里以免下游误改）：日志目录的 rm 带 maxRetries: 5 / retryDelay: 100。
// Node 的 rm 默认 maxRetries: 0，Windows 上被杀软、索引器或另一进程短暂占用树内文件时
// 会立刻抛 EBUSY/EPERM/ENOTEMPTY —— 那会把一次本该成功的删除记成 failed，
// 进而让下游把它判成 PARTIAL_FAILURE。重试只对"瞬时占用"有效：真实的永久性 EPERM
// 会把 6 次尝试全部用完后照旧落进 failed（不会掩盖错误）。代价上限是失败时多等
// 100+200+300+400+500ms ≈ 1.5s，只在删除失败路径上产生。
// 缓存目标走非递归 rm：Node 文档明确"recursive 不为 true 时忽略 maxRetries"，故不传。
//
// 为什么**不用** `force: true`（与评审建议的一处有意偏离，有实测依据）：
// `force: true` 的语义是"路径不存在就忽略异常"，于是 ENOENT 被 rm 自己吞掉、
// 调用方再也拿不到"本就不存在"这个信号 —— 实测 `rm(<不存在>, { force: true })`
// 直接 resolve（连父目录不存在也 resolve）。那样 `"removed"` 与 `"absent"` 就无法区分，
// `alreadyAbsent` 会恒为 false、`logDir` 会恒为 "removed"，下游门控拿到的结论是错的。
// 去掉 force 后实测：`rm(<不存在>)` 抛 ENOENT（文件、目录树都一样）→ 映射为 "absent"；
// 非空目录仍抛 ERR_FS_EISDIR → "failed"；只读文件照样能删（Node 内部会 chmod 后重试，
// 有无 force 实测都是 "deleted"）。于是"存在性由 rm 自己回答"这条才真正成立，
// 且不需要额外的 lstat 探测。若将来有人为了"少抛异常"把 force 加回来，上面两条语义都会坏。

