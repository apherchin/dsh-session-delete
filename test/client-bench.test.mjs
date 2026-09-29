// Task 6 起建的**离线**客户端验证台：把 client.js 放进一个假浏览器上下文里跑，
// 验证「静态可证」之外的那部分逻辑——注册形状、props 接线、默认焦点、fetch 的每条分支，
// 以及（2026-09-29 起）自包含原语**真正渲染出的 DOM 结构**。
//
// 用法：node test/client-bench.test.mjs   （非 0 退出 = 有断言失败）
import fs from 'node:fs';
import vm from 'node:vm';

// 相对本文件定位被测工件（开源后换机器也能跑；不再写死开发机的绝对路径）。
// fs.readFileSync / vm 都接受 URL 对象。
const CLIENT = new URL('../client.js', import.meta.url);

let pass = 0;
const failures = [];
function check(label, ok, detail) {
	if (ok) {
		pass += 1;
		console.log(`  ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`);
	}
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 假 jsx runtime：把 React 元素降级成可断言的普通对象 ──────────────
const Fragment = Symbol('Fragment');
const jsxShim = (type, props, key) => ({ type, props: props ?? {}, key });

/**
 * 展开一层自包含原语（2026-09-29 起 client.js **自己实现**了 MenuItemButton / Modal /
 * Button / 两个图标，不再 import `@deepseek-ai/dsh-client-ui-primitives`）。
 * 这几个都是无副作用纯函数，可以直接调用拿渲染树 —— 断言因此从「用了哪个模块的身份」
 * 升级为「真正渲染出来的 DOM 形状」，比原来更强。
 */
const expand = (el) => (el !== null && el !== undefined && typeof el.type === 'function' ? el.type(el.props ?? {}) : el);
/** 元素类型名（自包含原语都是具名函数声明 ⇒ `name` 稳定）。 */
const elName = (el) => (typeof el?.type === 'function' ? el.type.name : undefined);
/** 深度优先找第一个满足判据的元素。 */
function findEl(node, pred) {
	if (node === null || node === undefined || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findEl(child, pred);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (pred(node)) return node;
	return findEl(node.props?.children, pred);
}
/**
 * 深度优先找一个**具名自包含组件**（如 `IconTrashOutlineRegular`）。
 * ⚠️ 刻意**不展开**沿途的函数组件：只把"图标节点"本身交给 `expand()` 展开，
 * 免得误展开带 hook 的组件（`Modal` / 确认弹窗体）而吃到假 react 的状态种子。
 */
const findComponent = (node, name) => findEl(node, (el) => typeof el?.type === 'function' && el.type.name === name);

// ── 假 react：useState 从「每次渲染的种子队列」取值，便于渲染第二种状态 ──
// 2026-09-29：自包含 Modal 用 `useRef`/`useEffect` 实现「初始聚焦 / Escape / Tab 循环」。
// 这里 `useEffect` 是 **no-op**（验证台不跑副作用，只断言渲染树），键盘与聚焦行为由
// `work\publish-session-delete-20260929\probe-modal-layer.mjs` 单独正面验证。
function makeReact(seed = []) {
	const queue = [...seed];
	return {
		useState: (initial) => {
			const value = queue.length > 0 ? queue.shift() : initial;
			return [value, () => {}];
		},
		useRef: (initial) => ({ current: initial ?? null }),
		useEffect: () => {}
	};
}

// ── 2026-09-29：原先这里有两个「假依赖」桩（`primitives` 与 `createSnapshotStore`）──
// 它们对应 client.js 曾经 require 的两个 Harness Client 包。**现已整块删除**：那 5 个原语
// （MenuItemButton / Modal / Button / 两个图标）+ 1 个 store 全部改成 client.js 自己的
// 自包含实现（官方 practices 明文禁止 require Harness Client 包，理由见
// `reports\dsh-session-delete-标准符合性与发布可行性-20260929.md` §2 第 9 条）。
// 桩一起删掉是**故意的**：见下面 `req` 里的合规守卫 —— 谁把 import 加回来，验证台当场炸。

// ── 在 vm 里加载 client.js，拿到它交给 __ModuleLoader__ 的定义 ────────
// Task 7 起假环境还需要三样：计时器（"已复制"提示 2 秒后自动消失）、document
// （`execCommand("copy")` 兜底的临时 textarea）、以及可替换的 navigator.clipboard。
// 计时器**手动驱动**（记录 delay，测试里显式触发），这样既能断言 delay === 2000，
// 又不必让验证台真的等 2 秒。
const timers = [];
const sandbox = {
	window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def; } } },
	navigator: { language: 'zh-CN' },
	console,
	fetch: undefined,
	setTimeout: (fn, ms) => {
		timers.push({ fn, ms });
		return timers.length;
	},
	clearTimeout: () => {}
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' });

const def = sandbox.__def;
check('client.js 通过 window.__ModuleLoader__.load 注册', def !== undefined);
check('bundle id = 包名（官方要求：浏览器工件的 factory id 必须等于包名）', def?.id === '@apherchin/dsh-session-delete', def?.id);

// ── T0 静态契约（Task 9）：**不许再出现"主动拉列表"** ──────────────────
// 「删了侧栏行还在 / 第一次删除闪一下」的第二个根因就是**我们自己**：删除成功后主动拉了一次
// 会话列表。宿主列表 = attached（内存里活着的）+ persisted（磁盘上的），我们只删掉了后者；
// 主动拉取会把刚被 `api-session/removed` 掉掉的那一行**重新加回来**
// （证据见 work\session-delete-20260926\root-cause-stale-row.md）。
// ⇒ 这条禁令我按**静态 + 行为**两层守：静态看源码代码段里还有没有那个动作，行为看 apply
//    到底有没有去要会话服务（见下面 T7 的 refreshCount 断言；"要了但没调"与"压根没要"
//    是两种不同的复辟形态，两层都要）。
const clientSource = fs.readFileSync(CLIENT, 'utf8');
/**
 * 去掉注释后的**代码**。注释里必须能把根因写清楚（包括被禁掉的那些 API 名字），
 * 所以静态检查只看代码。已核实本文件字符串里不含 `//`，故按行截断 `//` 是安全的。
 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => {
			const at = line.indexOf('//');
			return at === -1 ? line : line.slice(0, at);
		})
		.join('\n');
}
const clientCode = stripComments(clientSource);
check('T0 前置：去注释后的代码仍然完整（stripper 没把代码吃掉：含 exports.apply / __ModuleLoader__）',
	clientCode.includes('exports.apply') && clientCode.includes('__ModuleLoader__'));
check('T0：代码里**不再**为 sessions 做嵌套注入（ctx.inject(["sessions"]) 必须已删）',
	!/inject\s*\(\s*\[\s*["']sessions["']/.test(clientCode),
	'发现 ctx.inject(["sessions"]) —— 会话服务接线复辟');
check('T0：代码里**不再**出现 refresh（拉列表会把 attached 会话的行拉回来 ⇒ 复辟即回归"闪一下"）',
	!/refresh/i.test(clientCode),
	(clientCode.match(/.*refresh.*/i) ?? [''])[0]);
check('T0：也不许换别的写法去取会话服务（sessionsRef / scope.get("sessions") 都必须没了）',
	!/sessionsRef/.test(clientCode) && !/get\s*\(\s*["']sessions["']\s*\)/.test(clientCode));

// ── 合规红线（2026-09-29）：官方 practices 明文禁止 require 任何 Harness Client 包 ──
// 原文："Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness
// Client package as a module"（理由：无预告变更 / 纯 JS 无类型检查 / 抛错的组件会让整块
// slot entry 空白）。这条把「5 个原语 + 1 个 store 全部自包含」钉死，防复辟。
// 依据：`reports\dsh-session-delete-标准符合性与发布可行性-20260929.md` §2 第 9 条。
check('合规：代码里不再 require 任何 @deepseek-ai/* 包（原语已全部自包含）',
	!/require\s*\(\s*["']@deepseek-ai\//.test(clientCode),
	(clientCode.match(/.*require\s*\(\s*["']@deepseek-ai\/.*/) ?? [''])[0]);
check('合规：require 只允许 react / react-dom / react/jsx-runtime（基座）',
	(() => {
		const specs = [...clientCode.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
		return specs.length > 0 && specs.every((s) => s === 'react' || s === 'react-dom' || s === 'react/jsx-runtime');
	})(),
	JSON.stringify([...clientCode.matchAll(/require\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1])));

function loadClient() {
	let reactShim = makeReact();
	const req = (spec) => {
		if (spec === 'react') return reactShim;
		if (spec === 'react/jsx-runtime') return { jsx: jsxShim, jsxs: jsxShim, Fragment };
		// 2026-09-29 合规红线：client.js **不得**再 require 任何 Harness Client 包
		// （5 个原语 + 1 个 store 已全部自包含）。这里刻意**不给桩、直接抛** ——
		// 一旦有人把 import 加回来，验证台会当场炸掉，而不是默默通过。
		if (spec === '@deepseek-ai/dsh-client-ui-primitives' || spec === '@deepseek-ai/dsh-client-store') {
			throw new Error(`合规红线：client.js 不得 require ${spec}（官方 practices 明文禁止；原语已自包含）`);
		}
		throw new Error(`unexpected require(${spec})`);
	};
	const exports = def.factory(req);
	return { exports, setSeed: (seed) => { reactShim = makeReact(seed); } };
}

// ── T1 模块元数据 ────────────────────────────────────────────────────
const { exports } = loadClient();
check('exports.name = session-delete-client', exports.name === 'session-delete-client', exports.name);
// ⚠️ 断言已随 Task 6 加固改写（原为「exports.inject 只硬门禁 slots」）：
// 硬门禁 `["slots"]` 在 slots 未就绪时会让 client entry 停在 pending，而渲染端 web boot
// 门禁对 pending 与 failed 一视同仁（全有全无）⇒ 整个应用启动中止。故改为断言**不挂任何硬门禁**。
check('exports.inject 不挂任何硬门禁（slots/sessions 都走嵌套注入）', eq(exports.inject, []), JSON.stringify(exports.inject));
check('exports.apply 是函数', typeof exports.apply === 'function');
// 2026-09-29：`__clientDiagnostics()` 是为「静默降级的资源」准备的**只读**诊断出口 ——
// 样式注入 / portal 这类"失败只退化外观"的路径刻意不打日志（本文件的"正常路径零日志"
// 断言在守这个），所以改成用正面断言查它们到底有没有生效。
check('exports.__clientDiagnostics 是函数（只读诊断出口）', typeof exports.__clientDiagnostics === 'function');
{
	const diag = exports.__clientDiagnostics();
	// 本验证台的缩减环境：没有 `document`/`ctx.effect` ⇒ 样式不注入；没有 `react-dom` ⇒ 不 portal。
	// 两条都必须是**静默降级**（下面各场景的"日志集合"断言就是守这个的）。
	check('诊断：缩减环境下 stylesInjected=false 且 portal=false（均为静默降级）',
		diag?.stylesInjected === false && diag?.portal === false, JSON.stringify(diag));
}

// ── T2 注册形状 ──────────────────────────────────────────────────────
const registrations = [];
let currentSlot = null;
const nestedInjects = [];

// 假槽位服务：与真实 `slots.inject(key, gen)` + `slots.register(spec, Comp)` 的用法等价
// （真实实现在 `dsh-client-ui-renderer/lib/client.js` 的 `SlotRegistry.inject`）。
function makeSlots(overrides = {}) {
	return {
		inject: overrides.inject ?? ((slot, gen) => {
			currentSlot = slot;
			const it = gen();
			for (let r = it.next(); !r.done; r = it.next()) {
				const value = r.value ?? {};
				registrations.push({ slot, spec: value.spec, Comp: value.Comp });
			}
		}),
		register: overrides.register ?? ((spec, Comp) => ({ slot: currentSlot, spec, Comp }))
	};
}

// 假 scope：嵌套注入回调收到的 ctx。
// 真实 cordis 语义（`@deepseek-ai/cordis/src/registry.ts` 的 `Context.inject` 文档）：
// 「Run a callback once the requested services are available」—— 依赖齐了才以 scope 回调。
function makeScope(options = {}) {
	return {
		slots: options.scopeSlots,
		get: options.get ?? (() => options.sessions),
		effect: options.effect ?? ((cb) => {
			const dispose = cb();
			return typeof dispose === 'function' ? dispose : () => {};
		})
	};
}

// 假 ctx（支持嵌套注入 `ctx.inject(names, cb)`）。
//   slots / scopeSlots —— 显式传 `slots: undefined` = 槽位服务不可用；`scopeSlots` 可换成会抛错的桩
//   hold —— 命中的依赖只记录、不回调（模拟服务永不到达）
//   get / effect / sessions —— 透传给 scope，用于构造「服务不可用」的失败路径
function makeCtx(options = {}) {
	const slots = 'slots' in options ? options.slots : makeSlots();
	return {
		slots,
		inject: (deps, cb) => {
			nestedInjects.push({ deps, cb });
			if ((options.hold ?? []).some((name) => deps.includes(name))) return () => {};
			cb(makeScope({
				scopeSlots: 'scopeSlots' in options ? options.scopeSlots : slots,
				sessions: options.sessions,
				get: options.get,
				effect: options.effect
			}));
			return () => {};
		}
	};
}
exports.apply(makeCtx());

const menuReg = registrations.find((r) => r.slot === 'sidebar.workspaces.session.menu.item');
const overlayReg = registrations.find((r) => r.slot === 'shell.overlay');
check('菜单行注册进 sidebar.workspaces.session.menu.item', menuReg !== undefined);
check('弹窗注册进 shell.overlay', overlayReg !== undefined);
check('菜单行 id = session-delete', menuReg?.spec.id === 'session-delete', menuReg?.spec.id);
check('菜单行 order = 500（落在 archive 400 之后）', menuReg?.spec.order === 500, menuReg?.spec.order);
check(
	'没有任何 id 还是 spike（session-delete-spike 已彻底移除）',
	!registrations.some((r) => String(r.spec?.id ?? '').includes('spike')),
	JSON.stringify(registrations.map((r) => r.spec?.id))
);
check('弹窗 id = session-delete-confirm', overlayReg?.spec.id === 'session-delete-confirm', overlayReg?.spec.id);
check('菜单行 inject 是函数（entry 级 inject 必须是函数）', typeof menuReg?.spec.inject === 'function');
check('弹窗 inject 是函数', typeof overlayReg?.spec.inject === 'function');
// ⚠️ 断言已随 Task 9 改写（原为 `eq(nestedInjects.map(n => n.deps), [["sessions"], ["slots"]])`）：
// sessions 接线按根因**整体删除**，现在只应有 slots 一处嵌套注入。
// **不能**因为删了 sessions 就改成"什么都不注入"——槽位仍必须走嵌套（见 T8：硬门禁/裸 ctx.slots
// 都会撞启动门禁），所以这条断言的方向是"少了一个，而不是没了"。
check(
	'只有 slots 走嵌套 ctx.inject（sessions 接线已按根因整体移除）',
	eq(nestedInjects.map((n) => n.deps), [['slots']]),
	JSON.stringify(nestedInjects.map((n) => n.deps))
);
check(
	'exports.inject 里既没有 slots 也没有 sessions（不挂未满足的硬门禁）',
	!JSON.stringify(exports.inject ?? []).includes('slots') && !JSON.stringify(exports.inject ?? []).includes('sessions'),
	JSON.stringify(exports.inject)
);

const menuInjected = menuReg.spec.inject();
const overlayInjected = overlayReg.spec.inject();
check('菜单行 inject 提供 requestSessionDelete', typeof menuInjected.requestSessionDelete === 'function');
check(
	'菜单行 inject 自带 useDeleteRequest 之外的业务回调（无多余 hook）',
	menuInjected.hooks === undefined,
	JSON.stringify(Object.keys(menuInjected))
);
check(
	'弹窗 inject 以 hooks.deleteRequest 暴露共享状态 ⇒ 组件拿到 useDeleteRequest',
	typeof overlayInjected.hooks?.deleteRequest === 'object' &&
		typeof overlayInjected.hooks.deleteRequest.getSnapshot === 'function',
	JSON.stringify(Object.keys(overlayInjected.hooks ?? {}))
);
check('弹窗 inject 提供 settleSessionDelete / performSessionDelete',
	typeof overlayInjected.settleSessionDelete === 'function' && typeof overlayInjected.performSessionDelete === 'function');

// ── T2b 复制行（Task 7 新增）的注册形状 ──────────────────────────────
// 注册数 2 → 3：菜单-删除行 / 菜单-复制行 / overlay。overlay **仍然只有一个 entry**
// （复制提示与确认弹窗复用同一个组件、按 store 状态分派）。
check('注册总数 = 3（菜单-删除行 / 菜单-复制行 / overlay）',
	registrations.length === 3,
	JSON.stringify(registrations.map((r) => r.spec?.id)));
const menuCopyReg = registrations.find((r) => r.spec?.id === 'session-delete-copy-id');
check('复制行注册进同一个菜单槽位 sidebar.workspaces.session.menu.item',
	menuCopyReg?.slot === 'sidebar.workspaces.session.menu.item', String(menuCopyReg?.slot));
check('复制行 order = 450（落在官方 archive 400 之后、我们的删除 500 之前）',
	menuCopyReg?.spec.order === 450, String(menuCopyReg?.spec.order));
check('两个菜单行 id 互不相同（list 槽位的 id 必须唯一）',
	menuReg?.spec.id === 'session-delete' && menuCopyReg?.spec.id === 'session-delete-copy-id'
		&& menuReg.spec.id !== menuCopyReg.spec.id,
	`${String(menuReg?.spec.id)} / ${String(menuCopyReg?.spec.id)}`);
check('复制行 inject 是函数（entry 级 inject 必须是函数）', typeof menuCopyReg?.spec.inject === 'function');
const copyInjected = menuCopyReg?.spec.inject();
check('复制行 inject 提供 copySessionId', typeof copyInjected?.copySessionId === 'function');
check('复制行不声明额外 hooks（useMenuOpenState 由 owner 自动合并）',
	copyInjected?.hooks === undefined, JSON.stringify(Object.keys(copyInjected ?? {})));
check('overlay inject 现在同时暴露 hooks.copyNotice（复用同一个 entry，没有第二个 overlay 注册）',
	typeof overlayInjected.hooks?.copyNotice === 'object' && typeof overlayInjected.hooks.copyNotice.getSnapshot === 'function',
	JSON.stringify(Object.keys(overlayInjected.hooks ?? {})));

const deleteRequest = overlayInjected.hooks.deleteRequest;

// ── T3 菜单行：props 接线 + 先关菜单再开弹窗 ─────────────────────────
const seq = [];
const menuProps = {
	sessionId: 'S1',
	displayTitle: '标题A',
	requestSessionDelete: menuInjected.requestSessionDelete,
	useMenuOpenState: () => [false, (v) => seq.push(['close', v])]
};
const row = menuReg.Comp(menuProps);
check('菜单行用自包含 MenuItemButton 渲染', elName(row) === 'MenuItemButton', String(elName(row)));
check('菜单行文案 = 删除对话', row.props.children === '删除对话', String(row.props.children));
check('菜单行图标 = IconTrashOutlineRegular', elName(row.props.icon) === 'IconTrashOutlineRegular', String(elName(row.props.icon)));
check('菜单行图标 size = 14（与官方行一致）', row.props.icon?.props?.size === 14, String(row.props.icon?.props?.size));
check('菜单行未显式传 role（MenuItemButton 内部已是 role=menuitem）', row.props.role === undefined);
// 结构断言（比"用了哪个模块的身份"更强）：展开一层，验证真正渲染出的菜单行 DOM 形状。
{
	const wrap = expand(row);
	const btn = findEl(wrap, (el) => el?.props?.role === 'menuitem');
	check('展开后：外层 .dsd-item-wrap，内含 role=menuitem 的 button',
		wrap?.props?.className === 'dsd-item-wrap' && btn?.type === 'button',
		JSON.stringify({ wrap: wrap?.props?.className, btnType: btn?.type }));
	check('展开后：button 带 .dsd-item，文案在 .dsd-item-label 里',
		btn?.props?.className === 'dsd-item'
		&& findEl(btn, (el) => el?.props?.className === 'dsd-item-label')?.props?.children === '删除对话');
	const svg = expand(findComponent(btn, 'IconTrashOutlineRegular'));
	check('展开后：垃圾桶图标是真 svg（viewBox 0 0 16 16 / strokeWidth 1 / 5 条 path）',
		svg?.props?.viewBox === '0 0 16 16' && svg?.props?.strokeWidth === 1
		&& Array.isArray(svg?.props?.children) && svg.props.children.length === 5,
		JSON.stringify({ viewBox: svg?.props?.viewBox, sw: svg?.props?.strokeWidth, paths: svg?.props?.children?.length }));
}

seq.length = 0;
deleteRequest.set(null);
row.props.onSelect();
check('点击先关菜单（setMenuOpen(false)）', eq(seq, [['close', false]]), JSON.stringify(seq));
check('点击后共享状态被写入 { sessionId, displayTitle }',
	eq(deleteRequest.getSnapshot(), { sessionId: 'S1', displayTitle: '标题A' }),
	JSON.stringify(deleteRequest.getSnapshot()));

// owner 不再提供 useMenuOpenState 时不得崩，且仍能开弹窗
let threw = false;
try {
	deleteRequest.set(null);
	const fallbackRow = menuReg.Comp({ sessionId: 'S2', requestSessionDelete: menuInjected.requestSessionDelete });
	fallbackRow.props.onSelect();
} catch (error) {
	threw = true;
}
check('useMenuOpenState 缺失时退化为 no-op、不抛', threw === false);
check('退化路径仍然写出请求（displayTitle 回落到 sessionId）',
	eq(deleteRequest.getSnapshot(), { sessionId: 'S2', displayTitle: 'S2' }),
	JSON.stringify(deleteRequest.getSnapshot()));

// ── T4~T6 弹窗渲染辅助 ───────────────────────────────────────────────
// 假 jsx 只产出「元素描述」，不会自行调用函数组件 —— 这里手动往下渲染一层。
const renderDialog = (Comp, injected) => {
	const node = Comp({
		useDeleteRequest: (sel) => sel(injected.hooks.deleteRequest.getSnapshot()),
		settleSessionDelete: injected.settleSessionDelete,
		performSessionDelete: injected.performSessionDelete
	});
	if (node === null) return null;
	return typeof node.type === 'function' ? node.type(node.props) : node;
};

// ── T4 弹窗：无请求 → null；有请求 → Modal 形状 ───────────────────────
deleteRequest.set(null);
check('无请求时弹窗渲染 null', renderDialog(overlayReg.Comp, overlayInjected) === null);

// 以「假 react 种子」重新加载一份模块：这样能直接渲染「删除中 / 有错误」这两种状态。
function loadWithSeed(seed) {
	const registrations2 = [];
	let slot2 = null;
	const req = (spec) => {
		if (spec === 'react') return makeReact(seed);
		if (spec === 'react/jsx-runtime') return { jsx: jsxShim, jsxs: jsxShim, Fragment };
		// 2026-09-29 合规红线：client.js **不得**再 require 任何 Harness Client 包
		// （5 个原语 + 1 个 store 已全部自包含）。这里刻意**不给桩、直接抛** ——
		// 一旦有人把 import 加回来，验证台会当场炸掉，而不是默默通过。
		if (spec === '@deepseek-ai/dsh-client-ui-primitives' || spec === '@deepseek-ai/dsh-client-store') {
			throw new Error(`合规红线：client.js 不得 require ${spec}（官方 practices 明文禁止；原语已自包含）`);
		}
		throw new Error(`unexpected require(${spec})`);
	};
	const mod = def.factory(req);
	// 这份 ctx 也要支持嵌套注入（client.js 的槽位注册只在 `ctx.inject(["slots"], cb)` 里发生）。
	mod.apply({
		slots: undefined,
		inject: (deps, cb) => {
			if (deps.includes('slots')) {
				cb(makeScope({
					scopeSlots: {
						inject: (slot, gen) => {
							slot2 = slot;
							const it = gen();
							for (let r = it.next(); !r.done; r = it.next()) {
								registrations2.push({ slot, spec: r.value?.spec, Comp: r.value?.Comp });
							}
						},
						register: (spec, Comp) => ({ slot: slot2, spec, Comp })
					}
				}));
			}
			return () => {};
		}
	});
	const overlay = registrations2.find((r) => r.slot === 'shell.overlay');
	const injected = overlay.spec.inject();
	injected.hooks.deleteRequest.set({ sessionId: 'S9', displayTitle: '待删会话' });
	return { Comp: overlay.Comp, injected };
}

{
	const { Comp, injected } = loadWithSeed([false, null, []]);
	const tree = renderDialog(Comp, injected);
	check('有请求时渲染自包含 Modal', elName(tree) === 'Modal', String(elName(tree)));
	check('Modal.open = true', tree.props.open === true);
	check('弹窗标题 = 删除对话', tree.props.title === '删除对话', String(tree.props.title));
	check('弹窗正文含「将永久删除该会话的日志与缓存，无法恢复。」',
		tree.props.description === '将永久删除该会话的日志与缓存，无法恢复。', String(tree.props.description));
	const bodyText = JSON.stringify(tree.props.children);
	check('弹窗正文含 displayTitle', bodyText.includes('待删会话'), bodyText);
	check('弹窗关闭按钮无障碍文案 = 关闭', tree.props.closeLabel === '关闭', String(tree.props.closeLabel));
	// 结构断言（比"身份断言"更强）：展开自包含 Modal，验证真正渲染出的弹窗 DOM 形状。
	{
		const root = expand(tree);
		const dialog = findEl(root, (el) => el?.props?.role === 'dialog');
		check('展开后：根 .dsd-modal-root + 内含 role=dialog[aria-modal=true] 且 aria-label=标题',
			root?.props?.className === 'dsd-modal-root' && dialog?.props?.['aria-modal'] === 'true'
			&& dialog?.props?.['aria-label'] === '删除对话',
			JSON.stringify({ root: root?.props?.className, modal: dialog?.props?.['aria-modal'], label: dialog?.props?.['aria-label'] }));
		check('展开后：h2.dsd-modal-title / p.dsd-modal-description / .dsd-modal-body / .dsd-modal-footer 四件齐全',
			findEl(dialog, (el) => el?.type === 'h2' && el?.props?.className === 'dsd-modal-title')?.props?.children === '删除对话'
			&& findEl(dialog, (el) => el?.props?.className === 'dsd-modal-description') !== null
			&& findEl(dialog, (el) => el?.props?.className === 'dsd-modal-body') !== null
			&& findEl(dialog, (el) => el?.props?.className === 'dsd-modal-footer') !== null);
		const closeBtn = findEl(dialog, (el) => el?.props?.className === 'dsd-modal-close');
		const closeSvg = expand(findComponent(closeBtn, 'IconCloseOutlineRegular'));
		check('展开后：关闭按钮 aria-label=关闭 且含真 svg 图标（自包含 IconCloseOutlineRegular）',
			closeBtn?.props?.['aria-label'] === '关闭' && closeSvg?.type === 'svg' && closeSvg?.props?.viewBox === '0 0 16 16');
	}

	const buttons = tree.props.footer?.props?.children ?? [];
	check('footer 恰好两个按钮', Array.isArray(buttons) && buttons.length === 2, String(buttons?.length));
	check('次按钮（取消）文案 = 取消', buttons?.[0]?.props?.children === '取消', String(buttons?.[0]?.props?.children));
	check('次按钮（取消）默认焦点：带 data-modal-autofocus',
		buttons?.[0]?.props?.['data-modal-autofocus'] === true);
	check('主按钮文案 = 删除', buttons?.[1]?.props?.children === '删除', String(buttons?.[1]?.props?.children));
	check('主按钮危险色 = var(--dsw-alias-state-error-primary)',
		buttons?.[1]?.props?.style?.color === 'var(--dsw-alias-state-error-primary)',
		JSON.stringify(buttons?.[1]?.props?.style));
	check('初始（未删除中）两个按钮都可用',
		buttons?.[0]?.props?.disabled === false && buttons?.[1]?.props?.disabled === false);
}

// ── T5 删除进行中：两键禁用 + 显示「正在删除…」 ───────────────────────
{
	const { Comp, injected } = loadWithSeed([true, null, []]);
	const tree = renderDialog(Comp, injected);
	const buttons = tree.props.footer.props.children;
	check('删除中：取消被禁用', buttons?.[0]?.props?.disabled === true);
	check('删除中：删除被禁用', buttons?.[1]?.props?.disabled === true);
	check('删除中：主按钮文案 = 正在删除…', buttons?.[1]?.props?.children === '正在删除…', String(buttons?.[1]?.props?.children));
	check('删除中：正文也显示 正在删除…', JSON.stringify(tree.props.children).includes('正在删除…'));
	check('删除中：主按钮不再涂危险色（与官方 :not(:disabled) 一致）', buttons?.[1]?.props?.style === undefined);
}

// ── T6 PARTIAL_FAILURE 明细渲染（两种 failed 形状都要能显示）──────────
{
	const { Comp, injected } = loadWithSeed([false, '未完全删除，请查看 failed 明细', [
		{ target: 'C:\\x\\y.json', phase: 'guard', code: 'CACHE_DIR_NOT_A_DIRECTORY', message: 'cache dir is not a directory' },
		{ step: 'unarchiveSession', message: 'registry down' }
	]]);
	const tree = renderDialog(Comp, injected);
	const text = JSON.stringify(tree.props.children);
	check('PARTIAL_FAILURE：错误文案显示', text.includes('未完全删除，请查看 failed 明细'));
	check('PARTIAL_FAILURE：core 形状含 phase/code/target', text.includes('guard') && text.includes('CACHE_DIR_NOT_A_DIRECTORY'));
	check('PARTIAL_FAILURE：注册表形状含 step', text.includes('unarchiveSession'));
	check('PARTIAL_FAILURE：message 一并显示', text.includes('registry down'));
}

// ── T7 fetch 各分支 ─────────────────────────────────────────────────
const fetchCalls = [];
function setFetch(handler) {
	sandbox.fetch = (url, init) => {
		fetchCalls.push({ url, init });
		return Promise.resolve(handler());
	};
}
const respond = (status, body) => ({
	status,
	json: () => (body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(body))
});

/**
 * Task 9：这里**故意**把会话服务摆在手边（带一个会计数的 refresh），然后断言 client.js
 * 从头到尾**根本不去要它**、更不会调用它 —— 这就是"不再拉列表"的行为证据。
 * （静态证据在 T0；"要了但没调"和"压根没要"是两种不同的复辟形态，两层都要有。）
 */
let refreshCount = 0;
const ctx2 = makeCtx({
	sessions: { refresh: () => { refreshCount += 1; return Promise.resolve(); } },
	// 顺带把 scope.get 也接上：**任何**按名字取服务的行为都该被抓住（旧写法是 scope.get("sessions")）
	get: (name) => (name === 'sessions' ? { refresh: () => { refreshCount += 1; } } : undefined)
});
registrations.length = 0;
nestedInjects.length = 0;
exports.apply(ctx2);
check('不再请求 sessions 服务（nestedInjects 里既没有 sessions，也没有别的多余依赖）',
	!nestedInjects.some((n) => n.deps.includes('sessions')),
	JSON.stringify(nestedInjects.map((n) => n.deps)));
check('apply 结束后会话服务的 refresh 一次都没被调用', refreshCount === 0, String(refreshCount));

const overlay2 = registrations.find((r) => r.slot === 'shell.overlay');
const injected2 = overlay2.spec.inject();

// 成功
setFetch(() => respond(200, { ok: true, sessionId: 'S1', logDir: 'removed', alreadyAbsent: false, deleted: ['a'], failed: [], clearedArchive: true, clearedPin: true }));
refreshCount = 0;
fetchCalls.length = 0;
let okResult;
let okError;
await injected2.performSessionDelete('S1').then((r) => { okResult = r; }, (e) => { okError = e; });
check('ok:true → 不抛', okError === undefined, String(okError));
check('ok:true → 透传 host 结果', okResult?.logDir === 'removed');
// ⚠️ 断言已随 Task 9 改写（原为「显式刷新恰好一次」）：那次刷新正是"闪一下"的根因，
// 现在必须**一次都不发生** —— 官方 `api-session/removed` 已经负责把行掉掉，我们不许再拉列表。
check('ok:true → **绝不**调用会话服务的 refresh（拉列表会把 attached 会话的行拉回来）',
	refreshCount === 0, String(refreshCount));
check('请求形状：POST /api/session.delete + json content-type', fetchCalls[0]?.url === '/api/session.delete' &&
	fetchCalls[0]?.init?.method === 'POST' &&
	fetchCalls[0]?.init?.headers?.['content-type'] === 'application/json');
check('请求体 = {"sessionId":"S1"}', fetchCalls[0]?.init?.body === JSON.stringify({ sessionId: 'S1' }), String(fetchCalls[0]?.init?.body));

// SESSION_ACTIVE
setFetch(() => respond(409, { ok: false, code: 'SESSION_ACTIVE', message: '该会话正在运行，请先停止或先归档' }));
refreshCount = 0;
let activeError;
await injected2.performSessionDelete('S2').then(() => {}, (e) => { activeError = e; });
check('SESSION_ACTIVE → reject（不当崩溃）', activeError !== undefined);
check('SESSION_ACTIVE → 文案「该会话正在运行，请先停止或先归档」',
	activeError?.message === '该会话正在运行，请先停止或先归档', activeError?.message);
check('SESSION_ACTIVE → code 保留', activeError?.code === 'SESSION_ACTIVE');
check('SESSION_ACTIVE → 不做刷新（refreshCount 恒为 0）', refreshCount === 0, String(refreshCount));
check('到这里为止任何路径都没刷新过（成功 / SESSION_ACTIVE 两条都覆盖）', refreshCount === 0, String(refreshCount));

// PARTIAL_FAILURE
setFetch(() => respond(500, { ok: false, code: 'PARTIAL_FAILURE', message: '未完全删除，请查看 failed 明细', failed: [{ step: 'unpinSession', message: 'x' }] }));
let partialError;
await injected2.performSessionDelete('S3').then(() => {}, (e) => { partialError = e; });
check('PARTIAL_FAILURE → code 保留', partialError?.code === 'PARTIAL_FAILURE');
check('PARTIAL_FAILURE → failed 明细被带出', Array.isArray(partialError?.failed) && partialError.failed.length === 1,
	JSON.stringify(partialError?.failed));

// INVALID_SESSION_ID
setFetch(() => respond(400, { ok: false, code: 'INVALID_SESSION_ID', message: '会话 id 非法' }));
let invalidError;
await injected2.performSessionDelete('x/y').then(() => {}, (e) => { invalidError = e; });
check('INVALID_SESSION_ID → 显示 host 的 message', invalidError?.message === '会话 id 非法', invalidError?.message);

// 非 JSON（例如 401 的 HTML）
setFetch(() => respond(401, undefined));
let badError;
await injected2.performSessionDelete('S4').then(() => {}, (e) => { badError = e; });
check('非 JSON 响应 → 不崩、给出可读文案', typeof badError?.message === 'string' && badError.message.length > 0, badError?.message);
check('非 JSON 响应 → code 记成 HTTP_401', badError?.code === 'HTTP_401', badError?.code);

// ⚠️ 这一段已随 Task 9 改写（原为「sessions 服务从未到达：删除仍要成功，只是不刷新」）：
// 现在**根本不存在** sessions 接线，所以改成验证"槽位服务迟到时照样注册 + 完全与会话服务无关时删除照常"。
const ctx3 = makeCtx({ hold: ['slots'] });
registrations.length = 0;
nestedInjects.length = 0;
exports.apply(ctx3);
// slots 服务"到达"（嵌套回调在 apply 返回**之后**才触发）
nestedInjects.find((n) => n.deps.includes('slots')).cb(makeScope({ scopeSlots: makeSlots() }));
const injected3 = registrations.find((r) => r.slot === 'shell.overlay').spec.inject();
setFetch(() => respond(200, { ok: true, logDir: 'absent', alreadyAbsent: true, deleted: [], failed: [] }));
let unavailableError;
await injected3.performSessionDelete('S5').then(() => {}, (e) => { unavailableError = e; });
check('完全没有会话服务时删除仍成功（探测不到 attached 也绝不影响删除）', unavailableError === undefined, String(unavailableError));
check('迟到的 slots 服务照样完成三条注册（3 = 菜单-删除 / 菜单-复制 / overlay）', registrations.length === 3,
	JSON.stringify(registrations.map((r) => r.spec?.id)));

// ── T8 防崩：apply 在"服务/槽位不可用"下必须正常返回、绝不外抛 ───────────
// 这一节是 2026-09-26 启动崩溃事故直接教训的回归测试：apply 抛错（或挂未满足的硬门禁让
// entry 停在 pending）⇒ 撞上渲染端「每条 client entry 都必须 active」的全有全无门禁
// ⇒ **整个应用启动中止**。故这些断言全部是「不外抛 + 只打日志 + 能降级」。
/** 捕获 client.js 的 console.error / console.warn（它按 vm 全局解析 `console`，可替换）。 */
function captureConsole(run) {
	const errors = [];
	const warns = [];
	const real = sandbox.console;
	sandbox.console = {
		error: (...args) => errors.push(args.map((a) => String(a)).join(' ')),
		warn: (...args) => warns.push(args.map((a) => String(a)).join(' ')),
		log: (...args) => real.log(...args)
	};
	try {
		run();
	} finally {
		sandbox.console = real;
	}
	return { errors, warns };
}
const sdErrors = (errors) => errors.filter((line) => line.startsWith('[session-delete]'));

// 场景 0：`ctx.inject` 本身抛错（注入机制失效）
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let threw = null;
	const { errors } = captureConsole(() => {
		try {
			exports.apply({ slots: makeSlots(), inject: () => { throw new Error('inject unavailable'); } });
		} catch (error) {
			threw = error;
		}
	});
	check('场景0：ctx.inject 抛错 → apply 正常返回、不外抛', threw === null, String(threw));
	check('场景0：只打日志，且带 [session-delete] 前缀', sdErrors(errors).length === 1, JSON.stringify(errors));
}

// 场景 0b：ctx 连 `inject` 方法都没有（半初始化 / 老运行时）
{
	let threw = null;
	captureConsole(() => {
		try {
			exports.apply({ slots: makeSlots() });
		} catch (error) {
			threw = error;
		}
	});
	check('场景0b：ctx 没有 inject 方法 → apply 正常返回、不外抛', threw === null, String(threw));
}

// 场景 1：`ctx.slots` 为 undefined 且嵌套注入永不回调
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let threw = null;
	const { errors } = captureConsole(() => {
		try {
			exports.apply(makeCtx({ slots: undefined, hold: ['slots', 'sessions'] }));
		} catch (error) {
			threw = error;
		}
	});
	check('场景1：ctx.slots 缺失 + 嵌套注入永不回调 → apply 正常返回、不外抛', threw === null, String(threw));
	check('场景1：没有任何槽位注册、也没有报错刷屏（静默降级）',
		registrations.length === 0 && errors.length === 0,
		`registrations=${String(registrations.length)} errors=${JSON.stringify(errors)}`);
}

// 场景 2：嵌套回调里 `scope.slots.register` 抛错
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let threw = null;
	const attempts = [];
	const exploding = {
		inject: (slot, gen) => {
			attempts.push(slot);
			const it = gen();
			for (let r = it.next(); !r.done; r = it.next());
		},
		register: () => { throw new Error('list slot "x" requires options.id'); }
	};
	const { errors } = captureConsole(() => {
		try {
			exports.apply(makeCtx({ scopeSlots: exploding, hold: ['sessions'] }));
		} catch (error) {
			threw = error;
		}
	});
	check('场景2：register 抛错 → apply 正常返回、不外抛', threw === null, String(threw));
	check('场景2：两处注册各自兜底（两条 [session-delete] 日志）', sdErrors(errors).length === 2, JSON.stringify(errors));
	check('场景2：两处都尝试过（一处失败不阻止另一处）',
		eq(attempts, ['sidebar.workspaces.session.menu.item', 'shell.overlay']), JSON.stringify(attempts));
}

// 场景 2b：只有菜单行那处失败 → 弹窗仍须注册成功
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let threw = null;
	let first = true;
	const flaky = {
		inject: (slot, gen) => {
			if (first) {
				first = false;
				throw new Error('menu slot declaration missing');
			}
			currentSlot = slot;
			const it = gen();
			for (let r = it.next(); !r.done; r = it.next()) {
				registrations.push({ slot, spec: r.value?.spec, Comp: r.value?.Comp });
			}
		},
		register: (spec, Comp) => ({ slot: currentSlot, spec, Comp })
	};
	const { errors } = captureConsole(() => {
		try {
			exports.apply(makeCtx({ scopeSlots: flaky, hold: ['sessions'] }));
		} catch (error) {
			threw = error;
		}
	});
	check('场景2b：菜单行失败时弹窗仍然注册成功（互不连累）',
		threw === null && registrations.length === 1 && registrations[0].slot === 'shell.overlay',
		`threw=${String(threw)} regs=${JSON.stringify(registrations.map((r) => r.slot))}`);
	check('场景2b：只打一条 [session-delete] 日志', sdErrors(errors).length === 1, JSON.stringify(errors));
}

// 场景 3（Task 9 改写：原为「`ctx.inject(["sessions"], …)` 的回调里 scope 抛错」）
// sessions 接线已整体删除 ⇒ 会抛错的 `scope.get` **再也不会被任何调用方碰到**。
// 这比"抛了但被吞掉"更强：路径本身不存在了。
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let threw = null;
	let getCalls = 0;
	const { errors } = captureConsole(() => {
		try {
			exports.apply(makeCtx({ get: () => { getCalls += 1; throw new Error('sessions service unavailable'); } }));
		} catch (error) {
			threw = error;
		}
	});
	check('场景3：sessions 接线已删 ⇒ 会抛错的 scope.get 一次都不会被调用、apply 正常返回',
		threw === null && getCalls === 0, `threw=${String(threw)} getCalls=${String(getCalls)}`);
	check('场景3：也不再为 sessions 打任何日志（正常路径应当零日志）',
		sdErrors(errors).length === 0, JSON.stringify(errors));
}

// 场景 3b（Task 9 改写：原为「迟到的 sessions 回调内抛错也不外抛」）
// "迟到的 sessions 回调"这条路径整体消失 ⇒ 断言它**不存在**；同时把"迟到回调内抛错也算安全"
// 这条既有覆盖平移到**仍然存在**的 slots 回调上（不然就真的丢覆盖了）。
{
	registrations.length = 0;
	nestedInjects.length = 0;
	exports.apply(makeCtx({ hold: ['slots'] }));
	const lateSessions = nestedInjects.find((n) => n.deps.includes('sessions'));
	check('场景3b：不再存在"迟到的 sessions 回调"这条路径（它随接线一起删掉了）',
		lateSessions === undefined, JSON.stringify(nestedInjects.map((n) => n.deps)));
	let lateThrew = null;
	const { errors } = captureConsole(() => {
		try {
			nestedInjects.find((n) => n.deps.includes('slots')).cb(makeScope({
				scopeSlots: {
					inject: (slot, gen) => {
						const it = gen();
						for (let r = it.next(); !r.done; r = it.next());
					},
					register: () => { throw new Error('late slots failure'); }
				}
			}));
		} catch (error) {
			lateThrew = error;
		}
	});
	check('场景3b：迟到的 slots 回调内 register 抛错也不外抛（apply 早已返回）', lateThrew === null, String(lateThrew));
	check('场景3b：两处注册各自兜底 ⇒ 两条 [session-delete] 日志', sdErrors(errors).length === 2, JSON.stringify(errors));
}

// ── T7b 复制会话 ID 行：渲染形状 / 点击顺序 / 剪贴板兜底 / 提示生命期 ────
// 这一节守的是 Task 7 的新功能：菜单行「复制会话 ID」。断言分四组——
//   ① 渲染形状（MenuItemButton + 文案 + 真实图标 + 无门禁 props）
//   ② 点击顺序（先关菜单，再写剪贴板，**必须有反馈**，绝不静默）
//   ③ 剪贴板三级路径（writeText → execCommand 兜底 → 两条都失败也要把 id 摆在屏幕上）
//   ④ 提示生命期（2000ms 自动消失 + 旧计时器不许抹掉新提示 + 与删除弹窗的分派优先级）
const copyNotice = overlayInjected.hooks.copyNotice;
const copySeq = [];
const clipWrites = [];
let docCalls = { execCommand: 0, names: [] };
/** 假 document：只覆盖 `execCommand("copy")` 兜底用到的那几个成员。 */
function makeDocumentStub(execResult) {
	return {
		body: { appendChild: () => {}, removeChild: () => {} },
		createElement: () => ({
			value: '',
			style: {},
			setAttribute: () => {},
			select: () => {},
			setSelectionRange: () => {},
			remove: () => {}
		}),
		execCommand: (name) => {
			docCalls.execCommand += 1;
			docCalls.names.push(name);
			return execResult;
		}
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** 把 overlay 的 Comp 渲染到"叶子"一层，便于对提示/弹窗做结构断言。 */
function renderOverlayTree(injected) {
	const node = overlayReg.Comp({
		useDeleteRequest: (sel) => sel(injected.hooks.deleteRequest.getSnapshot()),
		useCopyNotice: (sel) => sel(injected.hooks.copyNotice.getSnapshot()),
		settleSessionDelete: injected.settleSessionDelete,
		performSessionDelete: injected.performSessionDelete
	});
	if (node === null) return null;
	const inner = typeof node.type === 'function' ? node.type(node.props) : node;
	return { outer: node, inner };
}

// ① 渲染形状。`running: true` 是**故意**传的：复制行不该参与任何门禁（正在运行也能复制）。
// nit N2：复制行缺失时**不许**在这里 TypeError 崩 —— 崩掉会连"总数"一起丢掉、还掩盖后面所有 check。
// 改成：记一条 FAIL，并跳过所有依赖 `copyRow` 的检查（不依赖它的检查照跑）。
const copyRow = menuCopyReg === undefined || typeof menuCopyReg.Comp !== 'function'
	? null
	: menuCopyReg.Comp({
		sessionId: 'S1',
		running: true,
		copySessionId: copyInjected.copySessionId,
		useMenuOpenState: () => [false, (v) => copySeq.push(['close', v])]
	});
if (copyRow === null) {
	check('T7b 前置：复制行注册存在（缺失 ⇒ 下面依赖 copyRow 的检查全部跳过）', false,
		`registrations 里没有 id = session-delete-copy-id 的注册：${JSON.stringify(registrations.map((r) => r.spec?.id))}`);
}
if (copyRow !== null) {
check('复制行用自包含 MenuItemButton 渲染', elName(copyRow) === 'MenuItemButton', String(elName(copyRow)));
check('复制行文案 = 复制会话 ID', copyRow.props.children === '复制会话 ID', String(copyRow.props.children));
check('复制行图标 = IconCopyOutlineRegular（自包含实现）',
	elName(copyRow.props.icon) === 'IconCopyOutlineRegular', String(elName(copyRow.props.icon)));
check('复制行图标 size = 14（与官方行/删除行一致）', copyRow.props.icon?.props?.size === 14);
// 结构断言：复制图标是 rect + path 两块的 svg（与官方 artwork 同形）。
{
	const svg = expand(copyRow.props.icon);
	check('展开后：复制图标 = viewBox 0 0 16 16 / strokeWidth 1 / rect + path 两块',
		svg?.props?.viewBox === '0 0 16 16' && svg?.props?.strokeWidth === 1
		&& Array.isArray(svg?.props?.children) && svg.props.children.length === 2
		&& svg.props.children[0]?.type === 'rect' && svg.props.children[1]?.type === 'path',
		JSON.stringify({ viewBox: svg?.props?.viewBox, kids: svg?.props?.children?.map((k) => k?.type) }));
}
check('复制行不带任何禁用/门禁 props（运行中的会话同样可复制）',
	eq(Object.keys(copyRow.props).sort(), ['children', 'icon', 'onSelect']),
	JSON.stringify(Object.keys(copyRow.props)));
}

if (copyRow !== null) {
// ② 点击：先关菜单 → 立刻出反馈 → 再写剪贴板
copyNotice.set(null);
copySeq.length = 0;
clipWrites.length = 0;
docCalls = { execCommand: 0, names: [] };
sandbox.navigator.clipboard = {
	writeText: (text) => {
		clipWrites.push(text);
		copySeq.push(['clipboard', text]);
		return Promise.resolve();
	}
};
sandbox.document = makeDocumentStub(true);
copyRow.props.onSelect();
check('点击复制行：第一件事是关菜单（setMenuOpen(false)）',
	eq(copySeq[0], ['close', false]), JSON.stringify(copySeq));
const pendingNotice = copyNotice.getSnapshot();
check('点击后**立刻**有反馈（pending 里就带着 sessionId，不存在静默路径）',
	pendingNotice !== null && pendingNotice.sessionId === 'S1', JSON.stringify(pendingNotice));
check('写入剪贴板的内容就是 sessionId（晚于关菜单）',
	clipWrites.length === 1 && clipWrites[0] === 'S1' && copySeq.findIndex((e) => e[0] === 'clipboard') > 0,
	JSON.stringify({ clipWrites, copySeq }));
await tick();
check('剪贴板成功后提示 state = copied',
	copyNotice.getSnapshot()?.state === 'copied', JSON.stringify(copyNotice.getSnapshot()));

// ③a navigator.clipboard 不可用 → 必须落回 execCommand 兜底
copyNotice.set(null);
docCalls = { execCommand: 0, names: [] };
sandbox.navigator.clipboard = undefined;
sandbox.document = makeDocumentStub(true);
copyRow.props.onSelect();
await tick();
check('clipboard API 缺失 → 走 execCommand("copy") 兜底',
	docCalls.execCommand === 1 && docCalls.names[0] === 'copy', JSON.stringify(docCalls));
check('兜底成功 → state 仍为 copied',
	copyNotice.getSnapshot()?.state === 'copied', JSON.stringify(copyNotice.getSnapshot()));

// ③b writeText **抛错**（权限被拒的常见形态）→ 也必须落回兜底，并留一条可诊断日志
copyNotice.set(null);
docCalls = { execCommand: 0, names: [] };
sandbox.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
sandbox.document = makeDocumentStub(true);
{
	// ⚠️ 这里不能复用同步的 `captureConsole`：`copySessionId` 的日志发生在 **await 之后**，
	// 同步版会在 promise 落地前就把 console 还原掉，于是"看起来没打日志"（假阴性，本轮踩过）。
	const warns = [];
	const real = sandbox.console;
	sandbox.console = {
		error: () => {},
		warn: (...args) => warns.push(args.map((a) => String(a)).join(' ')),
		log: (...args) => real.log(...args)
	};
	try {
		copyRow.props.onSelect();
		await tick();
	} finally {
		sandbox.console = real;
	}
	check('writeText 被拒 → 仍走 execCommand 兜底', docCalls.execCommand === 1, JSON.stringify(docCalls));
	check('writeText 被拒 → 打一条可诊断的 [session-delete] warning',
		warns.some((line) => line.startsWith('[session-delete]')), JSON.stringify(warns));
}
check('兜底成功 → state = copied', copyNotice.getSnapshot()?.state === 'copied', JSON.stringify(copyNotice.getSnapshot()));

// ③c 两条路都失败 → 绝不能静默：提示里必须**带着 id** 让用户手动复制
copyNotice.set(null);
docCalls = { execCommand: 0, names: [] };
sandbox.navigator.clipboard = { writeText: () => Promise.reject(new Error('denied')) };
sandbox.document = makeDocumentStub(false);
copyRow.props.onSelect();
await tick();
const manualNotice = copyNotice.getSnapshot();
check('两条路都失败 → state = manual（不是静默失败）',
	manualNotice?.state === 'manual', JSON.stringify(manualNotice));
check('两条路都失败 → 提示里仍带 sessionId', manualNotice?.sessionId === 'S1', JSON.stringify(manualNotice));
} // ← nit N2 的守卫块结束（复制行缺失时 ①②③ 一起跳过）

// ④ 提示渲染：与确认弹窗**复用同一个 overlay entry**，按 store 状态分派
deleteRequest.set(null);
copyNotice.set({ token: 9001, sessionId: 'S1', state: 'copied' });
const copiedTree = renderOverlayTree(overlayInjected);
const copiedText = JSON.stringify(copiedTree?.inner?.props?.children);
check('只有 copyNotice 时，overlay 渲染的是提示（div）而不是确认弹窗',
	copiedTree?.inner?.type === 'div', String(copiedTree?.inner?.type));
check('提示文案含「已复制会话 ID：」', copiedText.includes('已复制会话 ID'), copiedText);
check('提示文案里带 sessionId', copiedText.includes('S1'), copiedText);
{
	// "绝不让用户拿不到 id"的最后一道保险必须**可选中** —— 这也是**不用**官方 Toast 的原因：
	// 官方 `.toast` 是 `pointer-events: none`（`ui-primitives/lib/Toast.module.css:14`），
	// 横幅点不动、文字选不中，最坏情况下用户只能靠肉眼抄。
	const idNode = (copiedTree?.inner?.props?.children ?? []).find((child) => child?.type === 'code');
	check('提示里的 id 是 <code> 且可选中（userSelect: all）',
		idNode?.props?.style?.userSelect === 'all', JSON.stringify(idNode?.props?.style));
}
copyNotice.set({ token: 9002, sessionId: 'S1', state: 'manual' });
const manualTree = renderOverlayTree(overlayInjected);
const manualText = JSON.stringify(manualTree?.inner?.props?.children);
check('失败态提示文案含「请手动复制」', manualText.includes('请手动复制'), manualText);
check('失败态提示里仍带 sessionId（绝不让用户拿不到）', manualText.includes('S1'), manualText);
check('失败态提示仍不是确认弹窗', manualTree?.inner?.type === 'div', String(manualTree?.inner?.type));

// 优先级：删除确认绝不能被一条 2 秒的提示盖住
deleteRequest.set({ sessionId: 'S9', displayTitle: '待删会话' });
copyNotice.set({ token: 9003, sessionId: 'S1', state: 'copied' });
const bothTree = renderOverlayTree(overlayInjected);
check('删除请求与复制提示同时在时，确认弹窗优先（Modal）',
	elName(bothTree?.inner) === 'Modal', String(elName(bothTree?.inner)));
deleteRequest.set(null);
copyNotice.set(null);
check('两个 store 都空 → overlay 渲染 null', renderOverlayTree(overlayInjected) === null);

// 兜底：renderer 没给 useCopyNotice 时（老渲染路径 / 离线台），删除弹窗仍必须能渲染
deleteRequest.set({ sessionId: 'S9', displayTitle: '待删会话' });
{
	let threw = null;
	let node;
	try {
		node = overlayReg.Comp({
			useDeleteRequest: (sel) => sel(deleteRequest.getSnapshot()),
			settleSessionDelete: overlayInjected.settleSessionDelete,
			performSessionDelete: overlayInjected.performSessionDelete
		});
	} catch (error) {
		threw = error;
	}
	check('useCopyNotice 缺失时 overlay 仍能渲染删除弹窗（不外抛）',
		threw === null && node !== null && typeof node.type === 'function', String(threw));
}
deleteRequest.set(null);
{
	let threw = null;
	let node;
	try {
		node = overlayReg.Comp({
			useDeleteRequest: (sel) => sel(deleteRequest.getSnapshot()),
			settleSessionDelete: overlayInjected.settleSessionDelete,
			performSessionDelete: overlayInjected.performSessionDelete
		});
	} catch (error) {
		threw = error;
	}
	check('useCopyNotice 缺失 + 无删除请求 → 渲染 null、不抛', threw === null && node === null, String(threw));
}

// ⑤ 提示生命期：2000ms 自动消失；旧计时器不许抹掉更新的提示
// ⚠️ Task 9 起这条（**复制提示**的 2 秒自动消失）必须原样保留：删除结果改在弹窗里持久显示，
//    但"复制会话 ID"是另一条路径，它的 2 秒反馈与 2000ms 这个常量都不许跟着一起被删掉。
if (copyRow !== null) {
copyNotice.set(null);
sandbox.navigator.clipboard = { writeText: () => Promise.resolve() };
sandbox.document = makeDocumentStub(true);
const timersBefore = timers.length;
copyRow.props.onSelect();
check('点击时排了一个自动消失计时器', timers.length === timersBefore + 1, String(timers.length - timersBefore));
check('自动消失延时 = 2000ms', timers.at(-1).ms === 2000, String(timers.at(-1).ms));
const staleTimer = timers.at(-1);
await tick();
check('到期前提示还在', copyNotice.getSnapshot() !== null, JSON.stringify(copyNotice.getSnapshot()));
copyRow.props.onSelect();
const latestTimer = timers.at(-1);
await tick();
staleTimer.fn();
check('旧计时器到期**不会**抹掉更新的提示（竞态守卫）',
	copyNotice.getSnapshot() !== null, JSON.stringify(copyNotice.getSnapshot()));
latestTimer.fn();
check('最新计时器到期后提示消失（store → null）',
	copyNotice.getSnapshot() === null, JSON.stringify(copyNotice.getSnapshot()));
}


// 强断言：绝不直接使用裸的 `ctx.slots`（顶层 slots 陷阱化后仍须注册成功）
{
	registrations.length = 0;
	nestedInjects.length = 0;
	let trapTouched = false;
	const trapped = {
		get inject() { trapTouched = true; throw new Error('bare ctx.slots accessed'); },
		get register() { trapTouched = true; throw new Error('bare ctx.slots accessed'); }
	};
	let threw = null;
	captureConsole(() => {
		try {
			exports.apply(makeCtx({ slots: trapped, scopeSlots: makeSlots(), hold: ['sessions'] }));
		} catch (error) {
			threw = error;
		}
	});
	check('绝不直接使用 ctx.slots：顶层 slots 陷阱化后三条 entry 仍注册成功',
		threw === null && trapTouched === false && registrations.length === 3,
		`threw=${String(threw)} trapTouched=${String(trapTouched)} regs=${String(registrations.length)}`);
}

// ── T9 级联删除的客户端半边（Task 8）+ attached 如实上报（Task 9）─────
// 契约（与 host 的 Task 8/9 语义一一对应）：
//   ① 点「删除对话」→ 关菜单 → **同时**打开弹窗并发起 dryRun（异步、不阻塞弹窗打开）；
//   ② dryRun 的形状 = POST /api/session.delete + `{ sessionId, dryRun: true }`，且**只有**它带 dryRun；
//   ③ 状态行四态：统计中 / 无法判定（不影响删除）/ 将一并删除 N 个 / 有 N 个在运行（**警告**）；
//   ④ 只要没有子会话在跑，删除键就必须可用 —— dryRun 失败或超时都**绝不阻挡删除**；
//   ⑤（Task 9 改写）真删成功 ⇒ 弹窗**不自动关闭**，就地进入**结果态**（结果 + 一个「关闭」按钮），
//      文案按宿主回的 `attached` 分三支（true / false / 缺字段=兜底），且删除**不再**刷新列表；
//   ⑥（Task 8 保留）确认弹窗里列出将被一并删除的子会话 ID（dryRun 的 children.ids，可选中、超量截断）；
//   ⑦（Task 8 保留）renderer 没给 hook 时全部降级、绝不抛。
console.log('\n== T9 级联删除（dryRun 统计 / 状态行 / 删除键门禁 / 成功提示）==');

const planStore = overlayInjected.hooks.deletePlan;
const resultStore = overlayInjected.hooks.deleteResult;
check('T9：overlay inject 暴露 hooks.deletePlan（计划与待删请求是**两个** store）',
	typeof planStore?.getSnapshot === 'function' && planStore !== deleteRequest,
	JSON.stringify(Object.keys(overlayInjected.hooks ?? {})));
check('T9：overlay inject 暴露 hooks.deleteResult（成功提示）',
	typeof resultStore?.getSnapshot === 'function', JSON.stringify(Object.keys(overlayInjected.hooks ?? {})));

/** 渲染 overlay 到"叶子"一层；四个 store 全接上（缺任何一个都会走降级分支）。 */
function renderOverlay(injected) {
	const node = overlayReg.Comp({
		useDeleteRequest: (sel) => sel(injected.hooks.deleteRequest.getSnapshot()),
		useDeletePlan: (sel) => sel(injected.hooks.deletePlan.getSnapshot()),
		useDeleteResult: (sel) => sel(injected.hooks.deleteResult.getSnapshot()),
		useCopyNotice: (sel) => sel(injected.hooks.copyNotice.getSnapshot()),
		settleSessionDelete: injected.settleSessionDelete,
		performSessionDelete: injected.performSessionDelete
	});
	if (node === null) return null;
	return typeof node.type === 'function' ? node.type(node.props) : node;
}
/** 弹窗正文里所有字符串行（用于断言"有/没有那一行"）。 */
const bodyTexts = (tree) => (tree?.props?.children ?? [])
	.map((child) => (typeof child?.props?.children === 'string' ? child.props.children : null))
	.filter((text) => text !== null);
/** 状态行的标记词：只有这四个开局才算"那一行"。 */
const PLAN_MARKERS = ['正在统计', '无法判定子代理会话', '将一并删除', '正在运行'];
const planNodes = (tree) => (tree?.props?.children ?? []).filter(
	(child) => typeof child?.props?.children === 'string' && PLAN_MARKERS.some((marker) => child.props.children.includes(marker))
);
const deleteButtonOf = (tree) => tree?.props?.footer?.props?.children?.[1];

/** 可控 fetch：**先不 resolve**（模拟"统计还在路上"），由用例显式放行。 */
const pendingFetches = [];
function setDeferredFetch() {
	pendingFetches.length = 0;
	fetchCalls.length = 0;
	sandbox.fetch = (url, init) => {
		fetchCalls.push({ url, init });
		return new Promise((resolve) => { pendingFetches.push(resolve); });
	};
}
/** 放行最后一个挂起的请求，并等它的 .then 落地。 */
async function releaseLastFetch(response) {
	pendingFetches.at(-1)(response);
	await tick();
	await tick();
}

/** 菜单行（删除那条）绑到当前实例的 requestSessionDelete 上。 */
function clickDeleteRow(sessionId = 'S1', displayTitle = '标题A') {
	deleteRequest.set(null);
	const rowSeq = [];
	menuReg.Comp({
		sessionId,
		displayTitle,
		requestSessionDelete: menuInjected.requestSessionDelete,
		useMenuOpenState: () => [false, (v) => rowSeq.push(['close', v])]
	}).props.onSelect();
	return rowSeq;
}

// ① 时机：弹窗先开、统计后到；请求形状带 dryRun
{
	const clickSeq = clickDeleteRow();
	check('T9①：点击的第一件事仍是关菜单（setMenuOpen(false)）', eq(clickSeq, [['close', false]]), JSON.stringify(clickSeq));
	setDeferredFetch();
	planStore.set(null);
	const clickSeq2 = clickDeleteRow();
	check('T9①：dryRun 发起时弹窗**已经**打开（请求没回来也照样开）',
		deleteRequest.getSnapshot() !== null && eq(deleteRequest.getSnapshot(), { sessionId: 'S1', displayTitle: '标题A' }),
		JSON.stringify(deleteRequest.getSnapshot()));
	check('T9①：关菜单仍是第一步', eq(clickSeq2, [['close', false]]), JSON.stringify(clickSeq2));
	check('T9①：恰好发起一次统计请求', fetchCalls.length === 1, String(fetchCalls.length));
	const dryCall = fetchCalls[0];
	check('T9①：统计请求形状 = POST /api/session.delete + application/json',
		dryCall?.url === '/api/session.delete' && dryCall?.init?.method === 'POST' &&
			dryCall?.init?.headers?.['content-type'] === 'application/json',
		JSON.stringify(dryCall));
	check('T9①：统计请求体 = { sessionId, dryRun: true }',
		eq(JSON.parse(dryCall?.init?.body ?? 'null'), { sessionId: 'S1', dryRun: true }), String(dryCall?.init?.body));
	check('T9①：统计未回来时状态 = loading', planStore.getSnapshot()?.state === 'loading', JSON.stringify(planStore.getSnapshot()));
	const loadingTree = renderOverlay(overlayInjected);
	check('T9①：统计中显示「正在统计子代理会话…」',
		bodyTexts(loadingTree).includes('正在统计子代理会话…'), JSON.stringify(bodyTexts(loadingTree)));
	check('T9①：统计中**不**禁用删除键（统计没回来不能挡删除）',
		deleteButtonOf(loadingTree)?.props?.disabled === false);

	// 统计回来：两个子会话
	await releaseLastFetch(respond(200, {
		ok: true, dryRun: true, sessionId: 'S1', targetBytes: 12,
		children: { total: 2, ids: ['c1', 'c2'], bytes: 5, running: [] }, cascade: 'ok'
	}));
	const readyTree = renderOverlay(overlayInjected);
	check('T9①：统计回来后状态行 = 「将一并删除 2 个子代理会话」',
		bodyTexts(readyTree).includes('将一并删除 2 个子代理会话'), JSON.stringify(bodyTexts(readyTree)));
	check('T9①：确认删除时**不再**重复统计（dryRun 只发一次）',
		fetchCalls.filter((call) => String(call.init?.body).includes('dryRun')).length === 1,
		JSON.stringify(fetchCalls.map((call) => call.init?.body)));
	check('T9①：状态行不是错误色（普通信息行）',
		planNodes(readyTree)[0]?.props?.style?.color === 'var(--dsw-alias-label-tertiary)',
		JSON.stringify(planNodes(readyTree)[0]?.props?.style));
}

// ③ 四种状态行 + 删除键门禁
const planCases = [
	{
		label: '统计中',
		plan: { token: 101, state: 'loading', sessionId: 'S1' },
		expectLine: '正在统计子代理会话…', disabled: false, warn: false
	},
	{
		label: '没有子会话（total=0）',
		plan: { token: 102, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'none', children: { total: 0, ids: [], bytes: 0, running: [] } } },
		expectLine: null, disabled: false, warn: false
	},
	{
		label: 'cascade=none',
		plan: { token: 103, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'none', children: { total: 0, ids: [], bytes: 0, running: [] } } },
		expectLine: null, disabled: false, warn: false
	},
	{
		label: '无法判定',
		plan: { token: 104, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'unavailable', cascadeReason: 'IDENTITY_UNAVAILABLE', children: { total: 0, ids: [], bytes: 0, running: [] } } },
		expectLine: '无法判定子代理会话（不影响删除）', disabled: false, warn: false
	},
	{
		label: '有子会话且都不在跑',
		plan: { token: 105, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 3, ids: ['c1', 'c2', 'c3'], bytes: 9, running: [] } } },
		expectLine: '将一并删除 3 个子代理会话', disabled: false, warn: false
	},
	{
		label: '有子会话在运行',
		plan: { token: 106, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 3, ids: ['c1', 'c2', 'c3'], bytes: 9, running: ['c3'] } } },
		expectLine: '有 1 个子代理会话正在运行，需等它们结束', disabled: true, warn: true
	},
	{
		label: '计划缺失/形状漂移（没有 children 字段）',
		plan: { token: 107, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true } },
		expectLine: null, disabled: false, warn: false
	},
	{
		label: 'dryRun 失败（降级为未统计）',
		plan: { token: 108, state: 'failed', sessionId: 'S1' },
		expectLine: null, disabled: false, warn: false
	}
];
for (const planCase of planCases) {
	planStore.set(planCase.plan);
	const tree = renderOverlay(overlayInjected);
	const lines = planNodes(tree).map((node) => node.props.children);
	if (planCase.expectLine === null) {
		check(`T9③「${planCase.label}」：**不显示**状态行（保持干净）`, lines.length === 0, JSON.stringify(bodyTexts(tree)));
	} else {
		check(`T9③「${planCase.label}」：状态行 = 「${planCase.expectLine}」`,
			lines.length === 1 && lines[0] === planCase.expectLine, JSON.stringify(lines));
	}
	check(`T9③「${planCase.label}」：删除键 disabled = ${String(planCase.disabled)}`,
		deleteButtonOf(tree)?.props?.disabled === planCase.disabled, String(deleteButtonOf(tree)?.props?.disabled));
	if (planCase.warn) {
		check(`T9③「${planCase.label}」：状态行是**警告**色（错误色 token）`,
			planNodes(tree)[0]?.props?.style?.color === 'var(--dsw-alias-state-error-primary)',
			JSON.stringify(planNodes(tree)[0]?.props?.style));
	}
	check(`T9③「${planCase.label}」：取消键始终可用`, tree?.props?.footer?.props?.children?.[0]?.props?.disabled === false);
}

// ④ dryRun 的每一条失败路径都不得阻挡删除
for (const [label, handler] of [
	['请求 reject', () => Promise.reject(new Error('network down'))],
	['HTTP 500 + ok:false', () => respond(500, { ok: false, code: 'BOOM', message: '统计挂了' })],
	['非 JSON 响应', () => respond(200, undefined)],
	['200 但不是 dryRun 载荷', () => respond(200, { ok: true })]
]) {
	planStore.set(null);
	setFetch(handler);
	clickDeleteRow();
	await tick();
	await tick();
	check(`T9④「${label}」：计划降级为 failed（不是"没有子会话"）`,
		planStore.getSnapshot()?.state === 'failed', JSON.stringify(planStore.getSnapshot()));
	const tree = renderOverlay(overlayInjected);
	check(`T9④「${label}」：不显示状态行、删除键仍可用`,
		planNodes(tree).length === 0 && deleteButtonOf(tree)?.props?.disabled === false,
		`lines=${JSON.stringify(planNodes(tree).map((n) => n.props.children))} disabled=${String(deleteButtonOf(tree)?.props?.disabled)}`);
	// 真删照常走通
	setFetch(() => respond(200, {
		ok: true, sessionId: 'S1', logDir: 'removed',
		children: { total: 0, deleted: [], skipped: [], failed: [], freedBytes: 0 }, cascade: 'none'
	}));
	let failureError;
	await overlayInjected.performSessionDelete('S1').then(() => {}, (error) => { failureError = error; });
	check(`T9④「${label}」：真删仍然成功（统计失败绝不阻挡删除）`, failureError === undefined, String(failureError));
}

// ④b 超时：不能永远转圈，也不能因此上锁
{
	planStore.set(null);
	setDeferredFetch();
	const timersBefore = timers.length;
	clickDeleteRow();
	const planTimer = timers.at(-1);
	check('T9④b：统计有超时上限（5000ms）', planTimer?.ms === 5000, String(planTimer?.ms));
	check('T9④b：超时前是"统计中"', planStore.getSnapshot()?.state === 'loading' && timers.length === timersBefore + 1);
	planTimer.fn();
	check('T9④b：超时 ⇒ 降级为未统计（状态行消失）',
		planNodes(renderOverlay(overlayInjected)).length === 0, JSON.stringify(planStore.getSnapshot()));
	check('T9④b：超时后删除键仍可用', deleteButtonOf(renderOverlay(overlayInjected))?.props?.disabled === false);
	// 迟到的统计响应**不许**复活状态行
	await releaseLastFetch(respond(200, {
		ok: true, dryRun: true, sessionId: 'S1',
		children: { total: 2, ids: ['c1', 'c2'], bytes: 1, running: [] }, cascade: 'ok'
	}));
	check('T9④b：超时之后迟到的响应不会复活状态行（token 守卫）',
		planNodes(renderOverlay(overlayInjected)).length === 0, JSON.stringify(planStore.getSnapshot()));
}

// ④c 统计还在路上时也能删（不 await 统计）
{
	planStore.set(null);
	setDeferredFetch();
	clickDeleteRow();
	check('T9④c：统计 pending 时删除键仍可用（绝不 await 统计）',
		deleteButtonOf(renderOverlay(overlayInjected))?.props?.disabled === false);
	setFetch(() => respond(200, {
		ok: true, sessionId: 'S1', logDir: 'removed',
		children: { total: 0, deleted: [], skipped: [], failed: [], freedBytes: 0 }, cascade: 'none'
	}));
	let pendingError;
	await overlayInjected.performSessionDelete('S1').then(() => {}, (error) => { pendingError = error; });
	check('T9④c：统计 pending 时真删照样成功', pendingError === undefined, String(pendingError));
}

// ⑤ 成功 ⇒ 弹窗**不自动关闭** + 就地进入结果态（Task 9 的核心契约）
//    这条**取代**了 Task 8 的"弹一条 2 秒成功提示"：那次提示既留不住（2 秒就没了），
//    也没说清"侧栏那一行其实还在"的实情 —— 而用户反复点删除、"闪一下"的困惑正来自这里。
{
	deleteRequest.set(null);
	planStore.set(null);
	overlayInjected.hooks.copyNotice.set(null);
	resultStore.set(null);
	setFetch(() => respond(200, {
		ok: true, sessionId: 'S1', logDir: 'removed', attached: false,
		children: { total: 2, deleted: ['c1', 'c2'], skipped: [], failed: [], freedBytes: 9, attached: [] }, cascade: 'ok'
	}));
	// 走**真实链路**：点菜单行（写入请求 + 发起 dryRun）→ 点弹窗里的「删除」→ confirm() → performSessionDelete
	clickDeleteRow('S1', '标题A');
	await tick();
	await tick();
	const confirmTree = renderOverlay(overlayInjected);
	check('T9⑤：真实链路的起点是确认态（删除键可点）',
		typeof deleteButtonOf(confirmTree)?.props?.onClick === 'function',
		String(deleteButtonOf(confirmTree)?.props?.children));
	deleteButtonOf(confirmTree).props.onClick();
	await tick();
	await tick();
	await tick();
	check('T9⑤：删除成功后弹窗**不自动关闭**（待删请求仍在 store 里）',
		deleteRequest.getSnapshot() !== null, JSON.stringify(deleteRequest.getSnapshot()));
	const tree = renderOverlay(overlayInjected);
	// 用 String(...) 兜一层：实现错时这里要**报红**，而不是让验证台自己抛异常（那样会丢掉总数）。
	const text = String(JSON.stringify(tree?.props?.children) ?? '');
	check('T9⑤：成功后就地进入结果态（仍是同一个 Modal，不是换成一条 2 秒提示）',
		elName(tree) === 'Modal', String(elName(tree)));
	check('T9⑤：结果态含「已删除会话：」', text.includes('已删除会话：'), text);
	check('T9⑤：结果态含 sessionId', text.includes('S1'), text);
	check('T9⑤：结果态含「（含 2 个子代理会话）」', text.includes('（含 2 个子代理会话）'), text);
	const notice = resultStore.getSnapshot();
	check('T9⑤：结果 store 记下 attached=false 与子会话数 2',
		notice?.state === 'deleted' && notice?.children === 2 && notice?.attached === false, JSON.stringify(notice));
	const buttons = tree?.props?.footer?.props?.children ?? [];
	const closeButton = Array.isArray(buttons) ? buttons[0] : undefined;
	check('T9⑤：结果态 footer 只剩「关闭」一个按钮',
		buttons.length === 1 && closeButton?.props?.children === '关闭',
		JSON.stringify(buttons.map((b) => b?.props?.children)));
	check('T9⑤：结果态的「关闭」带默认焦点（data-modal-autofocus）',
		closeButton?.props?.['data-modal-autofocus'] === true);
	// 守卫：实现错（结果态没有关闭键）时要**报红**，而不是让验证台自己抛 TypeError（那样会丢掉总数）
	if (typeof closeButton?.props?.onClick === 'function') closeButton.props.onClick();
	check('T9⑤：点「关闭」才结算：请求与结果一起清空、overlay 回到 null',
		deleteRequest.getSnapshot() === null && resultStore.getSnapshot() === null && renderOverlay(overlayInjected) === null,
		`request=${JSON.stringify(deleteRequest.getSnapshot())} result=${JSON.stringify(resultStore.getSnapshot())}`);
}

// ⑤b 没删到子会话 ⇒ 结果态照样出现（如实告知已删），但**不声称**删掉了子会话
{
	deleteRequest.set(null);
	planStore.set(null);
	resultStore.set(null);
	setFetch(() => respond(200, {
		ok: true, sessionId: 'S1', logDir: 'absent', alreadyAbsent: true, attached: false,
		children: { total: 0, deleted: [], skipped: [], failed: [], freedBytes: 0, attached: [] }, cascade: 'none'
	}));
	const deleted = await overlayInjected.performSessionDelete('S1');
	check('T9⑤b：没删到子会话 ⇒ ok:true 且 children.deleted 为空',
		deleted?.children?.deleted?.length === 0, JSON.stringify(deleted));
	// 结果 store 的唯一写入点就是 performSessionDelete（真实链路由弹窗的删除键触发它），
	// 这里直接调它、再补上"请求还在"这个前提，等价于结果态被渲染出来的那一刻。
	deleteRequest.set({ sessionId: 'S1', displayTitle: '标题A' });
	const tree = renderOverlay(overlayInjected);
	const text = String(JSON.stringify(tree?.props?.children) ?? '');
	check('T9⑤b：结果态**不**声称「含 N 个子代理会话」（没删到就不许说）',
		!text.includes('（含 ') && !text.includes('个子代理会话）'), text);
	check('T9⑤b：但仍如实显示「已删除会话：」（不再是一条转瞬即逝的提示）',
		text.includes('已删除会话：') && text.includes('S1'), text);
	deleteRequest.set(null);
	resultStore.set(null);
}

// ⑤c 删除请求结算时，计划与结果必须一起清掉（否则下一行菜单会看到上一行的统计/结果）
{
	planStore.set({ token: 900, state: 'ready', sessionId: 'S9', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 1, ids: ['x'], bytes: 1, running: [] } } });
	resultStore.set({ token: 901, sessionId: 'S9', state: 'deleted', attached: false, children: 0 });
	overlayInjected.settleSessionDelete();
	check('T9⑤c：settleSessionDelete 同时清掉待删请求、统计计划与结果',
		deleteRequest.getSnapshot() === null && planStore.getSnapshot() === null && resultStore.getSnapshot() === null,
		`request=${JSON.stringify(deleteRequest.getSnapshot())} plan=${JSON.stringify(planStore.getSnapshot())} result=${JSON.stringify(resultStore.getSnapshot())}`);
}

// ⑥ 防崩：renderer 没给 useDeletePlan / useDeleteResult 时仍能渲染
{
	deleteRequest.set({ sessionId: 'S1', displayTitle: '标题A' });
	let threw = null;
	let node;
	try {
		node = overlayReg.Comp({
			useDeleteRequest: (sel) => sel(deleteRequest.getSnapshot()),
			settleSessionDelete: overlayInjected.settleSessionDelete,
			performSessionDelete: overlayInjected.performSessionDelete
		});
	} catch (error) {
		threw = error;
	}
	check('T9⑥：useDeletePlan/useDeleteResult 缺失时 overlay 仍能渲染确认弹窗（降级不抛）',
		threw === null && node !== null && typeof node.type === 'function', String(threw));
	deleteRequest.set(null);
}

// ⑦ attached 三态文案（Task 9 的核心：**如实**且**持久**）
//    宿主在删除响应里带 `attached`（true / false / 缺字段=判不了），客户端分三支文案；
//    三支**互斥** —— 绝不把"行会一直在"说成"已删除会话"（那正是用户被误导的形态），
//    也绝不在判不了的时候冒充 true 或 false。
console.log('\n== T9⑦ attached 三态文案（如实 + 持久）==');

/** 造出"删除成功后的结果态"：请求还在（弹窗不自动关）+ 结果 store 有值。 */
function renderResultState(fields, sessionId = 'S1') {
	deleteRequest.set({ sessionId, displayTitle: '标题A' });
	resultStore.set(Object.assign({ token: 7001, sessionId, state: 'deleted' }, fields));
	return renderOverlay(overlayInjected);
}
/** 弹窗正文的字符串（用于断言文案；footer 不在里面）。 */
const bodyOf = (tree) => String(JSON.stringify(tree?.props?.children) ?? '');

{
	const tree = renderResultState({ attached: true });
	const text = bodyOf(tree);
	check('T9⑦ attached=true：首句就说清"磁盘已删"', text.includes('已删除磁盘数据'), text);
	check('T9⑦ attached=true：点明"打开过 / 仍驻留在内存中"',
		text.includes('打开过') && text.includes('仍驻留在内存中'), text);
	check('T9⑦ attached=true：直说"侧栏条目会一直显示"', text.includes('侧栏条目会一直显示'), text);
	check('T9⑦ attached=true：给出两条出路（关闭它的标签页 / 重启 DSH）',
		text.includes('关闭它的标签页') && text.includes('重启 DSH'), text);
	check('T9⑦ attached=true：**不**串到 attached=false 那一支（串档 = 把实情说成"已删除会话"）',
		!text.includes('已删除会话：'), text);
	check('T9⑦ 结果态不再挂「将永久删除…」那句前瞻描述（已经删完了，那句话就不对了）',
		tree?.props?.description === undefined, String(tree?.props?.description));
}
{
	const text = bodyOf(renderResultState({ attached: false, children: 2 }));
	check('T9⑦ attached=false：文案 = 「已删除会话：<id>」', text.includes('已删除会话：') && text.includes('S1'), text);
	check('T9⑦ attached=false：带子会话数「（含 2 个子代理会话）」', text.includes('（含 2 个子代理会话）'), text);
	check('T9⑦ attached=false：**不**出现 attached=true 的警告语（串档）',
		!text.includes('已删除磁盘数据') && !text.includes('侧栏条目会一直显示'), text);
	check('T9⑦ attached=false：也**不**出现通用兜底语（三支互斥）', !text.includes('若该会话仍显示在侧栏'), text);
}
for (const [label, fields] of [
	['缺字段（JSON 把 undefined 丢掉了）', {}],
	['显式 undefined', { attached: undefined }],
	['形状漂移（字符串 "true"）', { attached: 'true' }],
	['形状漂移（数字 1）', { attached: 1 }]
]) {
	const text = bodyOf(renderResultState(fields));
	check(`T9⑦ attached ${label} ⇒ 只报「已删除」（不再有"重启 DSH"兜底语，2026-09-27 用户要求）`, text.includes('已删除') && !text.includes('重启 DSH'), text);
	check(`T9⑦ attached ${label} ⇒ 不冒充 true（不许出现"已删除磁盘数据"）`, !text.includes('已删除磁盘数据'), text);
	check(`T9⑦ attached ${label} ⇒ 不冒充 false（不许出现"已删除会话："）`, !text.includes('已删除会话：'), text);
}

// ⑦b 打开**新**一次删除时必须从干净的确认态开始（不能把上一次的结果带进来）
{
	deleteRequest.set(null);
	resultStore.set({ token: 7002, sessionId: 'S0', state: 'deleted', attached: true });
	menuInjected.requestSessionDelete('S2', '标题B');
	check('T9⑦b 新请求清掉上一次的结果（否则下一行菜单会看到上一次的删除结果）',
		resultStore.getSnapshot() === null && deleteRequest.getSnapshot()?.sessionId === 'S2',
		JSON.stringify({ result: resultStore.getSnapshot(), request: deleteRequest.getSnapshot() }));
}

// ⑧ 子会话仍 attached：用户当时正在看的**可能正是子会话**（grace）⇒ 也要如实点名
{
	const text = bodyOf(renderResultState({ attached: false, children: 2, childrenAttached: 1 }));
	check('T9⑧ 子会话仍 attached ⇒ 追加一行点名（只说数量，不堆 id）',
		text.includes('其中 1 个子代理会话仍驻留在内存中'), text);
	check('T9⑧ 该行也说清后果（关闭标签页 / 重启 DSH）', text.includes('关闭标签页或重启 DSH'), text);
	const none = bodyOf(renderResultState({ attached: false, children: 2, childrenAttached: 0 }));
	check('T9⑧ childrenAttached=0 ⇒ 不出现该行（避免噪音）', !none.includes('仍驻留在内存中'), none);
	const missing = bodyOf(renderResultState({ attached: false, children: 2 }));
	check('T9⑧ 缺 childrenAttached 字段 ⇒ 不出现该行（形状漂移安全降级）', !missing.includes('仍驻留在内存中'), missing);
	const many = bodyOf(renderResultState({ attached: false, children: 2, childrenAttached: 3 }));
	check('T9⑧ 多个子会话仍 attached ⇒ 数字跟着变', many.includes('其中 3 个子代理会话仍驻留在内存中'), many);
}

// ⑨ 确认弹窗里列出「将被一并删除的子会话 ID」（用户已定；数据源是 dryRun 已返回的 children.ids）
console.log('\n== T9⑨ 确认弹窗里的子会话 ID 清单 ==');

/** 找正文里那个"列 id"的容器（一个含 <code> 的 div；失败明细那个 div 里没有 code）。 */
const childListOf = (tree) => (tree?.props?.children ?? []).find(
	(child) => child?.type === 'div' && Array.isArray(child?.props?.children) &&
		child.props.children.some((node) => node?.type === 'code')
);
const codesOf = (list) => (list?.props?.children ?? []).filter((node) => node?.type === 'code');

// ⑨a 清单**必须**复用同一个 overlay entry：不能为它再加一个 entry
{
	const localRegs = [];
	const localSlots = {
		inject: (slot, gen) => {
			currentSlot = slot;
			const it = gen();
			for (let r = it.next(); !r.done; r = it.next()) {
				localRegs.push({ slot, spec: r.value?.spec, Comp: r.value?.Comp });
			}
		},
		register: (spec, Comp) => ({ slot: currentSlot, spec, Comp })
	};
	exports.apply(makeCtx({ scopeSlots: localSlots }));
	check('T9⑨ 子会话 ID 清单复用同一个 overlay entry（总数仍 3、overlay 仍 1）',
		localRegs.length === 3 && localRegs.filter((r) => r.slot === 'shell.overlay').length === 1,
		JSON.stringify(localRegs.map((r) => r.spec?.id)));
}

// ⑨b 正常列出 + 可选中
{
	deleteRequest.set({ sessionId: 'S1', displayTitle: '标题A' });
	resultStore.set(null);
	planStore.set({ token: 810, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 2, ids: ['c1', 'c2'], bytes: 9, running: [] } } });
	const tree = renderOverlay(overlayInjected);
	const list = childListOf(tree);
	check('T9⑨ 有子会话 ⇒ 正文里出现 id 清单容器', list !== undefined, bodyOf(tree));
	const codes = codesOf(list);
	check('T9⑨ 逐个列出（2 个，顺序与 children.ids 一致）',
		codes.length === 2 && codes.map((node) => node.props.children).join(',') === 'c1,c2',
		JSON.stringify(codes.map((node) => node.props.children)));
	check('T9⑨ 每个 id 都是 <code> + userSelect:"all"（可选中 / 可复制）',
		codes.every((node) => node.props.style?.userSelect === 'all'), JSON.stringify(codes.map((n) => n.props.style)));
	check('T9⑨ 清单**不**伪装成状态行（否则会把 PLAN_MARKERS 那几条断言串档）',
		planNodes(tree).length === 1, JSON.stringify(planNodes(tree).map((n) => n.props.children)));
}

// ⑨c 超量截断：前 10 个 + 「等 N 个」
{
	const ids = Array.from({ length: 12 }, (_, index) => `c${index + 1}`);
	planStore.set({ token: 811, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 12, ids, bytes: 1, running: [] } } });
	const tree = renderOverlay(overlayInjected);
	const list = childListOf(tree);
	const codes = codesOf(list);
	check('T9⑨ 超量截断：只渲染前 10 个', codes.length === 10, String(codes.length));
	check('T9⑨ 超量截断：前 10 个就是 c1..c10',
		codes[0]?.props?.children === 'c1' && codes[9]?.props?.children === 'c10',
		JSON.stringify([codes[0]?.props?.children, codes[9]?.props?.children]));
	const listText = String(JSON.stringify(list?.props?.children) ?? '');
	check('T9⑨ 超量截断：给出「等 12 个」', listText.includes('等 12 个'), listText);
	check('T9⑨ 超量截断：清单是**一个**容器节点（不铺满弹窗）', list?.type === 'div');
}

// ⑨d 没有可信 id 时**绝不编造**（无法判定 / 没有子会话 / 形状漂移 / 统计失败 / 计划为空）
for (const [label, plan] of [
	['无法判定（unavailable）', { ok: true, dryRun: true, cascade: 'unavailable', children: { total: 0, ids: [], bytes: 0, running: [] } }],
	['没有子会话（total 0）', { ok: true, dryRun: true, cascade: 'none', children: { total: 0, ids: [], bytes: 0, running: [] } }],
	['形状漂移（没有 ids 字段）', { ok: true, dryRun: true, cascade: 'ok', children: { total: 3, bytes: 1, running: [] } }]
]) {
	planStore.set({ token: 812, state: 'ready', sessionId: 'S1', plan });
	check(`T9⑨ ${label} ⇒ 不列出清单（绝不编造 id）`,
		childListOf(renderOverlay(overlayInjected)) === undefined, bodyOf(renderOverlay(overlayInjected)));
}
{
	// 形状漂移：ids 里混了非字符串 ⇒ 只渲染合法的那一个，绝不把 7 当 id 显示出来
	planStore.set({ token: 814, state: 'ready', sessionId: 'S1', plan: { ok: true, dryRun: true, cascade: 'ok', children: { total: 2, ids: [7, 'c9'], bytes: 1, running: [] } } });
	const codes = codesOf(childListOf(renderOverlay(overlayInjected)));
	check('T9⑨ ids 里混了非字符串 ⇒ 只渲染合法的那一个（7 不许出现在界面上）',
		codes.length === 1 && codes[0].props.children === 'c9', JSON.stringify(codes.map((c) => c.props.children)));
}
planStore.set({ token: 813, state: 'failed', sessionId: 'S1' });
check('T9⑨ 统计失败（failed）⇒ 不列出清单', childListOf(renderOverlay(overlayInjected)) === undefined);
planStore.set(null);
check('T9⑨ 计划为空 ⇒ 不列出清单', childListOf(renderOverlay(overlayInjected)) === undefined);
deleteRequest.set(null);
resultStore.set(null);

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + failures.length} passed`);
if (failures.length > 0) {
	console.log('failed:');
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
