window.__ModuleLoader__.load({
	id: "@apherchin/dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// ⛔ **刻意不 require 任何 Harness Client 包。**
		// 官方 `cordis-plugin-development` 的 practices 明文禁止（原文：
		// "Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other
		//  Harness Client package as a module"），理由不是"拿不到"——那 9 个 specifier
		// 确实在平台静态种子表里能解析——而是**升级稳定性**：它们会无预告变更、纯 JS 插件
		// 没有类型检查，而**抛错的组件会让整块 slot entry 空白**（Console: `slot entry crashed`）。
		// 所以下面 5 个原语 + 1 个 store 都是**按行为照抄进本插件的自包含实现**：
		// 路径数据、CSS 规则、每一条 `--dsw-alias-*` / `--dsw-*` token 引用都与
		// `dsh-client-ui-primitives/lib/index.js` 与 `lib/{Button,Menu,Modal}.module.css` 一致，
		// 类名统一加本插件前缀 `dsd-`（官方建议："Rename copied classes under your plugin's prefix"）。
		// React 与 React DOM 来自浏览器模块表（基座），不是 Harness Client 包，可以正常 require。
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");

		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const Fragment = jsxRuntime.Fragment;

		/**
		 * `react-dom` 的 `createPortal`：**必须 try/catch**。
		 * 弹窗原本经官方 `Modal` 内部 portal 到 `document.body`（保持层叠不被祖先的
		 * transform/overflow 影响）；拿不到就**就地渲染**降级 —— 绝不允许一条 require
		 * 把 factory 打穿（那会变成 client entry `failed` ⇒ 撞 web boot 全有全无门禁 ⇒ 整机起不来）。
		 */
		let createPortal = null;
		try {
			const reactDom = require("react-dom");
			if (reactDom !== null && reactDom !== void 0 && typeof reactDom.createPortal === "function") createPortal = reactDom.createPortal;
		} catch (error) {
			// **静默降级**：拿不到 react-dom 只意味着弹窗就地渲染（外观/行为一致，
			// 只有层叠上下文略有差别），不是异常。这里刻意**不**打日志 —— 客户端插件在
			// 「服务/基座不齐」的环境下刷日志是明确要避免的（本插件的验证台就守着
			// "正常路径零日志"这条不变量）。
			createPortal = null;
		}
		/** 样式表当前是否已注入（只给离线探针 `__clientDiagnostics()` 用；不影响运行时行为）。 */
		let stylesInjected = false;

		//#region 自包含原语（照抄官方；只共享设计 token）
		/** 本插件的样式表：一次性注入 `document.head`，类名全部带 `dsd-` 前缀。 */
		const CLIENT_STYLE_TEXT = `
.dsd-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: none; border-radius: var(--dsw-radius-md); cursor: pointer; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); background: transparent; padding: 0 14px; }
.dsd-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dsd-btn-md { height: 36px; }
.dsd-btn-sm { height: 28px; font-size: 12px; line-height: 18px; padding: 0 10px; border-radius: var(--dsw-radius-sm); }
.dsd-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsd-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsd-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd-btn-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.dsd-btn-outline { border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; }
.dsd-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd-btn-icon { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; }
.dsd-item-wrap { position: relative; }
.dsd-item { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; }
.dsd-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsd-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dsd-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dsd-item-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon); }
.dsd-item-icon svg { width: 14px; height: 14px; }
.dsd-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsd-item-danger { color: var(--dsw-alias-state-error-primary); }
.dsd-item-danger .dsd-item-icon { color: var(--dsw-alias-state-error-primary); }
.dsd-item-danger:hover:not(:disabled), .dsd-item-danger:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsd-modal-root { pointer-events: auto; position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: max(24px, var(--dsh-frame-top-clearance, 24px)) 24px; }
.dsd-modal-mask { position: absolute; inset: 0; backdrop-filter: var(--dsw-mask-blur); }
.dsd-modal-mask::after { content: ''; position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); animation: dsdModalEnter var(--ds-transition-duration) var(--ds-ease-in-out); }
.dsd-modal-dialog { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); padding: 0 0 24px; overflow: hidden; border: 0; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); animation: dsdModalEnter var(--ds-transition-duration) var(--ds-ease-in-out); }
.dsd-modal-dialog:focus { outline: none; }
@keyframes dsdModalEnter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dsd-modal-mask::after, .dsd-modal-dialog { animation: none; } }
.dsd-modal-content { display: flex; flex-direction: column; width: 100%; }
.dsd-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 14px 12px 24px; }
.dsd-modal-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsd-modal-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.dsd-modal-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsd-modal-description { margin: 0; padding: 0 24px; font-size: 14px; line-height: 22px; font-weight: 400; color: var(--dsw-alias-label-primary); }
.dsd-modal-body { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; }
.dsd-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 24px; }
`;

		/** 官方 `IconTrashOutlineRegular` 的等价实现（5 条 path 与 stroke-width 逐字照抄）。 */
		function IconTrashOutlineRegular({ size = 16 }) {
			return jsxs("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1,
				children: [
					jsx("path", { d: "M1.28149 3.88831H14.7187", stroke: "currentColor" }),
					jsx("path", { d: "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833", stroke: "currentColor" }),
					jsx("path", { d: "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831", stroke: "currentColor" }),
					jsx("path", { d: "M6.44946 6.98926V11.1238", stroke: "currentColor" }),
					jsx("path", { d: "M9.55054 6.98926V11.1238", stroke: "currentColor" })
				]
			});
		}

		/** 官方 `IconCopyOutlineRegular` 的等价实现（rect + path 照抄）。 */
		function IconCopyOutlineRegular({ size = 16 }) {
			return jsxs("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1,
				children: [
					jsx("rect", { x: "1.52075", y: "4.07373", width: "10.3932", height: "10.3932", rx: "2", stroke: "currentColor" }),
					jsx("path", { d: "M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z", fill: "currentColor" })
				]
			});
		}

		/** 官方 `IconCloseOutlineRegular` 的等价实现（两条对角线照抄）。 */
		function IconCloseOutlineRegular({ size = 16 }) {
			return jsxs("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", strokeWidth: 1,
				children: [
					jsx("path", { d: "M2.5 2.5L13.5 13.5", stroke: "currentColor" }),
					jsx("path", { d: "M13.5 2.5L2.5 13.5", stroke: "currentColor" })
				]
			});
		}

		/** 官方 `Button` 的等价实现（变体/尺寸的类名与 CSS 规则一一对应）。 */
		function Button({ variant = "ghost", size = "md", icon, className, children, style, ...rest }) {
			const classes = ["dsd-btn", `dsd-btn-${variant}`, size === "sm" ? "dsd-btn-sm" : "dsd-btn-md"];
			if (typeof className === "string" && className.length > 0) classes.push(className);
			return jsxs("button", {
				...rest,
				type: rest.type === void 0 ? "button" : rest.type,
				className: classes.join(" "),
				style,
				children: [
					icon !== void 0 && jsx("span", { className: "dsd-btn-icon", children: icon }),
					children
				]
			});
		}

		/** 官方 `MenuItemButton` 的等价实现（`role="menuitem"` + 图标槽 + 危险态）。 */
		function MenuItemButton({ children, shortcut, icon, disabled = false, danger = false, separatorBefore = false, onSelect }) {
			return jsxs("div", {
				className: "dsd-item-wrap",
				children: [
					separatorBefore && jsx("div", { className: "dsd-separator", role: "separator" }),
					jsxs("button", {
						type: "button",
						role: "menuitem",
						className: danger ? "dsd-item dsd-item-danger" : "dsd-item",
						disabled,
						"aria-keyshortcuts": shortcut === void 0 ? void 0 : shortcut.aria,
						onClick: onSelect,
						children: [
							icon !== void 0 && jsx("span", { className: "dsd-item-icon", children: icon }),
							jsx("span", { className: "dsd-item-label", children })
						]
					})
				]
			});
		}

		/**
		 * 官方 `useModalLayer` 的等价行为：Escape 关闭、Tab 在弹窗内循环、
		 * 打开时聚焦 `[data-modal-autofocus]`（找不到就聚焦卡片本身），关闭时把焦点还回去。
		 * 只用 `document` 级 keydown（capture），不依赖任何外部层管理器。
		 */
		function useModalLayer(dialogRef, open, onClose) {
			react.useEffect(() => {
				if (open !== true) return void 0;
				const onKeyDown = (event) => {
					try {
						if (event.key === "Escape") {
							event.stopPropagation();
							onClose();
							return;
						}
						if (event.key !== "Tab") return;
						const node = dialogRef.current;
						if (node === null || node === void 0) return;
						const focusables = Array.from(node.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
						if (focusables.length === 0) {
							event.preventDefault();
							try { node.focus(); } catch (error) { /* 聚焦失败不影响键盘关闭 */ }
							return;
						}
						const first = focusables[0];
						const last = focusables[focusables.length - 1];
						const active = document.activeElement;
						const inside = node.contains(active);
						if (event.shiftKey && (active === first || !inside)) {
							event.preventDefault();
							try { last.focus(); } catch (error) { /* 同上 */ }
						} else if (!event.shiftKey && (active === last || !inside)) {
							event.preventDefault();
							try { first.focus(); } catch (error) { /* 同上 */ }
						}
					} catch (error) {
						// 键盘处理绝不允许打穿到 React 渲染层
						console.error("[session-delete] 弹窗键盘处理失败（已忽略）：", error);
					}
				};
				document.addEventListener("keydown", onKeyDown, true);
				let restore = null;
				try {
					restore = document.activeElement;
					const node = dialogRef.current;
					const target = node === null || node === void 0 ? null : node.querySelector("[data-modal-autofocus]");
					if (target !== null && target !== void 0 && typeof target.focus === "function") target.focus();
					else if (node !== null && node !== void 0 && typeof node.focus === "function") node.focus();
				} catch (error) {
					console.warn("[session-delete] 弹窗初始聚焦失败（不影响显示）：", error);
				}
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
					try {
						if (restore !== null && restore !== void 0 && typeof restore.focus === "function" && document.contains(restore)) restore.focus();
					} catch (error) { /* 还焦点失败无害 */ }
				};
			}, [open, onClose]);
		}

		/**
		 * 官方 `Modal` 的等价实现（同样的 DOM 结构与类名语义、同样的 props 子集）。
		 * 支持本插件用到的 `open / onClose / title / closeLabel / description / footer / children`。
		 */
		function Modal({ open, onClose, title, closeLabel, description, children, footer }) {
			const dialog = react.useRef(null);
			useModalLayer(dialog, open, onClose);
			if (open !== true) return null;
			const tree = jsxs("div", {
				className: "dsd-modal-root",
				role: "presentation",
				children: [
					jsx("div", { className: "dsd-modal-mask", "aria-hidden": "true", onClick: onClose }),
					jsxs("div", {
						ref: dialog,
						tabIndex: -1,
						className: "dsd-modal-dialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": title,
						children: [
							jsxs("div", {
								className: "dsd-modal-content",
								children: [
									jsxs("div", {
										className: "dsd-modal-header",
										children: [
											jsx("h2", { className: "dsd-modal-title", children: title }),
											jsx("button", {
												type: "button",
												className: "dsd-modal-close",
												"aria-label": closeLabel,
												onClick: onClose,
												children: jsx(IconCloseOutlineRegular, { size: 14 })
											})
										]
									}),
									description !== void 0 && description !== "" && jsx("p", { className: "dsd-modal-description", children: description }),
									children !== void 0 && jsx("div", { className: "dsd-modal-body", children })
								]
							}),
							footer !== void 0 && jsx("div", { className: "dsd-modal-footer", children: footer })
						]
					})
				]
			});
			// 有 portal 就走官方同款（挂到 body，避免被祖先的 transform/overflow 影响）；
			// 拿不到 react-dom 时就地渲染（外观/行为一致，只有层叠上下文略有差别）。
			if (createPortal !== null) {
				try {
					return createPortal(tree, document.body);
				} catch (error) {
					// 同上：**静默降级**为就地渲染（`document` 缺失等环境问题不是异常，不该刷日志）。
					return tree;
				}
			}
			return tree;
		}

		/**
		 * 官方 `createSnapshotStore` 的等价实现（原在 `@deepseek-ai/dsh-client-store`）。
		 * **接口必须逐字一致**：`{ getSnapshot, subscribe, update, set }` ——
		 * 因为 `inject: () => ({ hooks: { deleteRequest, ... } })` 里的每个值都会被 renderer
		 * 当作外部 store 包成 `useXxx` hook（uSES 读 `getSnapshot`、订阅 `subscribe`）。
		 * `subscribe(fn)` 的回调**不带参数**；`getSnapshot()` 在两次变更之间必须是**同一个引用**。
		 */
		function createSnapshotStore(initial) {
			let state = initial;
			const listeners = new Set();
			const emit = () => {
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						// 一个订阅者抛错不许连累其他订阅者与调用方
						console.error("[session-delete] store 订阅回调抛出（已忽略）：", error);
					}
				}
			};
			return {
				getSnapshot: () => state,
				subscribe: (fn) => {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				},
				update: (mutator) => {
					const draft = state !== null && typeof state === "object" ? Object.assign({}, state) : state;
					try {
						mutator(draft);
					} catch (error) {
						console.error("[session-delete] store.update 的 mutator 抛出（状态未变）：", error);
						return;
					}
					state = draft;
					emit();
				},
				set: (next) => {
					state = next;
					emit();
				}
			};
		}
		//#endregion

		//#region 文案（P2：以中文为准；仅在语言明确是英文时切英文，其余一律中文）
		const COPY = {
			zh: {
				menu: "删除对话",
				title: "删除对话",
				warning: "将永久删除该会话的日志与缓存，无法恢复。",
				target: (name) => `会话：${name}`,
				confirm: "删除",
				deleting: "正在删除…",
				cancel: "取消",
				close: "关闭",
				sessionActive: "该会话正在运行，请先停止或先归档",
				unknownFailure: "删除失败，请稍后重试",
				badResponse: "服务端返回了无法解析的响应",
				failedTitle: "以下目标未能删除：",
				copyId: "复制会话 ID",
				copiedLabel: "已复制会话 ID：",
				copyFailedLabel: "复制失败，请手动复制会话 ID：",
				// Task 8：删除弹窗里的「子代理会话」状态行
				planLoading: "正在统计子代理会话…",
				planUnavailable: "无法判定子代理会话（不影响删除）",
				planChildren: (count) => `将一并删除 ${count} 个子代理会话`,
				planRunning: (count) => `有 ${count} 个子代理会话正在运行，需等它们结束`,
				// Task 8：真删成功且真的删掉了子会话时的提示
				deletedLabel: "已删除会话：",
				deletedChildren: (count) => `（含 ${count} 个子代理会话）`,
				// Task 9：确认弹窗里列出「将被一并删除的子会话 ID」（可选中/可复制；超量截断）。
				// ⚠️ 文案**不要**含 `将一并删除` 这类标记词：那会和上面那条状态行在同一段文案里串档。
				childIdsLabel: "子会话 ID：",
				childIdsMore: (total) => `等 ${total} 个`,
				// Task 9：删除**成功**后的结果态文案。按宿主回的 `attached` 分三支（互斥）：
				deletedAttached: "已删除磁盘数据。⚠️ 该会话打开过（仍驻留在内存中），侧栏条目会一直显示 —— 请关闭它的标签页、或重启 DSH 后才会消失。",
				deletedUnknown: "已删除。",
				deletedChildrenAttached: (count) => `⚠️ 其中 ${count} 个子代理会话仍驻留在内存中，它们的侧栏条目会留到关闭标签页或重启 DSH 为止。`
			},
			en: {
				menu: "Delete conversation",
				title: "Delete conversation",
				warning: "This permanently deletes the session's log and cache. It cannot be undone.",
				target: (name) => `Session: ${name}`,
				confirm: "Delete",
				deleting: "Deleting…",
				cancel: "Cancel",
				close: "Close",
				sessionActive: "This session is running — stop or archive it first",
				unknownFailure: "Delete failed. Please try again.",
				badResponse: "The server returned an unparsable response",
				failedTitle: "These targets could not be removed:",
				copyId: "Copy session ID",
				copiedLabel: "Copied session ID: ",
				copyFailedLabel: "Copy failed — copy this session ID manually:",
				planLoading: "Counting subagent sessions…",
				planUnavailable: "Subagent sessions could not be determined (deletion is unaffected)",
				planChildren: (count) => `${count} subagent session(s) will be deleted as well`,
				planRunning: (count) => `${count} subagent session(s) are still running — wait for them to finish`,
				deletedLabel: "Deleted session: ",
				deletedChildren: (count) => ` (including ${count} subagent session(s))`,
				childIdsLabel: "Subagent session IDs: ",
				childIdsMore: (total) => `(${total} in total)`,
				deletedAttached: "Disk data deleted. ⚠️ This session was opened (it is still resident in memory), so its sidebar entry will keep showing — close its tab or restart DSH for it to disappear.",
				deletedUnknown: "Deleted.",
				deletedChildrenAttached: (count) => `⚠️ ${count} of them are still resident in memory; their sidebar entries remain until you close their tabs or restart DSH.`
			}
		};
		const copy = typeof navigator !== "undefined" && /^en\b/i.test(String(navigator.language ?? "")) ? COPY.en : COPY.zh;
		//#endregion

		//#region 契约常量
		/**
		 * 菜单槽位：owner props = `{ sessionId, displayTitle }`。
		 * 官方占用 100/200/300/400（archive = 400）→ 「复制会话 ID」用 **450**、「删除对话」用 **500**：
		 * 破坏性动作排在最后。
		 */
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		/** 弹窗槽位：`kind: "list"`, `scope: "root"`，由 `dsh-client-ui-layout` 声明（与官方 archiveConfirm 同构）。 */
		const OVERLAY_SLOT = "shell.overlay";
		const DELETE_PATH = "/api/session.delete";
		/** 官方危险色 token（与 `dsh-client-ui-workspace` 的 `deleteAction` 同一个）。 */
		const DANGER = "var(--dsw-alias-state-error-primary)";
		const BUSY = { margin: "8px 0 0", color: "var(--dsw-alias-label-tertiary)", fontSize: 13, lineHeight: "20px" };
		const ERROR = { margin: "8px 0 0", color: DANGER, fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere" };
		/** 「有子代理会话正在运行」那一行的外观：**警告**（用与错误同一个危险色 token）。 */
		const WARN = { margin: "8px 0 0", color: DANGER, fontSize: 13, lineHeight: "20px" };
		/** 「将被一并删除的子会话 ID」清单容器：一行流式排列，长了自动换行（不铺满弹窗）。 */
		const CHILD_IDS = { margin: "6px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px", overflowWrap: "anywhere" };
		const CHILD_IDS_LABEL = { marginRight: 6 };
		/** 结果态里的会话 id：同样**可选中**（最坏情况用户能自己抄走）。 */
		const RESULT_ID = { fontFamily: "inherit", userSelect: "all", overflowWrap: "anywhere" };
		/** 子会话 ID 清单最多显示几个（超出的用「等 N 个」概括 —— 500 个 id 会把弹窗撑爆）。 */
		const CHILD_ID_PREVIEW = 10;
		const TARGET = { margin: "0 0 8px", color: "var(--dsw-alias-label-primary)", fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere" };
		const FAILED_LIST = { margin: "4px 0 0", paddingLeft: 18, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px", overflowWrap: "anywhere" };
		/** 「已复制 / 请手动复制」提示的自动消失时间（约 2 秒）。 */
		const COPY_NOTICE_MS = 2000;
		/**
		 * `dryRun`（统计子代理会话）的超时上限。超时按"**未统计**"处理 —— 状态行消失、
		 * 删除键**保持可用**。绝不允许一次统计把删除堵死（哪怕是网络永远不回来）。
		 */
		const DRY_RUN_TIMEOUT_MS = 5000;
		/**
		 * 提示的外观：**照抄平台 toast 面**（同一组 token、同一个层级、同样居中）。
		 * 但**不**用官方 `Toast` 组件：它的 `.toast` 是 `pointer-events: none`（"Announcements never
		 * intercept clicks"，见 `dsh-client-ui-primitives/lib/Toast.module.css:14`），
		 * 整条横幅点不动、文字选不中 —— 而"剪贴板两条路都失败时让用户手动复制 id"这条要求
		 * 恰恰需要**能选中**，所以这里自己渲染一个可选中（`userSelect: "all"`）的小提示。
		 */
		const COPY_NOTICE = {
			position: "fixed",
			top: 40,
			left: "50%",
			transform: "translateX(-50%)",
			zIndex: 1100,
			width: "max-content",
			maxWidth: "min(640px, calc(100vw - 48px))",
			display: "flex",
			alignItems: "center",
			gap: 10,
			padding: "10px 16px",
			borderRadius: "var(--dsw-radius-lg)",
			background: "var(--dsw-alias-toast-bg)",
			color: "var(--dsw-alias-toast-label)",
			boxShadow: "var(--dsw-shadow-lv3)",
			fontSize: 13,
			lineHeight: "20px"
		};
		const COPY_NOTICE_ID = {
			fontFamily: "inherit",
			userSelect: "all",
			overflowWrap: "anywhere",
			color: "var(--dsw-static-deepseek-400)"
		};
		//#endregion

		// ⛔ 这里**曾经**有一张「平台种子表里应当有这 5 个导出」的自检表（缺一个就记一条
		// `ui-primitives 缺少导出：X` 的错误）。**2026-09-29 起整块删除**：那 5 个原语已经
		// 变成上面的自包含实现（见文件头的合规说明），不再有任何"外部依赖可能缺失"这回事——
		// 留着它反而会把排查引向"依赖缺了"的错误方向。

		/** 菜单关不掉的兜底：owner 不再声明 `menuOpenState` 时退化为 no-op。 */
		const NO_MENU_STATE = [false, () => {}];
		function readNoMenuState() {
			return NO_MENU_STATE;
		}

		/** overlay 拿不到复制提示源时的兜底：永远"没有提示"。 */
		function readNoCopyNotice() {
			return null;
		}

		/** overlay 拿不到统计计划源时的兜底：永远"未统计"（不显示状态行、不禁用删除键）。 */
		function readNoDeletePlan() {
			return null;
		}

		/** overlay 拿不到删除结果源时的兜底：永远"还没有结果"（⇒ 弹窗停在确认态）。 */
		function readNoDeleteResult() {
			return null;
		}

		/**
		 * 把统计计划翻成弹窗里的**那一行**。返回 `{ text, warn }`，或 `null`（= 不显示那一行）。
		 *
		 * 契约（Task 8）：
		 *   - `loading` ⇒ 「正在统计子代理会话…」
		 *   - `ready` + `cascade === "unavailable"` ⇒ 「无法判定子代理会话（不影响删除）」
		 *   - `ready` + `total === 0`（或 `cascade === "none"`）⇒ **不显示**（保持弹窗干净）
		 *   - `ready` + 有子会话在运行 ⇒ 「有 N 个子代理会话正在运行，需等它们结束」（**警告**）
		 *   - `ready` + 有子会话且都不在跑 ⇒ 「将一并删除 N 个子代理会话」
		 *   - `failed` / 形状漂移 ⇒ `null`（降级为"未统计"，**绝不**因此禁用删除键）
		 *
		 * ⚠️ `unavailable` 必须**先判**：它的 `total` 也是 0，否则会被"没有子会话"那支吞掉。
		 */
		function planLine(entry) {
			if (entry === null || entry === void 0) return null;
			if (entry.state === "loading") return { text: copy.planLoading, warn: false };
			if (entry.state !== "ready") return null;
			const plan = entry.plan;
			if (plan === null || typeof plan !== "object") return null;
			if (plan.cascade === "unavailable") return { text: copy.planUnavailable, warn: false };
			const children = plan.children;
			const total = children !== null && typeof children === "object" && Number.isFinite(children.total) ? children.total : 0;
			if (total === 0 || plan.cascade === "none") return null;
			const running = Array.isArray(children.running) ? children.running : [];
			if (running.length > 0) return { text: copy.planRunning(running.length), warn: true };
			return { text: copy.planChildren(total), warn: false };
		}

		/**
		 * 有子代理会话在运行 ⇒ **禁用删除键**。
		 * host 侧同样 fail-closed（`CHILDREN_ACTIVE`）；这里是**提前**拦一道，让用户点不下去，
		 * 而不是点完才被拒。注意：只有"运行中"会禁用 —— 统计失败/超时/无法判定都**不禁用**。
		 */
		function planBlocksDelete(entry) {
			const line = planLine(entry);
			return line !== null && line.warn === true;
		}

		//#region 菜单行（order 500，落在「归档会话」之后）
		/**
		 * `useMenuOpenState` **不需要**我们声明：它的工厂是 `sidebar.workspaces` 的 owner
		 * （`dsh-client-ui-workspace`）在子槽位声明里给的
		 * （`inject: { hooks: { menuOpenState: (_standard, state) => () => state } }`），
		 * renderer 的 `ContextualEntry` 会把 `hookContext`（owner 的 `[menuOpen, setMenuOpen]`）
		 * 绑好合并进**每个** entry 的 props。所以这里直接用即可，点了先关菜单再开弹窗。
		 */
		function SessionDeleteMenuItem(props) {
			const sessionId = props.sessionId;
			const displayTitle = props.displayTitle;
			const requestSessionDelete = props.requestSessionDelete;
			// 防御：将来 owner 不再声明该 hook 时退化为 no-op，且不改变 hook 调用次序。
			const readMenuState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState : readNoMenuState;
			const menuOpenState = readMenuState();
			const setMenuOpen = menuOpenState === null || menuOpenState === void 0 ? void 0 : menuOpenState[1];
			return jsx(MenuItemButton, {
				icon: jsx(IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					// 先关菜单（顺序要紧：菜单一收，owner 会把整行卸载）。
					if (typeof setMenuOpen === "function") setMenuOpen(false);
					// 再挂弹窗请求；弹窗本体在 shell.overlay，不随本行卸载而消失。
					requestSessionDelete(sessionId, displayTitle);
				},
				children: copy.menu
			});
		}
		//#endregion

		//#region 菜单行「复制会话 ID」（order 450）
		/**
		 * `order: 450` —— 落在官方 `archive: 400` 之后、我们的「删除对话」`500` 之前。
		 * 破坏性动作排在最后（这条只是读，放前面）。
		 *
		 * **不参与任何门禁**：正在运行的会话也应当能复制 id（复制不是破坏性动作，
		 * 也不碰 host 的活体判据），所以这里既不读会话状态、也不带任何 disabled。
		 */
		function SessionCopyIdMenuItem(props) {
			const sessionId = props.sessionId;
			const copySessionId = props.copySessionId;
			// 与删除那条同款：owner 不再声明 `menuOpenState` 时退化为 no-op，且不改变 hook 调用次序。
			const readMenuState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState : readNoMenuState;
			const menuOpenState = readMenuState();
			const setMenuOpen = menuOpenState === null || menuOpenState === void 0 ? void 0 : menuOpenState[1];
			return jsx(MenuItemButton, {
				icon: jsx(IconCopyOutlineRegular, { size: 14 }),
				onSelect: () => {
					// 与删除那条同款：**先关菜单**（菜单一收，owner 会把整行卸载）。
					if (typeof setMenuOpen === "function") setMenuOpen(false);
					// 再复制；`copySessionId` 内部自带兜底与反馈，绝不会抛到这里。
					if (typeof copySessionId === "function") copySessionId(sessionId);
				},
				children: copy.copyId
			});
		}
		//#endregion

		//#region 确认弹窗 + 复制提示（**共用** shell.overlay 的同一个 entry）
		/**
		 * 「将被一并删除的子会话 ID」清单（Task 9，用户已定）。数据源就是 dryRun **已经**回来的
		 * `children.ids` —— 不额外发请求，也**不新增 overlay entry**（每多一个 entry 就多一处能撞
		 * 「每条 client entry 必须 active」启动门禁的地方）。
		 * 每个 id 是 `<code>` + `userSelect: "all"`（与复制提示同款：最坏情况下用户单击就能全选抄走）；
		 * 数量多时只渲染前 `CHILD_ID_PREVIEW` 个，其余用「等 N 个」概括。
		 * 返回 `null` = **不显示**这一块：无法判定 / 没有子会话 / 形状漂移 / 统计失败都走这里，
		 * **绝不编造 id**（编出来的 id 用户没法核对，比不显示更糟）。
		 */
		function childIdNodes(entry) {
			if (entry === null || entry === void 0) return null;
			if (entry.state !== "ready") return null;
			const plan = entry.plan;
			if (plan === null || typeof plan !== "object") return null;
			const children = plan.children;
			if (children === null || typeof children !== "object") return null;
			const raw = Array.isArray(children.ids) ? children.ids : [];
			// 非字符串（形状漂移）直接丢掉：只把**真能拿去用**的 id 摆给用户。
			const ids = raw.filter((id) => typeof id === "string" && id.length > 0);
			if (ids.length === 0) return null;
			const total = Number.isFinite(children.total) ? children.total : ids.length;
			const shown = ids.slice(0, CHILD_ID_PREVIEW);
			const nodes = [jsx("span", { style: CHILD_IDS_LABEL, children: copy.childIdsLabel }, "label")];
			for (const id of shown) nodes.push(jsx("code", { style: COPY_NOTICE_ID, children: id }, `child-${id}`));
			if (total > shown.length) nodes.push(jsx("span", { children: copy.childIdsMore(total) }, "more"));
			return nodes;
		}

		/**
		 * `shell.overlay` 的**唯一** entry：按两个 store 的状态分派 ——
		 * 有删除请求 ⇒ 确认弹窗（**成功后就地在该弹窗里进入结果态**）；否则有复制提示 ⇒
		 * 「已复制会话 ID」小提示；都没有 ⇒ `null`。
		 * ⚠️ 有意**不**为提示/结果再注册第二个 overlay entry（每多一个 entry 就多一处能在
		 * 「每条 client entry 必须 active」的启动门禁上出事的地方），都在这里分派。
		 */
		function SessionDeleteOverlay(props) {
			const request = props.useDeleteRequest((pending) => pending);
			// 防御：owner/renderer 没给这个 hook 时退化为"永远没有提示"，且不改变 hook 调用次序。
			const readCopyNotice = typeof props.useCopyNotice === "function" ? props.useCopyNotice : readNoCopyNotice;
			const notice = readCopyNotice((pending) => pending);
			// Task 8：dryRun 的统计计划（弹窗里的状态行 + 删除键门禁）。
			const readDeletePlan = typeof props.useDeletePlan === "function" ? props.useDeletePlan : readNoDeletePlan;
			const planEntry = readDeletePlan((pending) => pending);
			// Task 9：删除结果（持久）。它**不再**是自己的 overlay 分支，而是弹窗内部的一个状态。
			const readDeleteResult = typeof props.useDeleteResult === "function" ? props.useDeleteResult : readNoDeleteResult;
			const resultNotice = readDeleteResult((pending) => pending);
			// 删除确认**优先**：它是破坏性动作，绝不能被一条 2 秒的提示盖住。
			if (request !== null && request !== void 0) {
				return jsx(SessionDeleteConfirmBody, {
					request,
					planEntry,
					resultNotice,
					settleSessionDelete: props.settleSessionDelete,
					performSessionDelete: props.performSessionDelete
				}, request.sessionId);
			}
			if (notice === null || notice === void 0) return null;
			// key 用 token：新的一次复制会重建提示，从而重启 2 秒计时（而不是被上一条的计时抹掉）。
			return jsx(SessionCopyIdNotice, { notice }, `copy-${String(notice.token)}`);
		}

		/**
		 * 复制反馈：`已复制会话 ID：<id>` / `复制失败，请手动复制会话 ID：<id>`。
		 * id 用 `<code>` + `userSelect: "all"` 包起来 —— **最坏情况下用户单击就能全选抄走**，
		 * 这是"绝不让用户拿不到 id"的最后一道保险。
		 * ⚠️ 这条提示是**另一条路径**（复制），它的 2 秒自动消失（`COPY_NOTICE_MS`）**必须保留**：
		 * Task 9 去掉的只是"删除成功"那条 2 秒提示。
		 */
		function SessionCopyIdNotice(props) {
			const notice = props.notice;
			const manual = notice.state === "manual";
			return jsxs("div", {
				role: "status",
				"aria-live": "polite",
				style: COPY_NOTICE,
				children: [
					jsx("span", { children: manual ? copy.copyFailedLabel : copy.copiedLabel }, "label"),
					jsx("code", { style: COPY_NOTICE_ID, children: notice.sessionId }, "id")
				]
			});
		}
		//#endregion

		/** 单个请求的弹窗本体：确认 / 进行中 / 错误 / **结果态**（Task 9 起成功不再自动关闭）。 */
		function SessionDeleteConfirmBody(props) {
			const request = props.request;
			const [deleting, setDeleting] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [failed, setFailed] = react.useState([]);
			// Task 8：dryRun 的统计计划（可能还没有 → `undefined`）。它**只**影响两件事：
			// 多显示一行状态、以及"有子会话正在跑"时禁用删除键。其余一律不受影响。
			const planEntry = props.planEntry;
			const plan = planLine(planEntry);
			const blocked = planBlocksDelete(planEntry);
			// Task 9：删除结果（overlay 传下来的**持久** store）。有它 ⇒ 就地进入结果态。
			const result = props.resultNotice;

			const close = () => {
				if (deleting) return;
				// 取消 / 右上角关闭 / 结果态的「关闭」都走这一条：请求、计划、结果一起清。
				props.settleSessionDelete();
			};
			const confirm = () => {
				setDeleting(true);
				setError(null);
				setFailed([]);
				props.performSessionDelete(request.sessionId).then(() => {
					setDeleting(false);
					// ⛔ **不要**在这里 `settleSessionDelete()`（那是旧行为：成功即自动关弹窗）。
					// Task 9：删完磁盘之后"真相还没说完" —— 会话若仍 attached（被打开过），
					// 侧栏那一行**还会在**。所以就地进入结果态，由用户点「关闭」才关。
				}).catch((reason) => {
					setDeleting(false);
					setError(messageOf(reason));
					setFailed(failedOf(reason));
				});
			};

			// ── 结果态：显示结果 + 一个「关闭」按钮（用户点了才关）────────────────────
			if (result !== null && result !== void 0) {
				return resultDialog(result, close);
			}

			const body = [jsx("p", {
				style: TARGET,
				children: copy.target(request.displayTitle)
			}, "target")];
			// 状态行紧跟在"会话：xxx"之后，让用户在点删除**之前**就看见会连带删掉什么。
			if (plan !== null) body.push(jsx("p", { style: plan.warn ? WARN : BUSY, children: plan.text }, "plan"));
			// 将被一并删除的子会话 ID（可选中/可复制；超量截断）。紧跟在状态行之后。
			const childIds = childIdNodes(planEntry);
			if (childIds !== null) body.push(jsxs("div", { style: CHILD_IDS, children: childIds }, "childIds"));
			if (deleting) body.push(jsx("p", { style: BUSY, children: copy.deleting }, "busy"));
			if (error !== null) body.push(jsx("p", { style: ERROR, children: error }, "error"));
			if (failed.length > 0) body.push(jsxs("div", {
				children: [jsx("p", { style: BUSY, children: copy.failedTitle }), jsx("ul", {
					style: FAILED_LIST,
					children: failed.map((entry, index) => jsx("li", { children: describeFailure(entry) }, String(index)))
				})]
			}, "failed"));

			return jsxs(Modal, {
				open: true,
				onClose: close,
				closeLabel: copy.close,
				title: copy.title,
				description: copy.warning,
				footer: jsxs(Fragment, { children: [
					// 默认焦点：Modal 的 `useModalLayer` 先找 `[data-modal-autofocus]`
					// （React 的 autoFocus 早于该层，不能用）——所以取消键带这个属性。
					jsx(Button, {
						variant: "outline",
						disabled: deleting,
						"data-modal-autofocus": true,
						onClick: close,
						children: copy.cancel
					}),
					jsx(Button, {
						variant: "outline",
						style: deleting ? void 0 : { color: DANGER },
						// `blocked` = 有子代理会话正在运行（host 侧同样 fail-closed）⇒ 点不下去。
						disabled: deleting || blocked,
						onClick: confirm,
						children: deleting ? copy.deleting : copy.confirm
					})
				] }),
				children: body
			});
		}

		/**
		 * **结果态**的弹窗本体（Task 9）：文案按宿主回的 `attached` 分**三支**（互斥）+ 子会话信息
		 * + 一个「关闭」键（用户点了才关）。
		 *   - `attached === true`  → 说清"磁盘已删，但打开过、仍在内存、侧栏条目会一直显示"+ 两条出路；
		 *   - `attached === false` → `已删除会话：<id>`（有子会话再接 `（含 N 个子代理会话）`）；
		 *   - 其余（`undefined` / 缺字段 / 形状漂移）→ 通用兜底。
		 * ⚠️ "判不了"**绝不猜**：猜 `false` 会把"行会一直显示"的实情说成"已删除会话"，
		 * 那正是用户这次被误导的形态（他删了、看到行还在、还以为删除没生效）。
		 */
		function resultDialog(result, close) {
			const parts = [];
			if (result.attached === true) {
				parts.push(jsx("span", { children: copy.deletedAttached }, "text"));
			} else if (result.attached === false) {
				parts.push(jsx("span", { children: copy.deletedLabel }, "label"));
				parts.push(jsx("code", { style: RESULT_ID, children: result.sessionId }, "id"));
			} else {
				parts.push(jsx("span", { children: copy.deletedUnknown }, "text"));
			}
			// 子会话数：只有**真的删掉了**才说（没删到就不许声称）；三支都追加，信息只增不减。
			if (Number.isFinite(result.children) && result.children > 0) {
				parts.push(jsx("span", { children: copy.deletedChildren(result.children) }, "children"));
			}
			const body = [jsx("p", { style: TARGET, children: parts }, "result")];
			// 子会话里仍有 attached 的：它们的侧栏条目同样会一直显示
			// （用户当时正在看的**可能正是子会话**，删父会话时很常见）。
			if (Number.isFinite(result.childrenAttached) && result.childrenAttached > 0) {
				body.push(jsx("p", { style: WARN, children: copy.deletedChildrenAttached(result.childrenAttached) }, "resultChildren"));
			}
			return jsxs(Modal, {
				open: true,
				onClose: close,
				closeLabel: copy.close,
				title: copy.title,
				// 结果态**不**再用"将永久删除…"那句前瞻描述：已经删完了，那句话就不对了。
				description: undefined,
				footer: jsxs(Fragment, { children: [
					jsx(Button, {
						variant: "outline",
						// 默认焦点：Modal 的 `useModalLayer` 先找 `[data-modal-autofocus]`。
						"data-modal-autofocus": true,
						onClick: close,
						children: copy.close
					})
				] }),
				children: body
			});
		}

		/** 把任意 rejection 归一成一句可读文案。 */
		function messageOf(reason) {
			const message = reason instanceof Error ? reason.message : String(reason ?? "");
			return message.length > 0 ? message : copy.unknownFailure;
		}

		/** 只有 PARTIAL_FAILURE 才带明细；其余一律空数组。 */
		function failedOf(reason) {
			return reason !== null && typeof reason === "object" && Array.isArray(reason.failed) ? reason.failed : [];
		}

		/**
		 * 一行一条失败明细。host 的 `failed` 有两种形状：
		 * core 的 `{ target, phase, code, message }` 与注册表摘标记的 `{ step, message }`，
		 * 这里都兼容（缺字段就跳过，不打印 undefined）。
		 */
		function describeFailure(entry) {
			if (entry === null || typeof entry !== "object") return String(entry);
			const head = [entry.phase ?? entry.step, entry.code, entry.target]
				.filter((part) => typeof part === "string" && part.length > 0)
				.join(" · ");
			const message = typeof entry.message === "string" ? entry.message : "";
			if (head.length === 0) return message;
			return message.length === 0 ? head : `${head} — ${message}`;
		}
		//#endregion

		//#region 同源调用
		/**
		 * 调 host 路由。**不把非 2xx 当崩溃**：body 一律解析后按 `code` 分支，
		 * 失败时抛一个带 `.failed` / `.code` 的 Error 交给弹窗展示。
		 * ⚠️ 名字不能叫 `requestSessionDelete`：`apply` 里那个同名的是「写入待删请求」的
		 * store setter，同名会把这里遮蔽掉，删除会静默不发请求（本任务实测踩过）。
		 */
		async function postSessionDelete(sessionId) {
			const response = await fetch(DELETE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			const payload = await response.json().catch(() => void 0);
			const result = payload !== null && typeof payload === "object" ? payload : void 0;
			if (result === void 0) throw deleteFailure(copy.badResponse, [], `HTTP_${String(response.status)}`);
			if (result.ok !== true) {
				const message = result.code === "SESSION_ACTIVE"
					? copy.sessionActive
					: typeof result.message === "string" && result.message.length > 0 ? result.message : copy.unknownFailure;
				const failed = result.code === "PARTIAL_FAILURE" && Array.isArray(result.failed) ? result.failed : [];
				throw deleteFailure(message, failed, result.code ?? `HTTP_${String(response.status)}`);
			}
			// ⚠️ 有意**不读** clearedArchive / clearedPin（语义偏松）。
			return result;
		}

		/** 带明细的失败：Error 上加 code / failed 两个字段供弹窗分支。 */
		function deleteFailure(message, failed, code) {
			const error = new Error(message);
			error.name = "SessionDeleteError";
			error.code = code;
			error.failed = failed;
			return error;
		}

		/**
		 * 调 host 的 **dryRun**（只统计子代理会话，**一个字节都不改**）。
		 * 与真删**分开命名**：它返回计划而**不是**删除结果，形状也对不上
		 * （`ok:true` + `dryRun:true` + `children`），混用会把"统计"当成"删过了"。
		 * 任何非 2xx / 形状不符都抛 —— 由调用方 `startDryRun` 吞掉并降级成"未统计"：
		 * **统计失败绝不能影响删除本身**。
		 */
		async function postSessionDryRun(sessionId) {
			const response = await fetch(DELETE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				// 只有 dryRun 才带这个字段：真删的请求体保持 `{ sessionId }` 不变。
				body: JSON.stringify({ sessionId, dryRun: true })
			});
			const payload = await response.json().catch(() => void 0);
			if (payload === null || typeof payload !== "object" || payload.ok !== true || payload.dryRun !== true) {
				throw deleteFailure(copy.planUnavailable, [], `HTTP_${String(response.status)}`);
			}
			return payload;
		}
		//#endregion

		//#region 剪贴板（三级路径：writeText → execCommand 兜底 → 交给用户手抄）
		/**
		 * 把文本写进剪贴板；**返回是否成功，任何失败都只返回 false，绝不抛**。
		 * 路径一：`navigator.clipboard.writeText`（需要安全上下文 / 用户手势，失败很常见）。
		 * 路径二：临时 textarea + `document.execCommand("copy")`（已弃用，但权限被拒时是唯一还能用的路）。
		 */
		async function copyTextToClipboard(text) {
			if (typeof text !== "string" || text.length === 0) return false;
			try {
				const clipboard = typeof navigator === "undefined" || navigator === null ? void 0 : navigator.clipboard;
				if (clipboard !== void 0 && clipboard !== null && typeof clipboard.writeText === "function") {
					await clipboard.writeText(text);
					return true;
				}
			} catch (error) {
				// 不静默：被拒的原因（NotAllowedError / 非安全上下文）要能在 Console 里看到
				console.warn("[session-delete] navigator.clipboard.writeText 失败，改用 execCommand 兜底：", error);
			}
			return copyTextViaExecCommand(text);
		}

		/** 兜底：临时 textarea + `document.execCommand("copy")`。用完**无论成败**都把节点摘掉。 */
		function copyTextViaExecCommand(text) {
			try {
				if (typeof document === "undefined" || document === null) return false;
				const body = document.body;
				if (body === undefined || body === null || typeof document.createElement !== "function") return false;
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				body.appendChild(area);
				try {
					area.select();
					if (typeof area.setSelectionRange === "function") area.setSelectionRange(0, area.value.length);
					return document.execCommand("copy") === true;
				} finally {
					if (typeof area.remove === "function") area.remove();
					else body.removeChild(area);
				}
			} catch (error) {
				console.warn("[session-delete] execCommand(\"copy\") 兜底也失败：", error);
				return false;
			}
		}
		//#endregion

		exports.name = "session-delete-client";
		// ⛔ **不挂任何硬门禁**（这里原本是 `["slots"]`）。理由已在源码层面核实（2026-09-26）：
		// 渲染端的 web boot 门禁是**全有全无**的 —— `dsh-web-frontend/dist/assets/index-*.js` 里
		// `for (const s of e.loader.entries()) { … if (u !== "active") … throw new Error("web boot: N entry did not activate") }`，
		// 对 `pending`（等服务）与 `failed`（apply 抛错）**一视同仁**。所以硬门禁 `["slots"]`
		// 一旦遇到 slots 未就绪，本 entry 就停在 pending ⇒ **整个应用起不来**（真实事故形态）。
		// 服务一律走嵌套 `ctx.inject([...], (scope) => …)`：外层 entry 立刻 active，
		// 最坏只是"这块 UI 不出现"。
		exports.inject = [];

		/**
		 * apply 的**最外层**包装：任何异常都只 `console.error` 后正常返回。
		 * 漏出去 ⇒ fiber 变 `failed` ⇒ 撞上 web boot 全有全无门禁 ⇒ 应用启动中止。
		 */
		exports.apply = function apply(ctx) {
			try {
				applySessionDeleteClient(ctx);
			} catch (error) {
				console.error("[session-delete] apply 抛出异常，已吞掉（避免整个应用启动失败）：", error);
			}
		};

		/**
		 * 只读诊断（**给离线验证台/探针用**，不参与任何运行时行为）。
		 * 用「正面断言」代替日志：样式注入这类"静默降级"的资源，靠这里查是否真的生效，
		 * 从而既不打日志（保持"正常路径零日志"）又能被测到。
		 */
		exports.__clientDiagnostics = () => ({
			stylesInjected,
			portal: createPortal !== null,
			moduleLoaderRegistered: true
		});

		/** 真正的接线主体：只由上面的 `apply` 调用，异常由上层兜底。 */
		function applySessionDeleteClient(ctx) {
			// 样式**一次性**注入 `document.head`（组件里不再各自渲染 `<style>`，避免每行菜单一份）；
			// 挂在 `ctx.effect` 上，插件卸载时自动移除。
			// **静默降级**：`ctx.effect` 或 `document` 不可用（精减上下文 / 非浏览器环境）只意味着
			// 外观退化，不是异常 ⇒ **不打日志**。这里绝不允许打穿 `apply`（那会变成 client entry
			// `failed` ⇒ 撞 web boot 全有全无门禁）。样式是否真的注入，由离线探针
			// `probe-style-injection.mjs` 用 `__clientDiagnostics()` 正面断言。
			try {
				const effect = typeof ctx.effect === "function" ? ctx.effect : null;
				const doc = typeof document === "undefined" ? null : document;
				if (effect !== null && doc !== null && doc.head !== undefined && doc.head !== null && typeof doc.createElement === "function") {
					effect(() => {
						const style = doc.createElement("style");
						style.setAttribute("data-dsh-plugin", "session-delete");
						style.textContent = CLIENT_STYLE_TEXT;
						doc.head.appendChild(style);
						stylesInjected = true;
						return () => {
							try {
								style.remove();
							} catch (error) {
								// 移除失败无害（页面卸载时一并消失）
							}
							stylesInjected = false;
						};
					}, "session-delete: styles");
				}
			} catch (error) {
				// 同上：注入失败只退化外观，不打日志、不外抛。
				stylesInjected = false;
			}

			/** 菜单行与弹窗共享的待删请求（`null` = 无请求）。 */
			const deleteRequest = createSnapshotStore(null);
			/** 复制反馈（`null` = 无提示）。与删除请求**共用**同一个 overlay entry。 */
			const copyNotice = createSnapshotStore(null);
			/**
			 * dryRun 的统计计划（`null` = 未统计；`{ token, state: "loading"|"ready"|"failed", plan? }`）。
			 * 与待删请求**分成两个 store**：请求体的形状（`{ sessionId, displayTitle }`）保持不变，
			 * 统计的每一次回填也不会把"待删请求"这个状态搅浑。
			 */
			const deletePlan = createSnapshotStore(null);
			/**
			 * 删除**成功**后的结果态（`null` = 还没有结果）。
			 * Task 9 起它**不会自动消失**：删完磁盘之后"真相还没说完"（会话可能仍 attached、
			 * 侧栏那一行还会在），所以结果必须**留在屏幕上**直到用户点「关闭」。
			 */
			const deleteResult = createSnapshotStore(null);
			/** 复制提示的自动消失计时器（只服务 `copyNotice` 这一条路径）。 */
			const noticeTimers = new Map();
			let copyNoticeSeq = 0;
			let deleteResultSeq = 0;
			let planSeq = 0;
			// ⛔ 这里**没有**会话服务（`sessions`）的接线 —— Task 9 按根因整体删除了，
			// 理由见下面 `performSessionDelete` 里那段注释（一句话：拉列表会把 attached 会话的行拉回来）。

			const requestSessionDelete = (sessionId, displayTitle) => {
				// 新的一次删除必须从**干净**的确认态开始：上一次的结果（持久结果态）绝不能带过来，
				// 否则下一行菜单一打开就看到"上一行删过了"。
				deleteResult.set(null);
				deleteRequest.set({
					sessionId,
					displayTitle: typeof displayTitle === "string" && displayTitle.length > 0 ? displayTitle : sessionId
				});
				// **弹窗已经打开**之后才发起统计：异步、不 await、不阻塞弹窗
				// （用户点开就能看到确认框；统计结果晚到就晚填那一行）。
				startDryRun(sessionId);
			};
			const settleSessionDelete = () => {
				deleteRequest.set(null);
				// 计划必须跟着请求一起清：否则下一行菜单会先看到**上一行**的统计结果。
				deletePlan.set(null);
				// 结果同理：清掉之后 overlay 才回到 `null`（弹窗真正消失）。
				deleteResult.set(null);
			};

			/**
			 * 显示一条会**自动消失**的提示（Task 9 起只剩"复制会话 ID"这条路径用它）。
			 * token 守卫：只有"仍是最新那条"才允许被计时器清空 —— 否则上一条的计时器
			 * 会把刚弹出来的新提示提前抹掉。
			 * 计时器不可用时**宁可让提示留在屏幕上**（用户仍能看到内容），也不丢信息。
			 */
			const showNotice = (store, notice) => {
				store.set(notice);
				const previous = noticeTimers.get(store);
				if (previous !== void 0) {
					try {
						clearTimeout(previous);
					} catch {
						// 忽略：旧计时器即使没清掉，token 守卫也会拦住它
					}
					noticeTimers.delete(store);
				}
				try {
					const timer = setTimeout(() => {
						noticeTimers.delete(store);
						const current = store.getSnapshot();
						if (current !== null && current !== void 0 && current.token === notice.token) store.set(null);
					}, COPY_NOTICE_MS);
					noticeTimers.set(store, timer);
				} catch (error) {
					console.warn("[session-delete] 提示的自动消失计时器不可用（提示将一直显示）：", error);
				}
			};

			/**
			 * 回填统计结果。三层守卫：
			 *  1) token —— 只有"仍是本次点击发起的那一轮"才允许被回填（换了一行菜单就作废）；
			 *  2) settled —— 已经定论过（超时 / 已回填）就不许再改：迟到的响应**不能复活**状态行；
			 *  3) 任何异常都吞掉 —— 统计失败**永远**不能影响删除。
			 */
			const settleDeletePlan = (token, value) => {
				const current = deletePlan.getSnapshot();
				if (current === null || current === void 0 || current.token !== token) return;
				if (current.settled === true) return;
				deletePlan.set(Object.assign({}, value, { settled: true }));
			};

			/**
			 * 发起统计（dryRun）。**绝不抛、绝不 await**：
			 * 失败或超时都降级为"未统计"——状态行消失、删除键保持可用。
			 */
			const startDryRun = (sessionId) => {
				try {
					const token = (planSeq += 1);
					deletePlan.set({ token, state: "loading", sessionId });
					let timer;
					try {
						timer = setTimeout(() => {
							// 超时：降级成"未统计"。`settled` 守卫保证迟到的响应不会把它复活。
							settleDeletePlan(token, { token, state: "failed", sessionId });
						}, DRY_RUN_TIMEOUT_MS);
					} catch (error) {
						timer = void 0;
						console.warn("[session-delete] 统计的超时计时器不可用：", error);
					}
					const finish = (value) => {
						if (timer !== void 0) {
							try {
								clearTimeout(timer);
							} catch {
								// 忽略：清不掉也不影响（回填已发生，守卫会拦住超时回调）
							}
						}
						settleDeletePlan(token, value);
					};
					postSessionDryRun(sessionId).then(
						(plan) => { finish({ token, state: "ready", sessionId, plan }); },
						() => { finish({ token, state: "failed", sessionId }); }
					).catch(() => {});
				} catch (error) {
					// 极端情况（store 被换掉等）：只记一条日志，绝不打穿到菜单行的 onSelect
					console.warn("[session-delete] 统计子代理会话失败，按未统计处理：", error);
				}
			};

			/**
			 * 显示一条复制提示，并安排 `COPY_NOTICE_MS` 后自动消失。
			 */
			const showCopyNotice = (notice) => {
				showNotice(copyNotice, notice);
			};

			/**
			 * 复制会话 id。**必须有反馈**：先无条件把 id 摆到屏幕上（"正在复制"也是一条反馈），
			 * 剪贴板结果回来后再回填成「已复制」或「复制失败，请手动复制」。
			 * 全程不抛 —— 菜单行的 `onSelect` 里抛错会变成一个没人接的未处理错误。
			 */
			const copySessionId = (sessionId) => {
				try {
					const id = typeof sessionId === "string" ? sessionId : String(sessionId ?? "");
					const token = (copyNoticeSeq += 1);
					const settle = (state) => {
						const current = copyNotice.getSnapshot();
						// 已消失（2 秒过去了）或被新的一次复制取代 ⇒ 不"复活"旧提示
						if (current === null || current === void 0 || current.token !== token) return;
						copyNotice.set({ token, sessionId: id, state });
					};
					showCopyNotice({ token, sessionId: id, state: "pending" });
					copyTextToClipboard(id).then(
						(copied) => { settle(copied === true ? "copied" : "manual"); },
						() => { settle("manual"); }
					).catch(() => {});
				} catch (error) {
					// 极端情况（showCopyNotice/set 被换掉）也不许打穿到菜单行的 onSelect
					console.error("[session-delete] 复制会话 ID 失败：", error);
				}
			};

			const performSessionDelete = async (sessionId) => {
				const result = await postSessionDelete(sessionId);
				// ⛔⛔ **这里绝不再有任何"主动拉列表"动作。**（旧代码在这里调了一次 `sessions.refresh()`，
				// 那正是"闪一下"的第二个根因，Task 9 已整体删除，接线也一起删了。）理由：
				//   宿主侧栏列表 = **attached**（内存里活着的）+ **persisted**（磁盘上的）
				//   （`dsh-api-session-controller` 的 `ApiSessionList.list()` JSDoc 原文）。
				//   我们只删掉了 persisted 那一半；会话若被打开过就仍 attached，**主动拉列表会把
				//   刚被 `api-session/removed` 掉掉的那一行重新加回来** ⇒ 用户看到"闪一下"然后行还在。
				//   掉行由官方那条广播负责（host `ctx.emit("api-session/removed")`，客户端本就订阅它），
				//   我们只负责**如实**告诉用户"这一行可能还会在"（见下面的 attached 三态文案）。
				// ⚠️ 同理**不要**用别的办法去重取列表（`sessions` 服务的其他接口、直接 fetch 列表路由…）：
				// 在宿主摘不掉 attached 会话的前提下，任何重取都会把行拉回来。
				const deletedChildren = Array.isArray(result?.children?.deleted) ? result.children.deleted.length : 0;
				const childrenAttached = Array.isArray(result?.children?.attached) ? result.children.attached.length : 0;
				// **持久**结果：这里只能 `set`，**不能**走 `showNotice`（那套 2 秒后自动清空）。
				// `attached` 原样带过去（true / false / undefined）——判不了就走通用兜底文案。
				deleteResult.set({
					token: (deleteResultSeq += 1),
					sessionId: typeof result?.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : sessionId,
					state: "deleted",
					attached: result?.attached,
					children: deletedChildren,
					childrenAttached
				});
				return result;
			};

			// 槽位注册：**只用嵌套注入**（理由见上面 `exports.inject` 处），绝不用裸的
			// `ctx.slots` —— 服务没就绪时 `ctx.slots` 是 undefined，`.inject` 直接
			// TypeError 打穿 apply。两处注册各自 try/catch：菜单行失败不连累弹窗，反之亦然。
			try {
				ctx.inject(["slots"], (scope) => {
					try {
						scope.slots.inject(MENU_SLOT, function* () {
							// 一次 inject 里 yield 两次 = 同一个 list 槽位上的两行。
							// 合法性已在本机源码核实：cordis 的 effect **迭代**生成器并把每个 yield 值
							// 都收作 disposer（`@deepseek-ai/cordis/lib/index.js:1146-1153`
							// 的 `while (true) { const r = iter.next(); safeCollect(r.value); if (r.done) return; }`）。
							// 两行放在**同一个** inject/try 里，兜底边界仍是"菜单这块失败不影响弹窗那块"。
							yield scope.slots.register({
								name: MENU_SLOT,
								id: "session-delete",
								order: 500,
								inject: () => ({
									requestSessionDelete
								})
							}, SessionDeleteMenuItem);
							// 只读动作，排在删除（500）之前、官方 archive（400）之后。
							yield scope.slots.register({
								name: MENU_SLOT,
								id: "session-delete-copy-id",
								order: 450,
								inject: () => ({
									copySessionId
								})
							}, SessionCopyIdMenuItem);
						});
					} catch (error) {
						console.error("[session-delete] 菜单行槽位注册失败（仅少菜单行，不影响启动）：", error);
					}

					try {
						scope.slots.inject(OVERLAY_SLOT, function* () {
							yield scope.slots.register({
								name: OVERLAY_SLOT,
								id: "session-delete-confirm",
								inject: () => ({
									// 四个 store 走同一个 entry 的 hooks：overlay 自己按状态分派
									// （deleteRequest → 确认弹窗；deleteResult → 成功提示；
									//   deletePlan → 弹窗里的子代理会话状态行；copyNotice → 复制提示）
									hooks: { deleteRequest, copyNotice, deletePlan, deleteResult },
									settleSessionDelete,
									performSessionDelete
								})
							}, SessionDeleteOverlay);
						});
					} catch (error) {
						console.error("[session-delete] 弹窗槽位注册失败（仅少一个确认弹窗，不影响启动）：", error);
					}
				});
			} catch (error) {
				console.error("[session-delete] 嵌套注入 slots 服务失败（菜单行与弹窗均不注册，不影响启动）：", error);
			}
		}

		return module.exports;
	}
});
