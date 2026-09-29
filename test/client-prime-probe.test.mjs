// dsh-session-delete：自包含原语改造后的**正面**探针（2026-09-29）
//
// 为什么需要它：`verify-client-task6.mjs` 跑的是**缩减环境**（没有 document / ctx.effect /
// react-dom），只能断言那两条路"静默降级、零日志"。这里反过来 —— 把环境**给全**，
// 正面验证：
//   ① `react-dom` 可用 ⇒ 走 portal（`__clientDiagnostics().portal === true`）
//   ② `document` + `ctx.effect` 可用 ⇒ 样式表真的注入到 <head>，且 dispose 时**移除**
//   ③ 自包含 Modal 的键盘层（等价官方 `useModalLayer`）：初始聚焦 `[data-modal-autofocus]`、
//      Escape 关闭、Tab 在弹窗内循环、关闭时把焦点还回去
//   ④ 注入的 CSS 仍带齐那些关键设计 token（防"抄样式时漏掉 token"）
//
// 用法：node test/client-prime-probe.test.mjs [client.js 路径]
import fs from 'node:fs';
import vm from 'node:vm';

// 默认相对本文件定位被测工件（开源后换机器也能跑）。
const CLIENT = process.argv[2] ?? new URL('../client.js', import.meta.url);

let pass = 0;
const failures = [];
function check(label, ok, detail) {
	if (ok) { pass += 1; console.log(`  ok   ${label}`); }
	else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` :: ${detail}`}`); }
}

//#region 假浏览器环境（这次的目的是**给全**，与验证台相反）
const jsxShim = (type, props, key) => ({ type, props: props ?? {}, key });
const Fragment = Symbol('Fragment');

const headChildren = [];
function makeElement(tag) {
	const el = {
		tagName: String(tag).toUpperCase(),
		children: [],
		attributes: {},
		textContent: '',
		setAttribute(name, value) { el.attributes[name] = value; },
		appendChild(child) { el.children.push(child); return child; },
		remove() { const at = headChildren.indexOf(el); if (at >= 0) headChildren.splice(at, 1); },
		focus() { doc.activeElement = el; },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		contains() { return true; }
	};
	return el;
}

const docHandlers = [];
const doc = {
	activeElement: null,
	head: null,
	body: makeElement('body'),
	createElement: (tag) => makeElement(tag),
	addEventListener: (type, fn) => { docHandlers.push({ type, fn }); },
	removeEventListener: (type, fn) => {
		const at = docHandlers.findIndex((h) => h.type === type && h.fn === fn);
		if (at >= 0) docHandlers.splice(at, 1);
	},
	contains: () => true
};
doc.head = makeElement('head');
doc.head.appendChild = (child) => { headChildren.push(child); return child; };

// 可控的 fake react：`useEffect` **不立即执行**，把回调收集起来，由探针在"模拟提交"后手动跑
// （真实 React 里 ref 是提交阶段挂上的，所以必须先让组件返回、再让 ref 就位、最后跑 effect）。
const pendingEffects = [];
const refBoxes = [];
let stateSeeds = [];
const reactShim = {
	useState: (initial) => {
		const value = stateSeeds.length > 0 ? stateSeeds.shift() : initial;
		return [value, () => {}];
	},
	useRef: (initial) => {
		const box = { current: initial ?? null };
		refBoxes.push(box);
		return box;
	},
	useEffect: (cb) => { pendingEffects.push(cb); }
};

const sandbox = {
	window: { __ModuleLoader__: { load: (def) => { sandbox.__def = def; } } },
	navigator: { language: 'zh-CN' },
	console,
	document: doc,
	setTimeout: (fn) => 0,
	clearTimeout: () => {}
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' });

const def = sandbox.__def;
check('client.js 通过 __ModuleLoader__.load 注册', def !== undefined);

// 这一轮：react-dom 给全（≠ 验证台的缩减环境）
const req = (spec) => {
	if (spec === 'react') return reactShim;
	if (spec === 'react/jsx-runtime') return { jsx: jsxShim, jsxs: jsxShim, Fragment };
	if (spec === 'react-dom') return { createPortal: (node) => ({ __portal: true, node }) };
	throw new Error(`probe: unexpected require(${spec})`);
};
const exports_ = def.factory(req);
//#endregion

//#region ① + ②：apply 时的样式注入与 portal 可用性
const disposers = [];
const registrations = [];
const slots = {
	inject: (slot, gen) => {
		const it = gen();
		for (let r = it.next(); !r.done; r = it.next()) registrations.push({ slot, ...(r.value ?? {}) });
	},
	register: (spec, Comp) => ({ spec, Comp })
};
const ctx = {
	slots,
	inject: (deps, cb) => { cb({ slots, effect: (fn) => { const d = fn(); disposers.push(d); return d; } }); return () => {}; },
	effect: (fn) => { const d = fn(); disposers.push(d); return d; }
};
exports_.apply(ctx);

{
	const diag = exports_.__clientDiagnostics();
	check('① react-dom 给全 ⇒ portal 可用（diagnostics.portal === true）', diag.portal === true, JSON.stringify(diag));
	check('② 样式已注入 document.head（diagnostics.stylesInjected === true）', diag.stylesInjected === true, JSON.stringify(diag));
	check('② head 里恰好一个 <style>，且打了 data-dsh-plugin 标记',
		headChildren.length === 1 && headChildren[0].tagName === 'STYLE'
		&& headChildren[0].attributes['data-dsh-plugin'] === 'session-delete',
		JSON.stringify(headChildren.map((c) => ({ tag: c.tagName, attrs: c.attributes }))));

	const css = headChildren[0]?.textContent ?? '';
	const tokens = [
		'--dsw-radius-md', '--dsw-radius-sm', '--dsw-radius-panel',
		'--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-primary-foreground',
		'--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
		'--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-state-error-primary',
		'--dsw-alias-menu-icon', '--dsw-alias-border-l3', '--dsw-alias-bg-layer-2',
		'--dsw-alias-bg-mask-1', '--dsw-mask-blur', '--dsw-elevation-prominent',
		'--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover'
	];
	const missing = tokens.filter((t) => !css.includes(t));
	check('④ 注入的 CSS 带齐关键设计 token（照抄官方样式时不许漏）', missing.length === 0, `缺：${missing.join(', ')}`);
	check('④ CSS 类名全部带 dsd- 前缀（不污染宿主类名）',
		/\.dsd-btn/.test(css) && /\.dsd-item/.test(css) && /\.dsd-modal-dialog/.test(css) && !/[^-]\.root\b|[^-]\.item\b|[^-]\.dialog\b/.test(css));
}

// 注册是否照常（顺带证明改造没动接线）
check('注册仍然两条：菜单槽位 + overlay 槽位',
	registrations.some((r) => r.slot === 'sidebar.workspaces.session.menu.item')
	&& registrations.some((r) => r.slot === 'shell.overlay'),
	JSON.stringify(registrations.map((r) => r.slot)));
//#endregion

//#region ③ 自包含 Modal 的键盘层
const overlayReg = registrations.find((r) => r.slot === 'shell.overlay');
const injected = overlayReg.spec.inject();
injected.hooks.deleteRequest.set({ sessionId: 'S1', displayTitle: '待删会话' });

let closed = 0;
stateSeeds = [false, null, []];
const overlayNode = overlayReg.Comp({
	useDeleteRequest: (sel) => sel(injected.hooks.deleteRequest.getSnapshot()),
	useCopyNotice: () => null,
	useDeletePlan: () => null,
	useDeleteResult: () => null,
	settleSessionDelete: () => { closed += 1; },
	performSessionDelete: () => Promise.resolve({})
});
const confirmNode = overlayNode.type(overlayNode.props); // → Modal 元素
check('overlay 在有请求时渲染 Modal', typeof confirmNode.type === 'function' && confirmNode.type.name === 'Modal', String(confirmNode.type?.name));

// Modal 的 props.onClose 就是我们自己传的 close ⇒ 用 settleSessionDelete 计数
const modalProps = confirmNode.props;
const tree = confirmNode.type(modalProps);
check('portal 路径生效（react-dom 存在 ⇒ 返回的是 portal 包装）', tree?.__portal === true && tree.node?.props?.className === 'dsd-modal-root',
	JSON.stringify({ portal: tree?.__portal, cls: tree?.node?.props?.className }));

// 组装"已提交"的 DOM：dialog 节点 + 一个 [data-modal-autofocus] 按钮 + 两个可聚焦元素
const firstBtn = makeElement('button');
const lastBtn = makeElement('button');
const autoBtn = makeElement('button');
const dialogNode = makeElement('div');
dialogNode.querySelector = (sel) => (sel === '[data-modal-autofocus]' ? autoBtn : null);
dialogNode.querySelectorAll = () => [firstBtn, lastBtn];
dialogNode.contains = (node) => node === dialogNode || node === firstBtn || node === lastBtn || node === autoBtn;
const refBox = refBoxes.find((b) => b.current === null);
check('Modal 通过 useRef 拿了 dialog 容器', refBox !== undefined);
refBox.current = dialogNode; // 模拟 React 提交阶段把 ref 挂上

const restoreTarget = makeElement('button');
doc.activeElement = restoreTarget;

// 模拟提交：跑掉挂起的 effect（useModalLayer）
const effectCount = pendingEffects.length;
const cleanups = pendingEffects.map((cb) => cb());
pendingEffects.length = 0;
check('Modal 提交后注册了键盘层 effect', effectCount === 1, String(effectCount));
check('③ 初始聚焦 [data-modal-autofocus]（而不是 autoFocus 属性）', doc.activeElement === autoBtn);
check('③ 注册了一个 keydown 监听（capture）', docHandlers.filter((h) => h.type === 'keydown').length === 1);

const keydown = docHandlers.find((h) => h.type === 'keydown')?.fn;
// Escape → 关闭
keydown({ key: 'Escape', stopPropagation: () => {}, preventDefault: () => {} });
check('③ Escape 触发 onClose（settleSessionDelete 被调 1 次）', closed === 1, String(closed));

// Tab 循环：焦点在最后一项时 Tab → 回到第一项
doc.activeElement = lastBtn;
let prevented = 0;
keydown({ key: 'Tab', shiftKey: false, stopPropagation: () => {}, preventDefault: () => { prevented += 1; } });
check('③ Tab 在弹窗内循环（最后一项 → 第一项，且 preventDefault）', doc.activeElement === firstBtn && prevented === 1);

// Shift+Tab：焦点在第一项时 → 回到最后一项
doc.activeElement = firstBtn;
prevented = 0;
keydown({ key: 'Tab', shiftKey: true, stopPropagation: () => {}, preventDefault: () => { prevented += 1; } });
check('③ Shift+Tab 反向循环（第一项 → 最后一项）', doc.activeElement === lastBtn && prevented === 1);

// 焦点在弹窗外 ⇒ 拉回第一项
doc.activeElement = makeElement('div');
keydown({ key: 'Tab', shiftKey: false, stopPropagation: () => {}, preventDefault: () => {} });
check('③ 焦点在弹窗外时 Tab 拉回弹窗内第一项', doc.activeElement === firstBtn);

// 非 Escape/Tab 的键不拦
prevented = 0;
doc.activeElement = firstBtn;
keydown({ key: 'a', stopPropagation: () => {}, preventDefault: () => { prevented += 1; } });
check('③ 其他按键不拦截（不 preventDefault）', prevented === 0);

// 卸载（模拟关闭）：keydown 监听注销 + 焦点还给原处
cleanups.forEach((fn) => { if (typeof fn === 'function') fn(); });
check('③ 卸载后 keydown 监听已注销', docHandlers.filter((h) => h.type === 'keydown').length === 0);
check('③ 卸载后焦点还给打开前的元素', doc.activeElement === restoreTarget);
//#endregion

//#region ②b dispose 时样式移除
for (const d of disposers) { if (typeof d === 'function') d(); }
check('②b ctx.effect 的 dispose 会把注入的 <style> 移除干净', headChildren.length === 0
	&& exports_.__clientDiagnostics().stylesInjected === false,
	JSON.stringify({ head: headChildren.length, diag: exports_.__clientDiagnostics() }));
//#endregion

console.log(`\n${pass}/${pass + failures.length} 通过`);
if (failures.length > 0) {
	console.log('failed:');
	for (const f of failures) console.log(`  - ${f}`);
	process.exitCode = 1;
}
