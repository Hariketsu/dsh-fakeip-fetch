window.__ModuleLoader__.load({
	id: "dsh-fakeip-fetch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { createElement: h, useEffect, useRef, useState } = React;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const Button = primitives.Button;
		const Input = primitives.Input;
		const Tag = primitives.Tag;
		const SettingsForm = primitives.SettingsForm;
		const SettingsValueField = primitives.SettingsValueField;

		/** Settings namespace: this plugin's Loader row id. */
		const NS = "fakeip-fetch";
		/** Plugin-manager row key: `<package>#<row id>`. */
		const ROW_KEY = "dsh-fakeip-fetch#fakeip-fetch";
		/** Host route returning this machine's own DNS answers. */
		const PROBE_PATH = "/fakeip-fetch/probe";
		/** Host route returning the last startup self check. */
		const SELFCHECK_PATH = "/fakeip-fetch/selfcheck";

		/** Typography and surfaces shared with the product's own settings pages. */
		const css = {
			section: { minWidth: 0, padding: "16px 0" },
			heading: { margin: 0, fontSize: "13px", fontWeight: "600", lineHeight: "1.5", color: "var(--dsw-alias-label-primary)" },
			desc: { margin: "6px 0 0", fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-secondary)" },
			meta: { fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-secondary)" },
			error: { margin: "8px 0 0", fontSize: "12px", lineHeight: "1.5", color: "var(--dsw-alias-label-error)" },
			row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
			field: { display: "flex", flexDirection: "column", gap: "6px" },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(220px, 100%), 1fr))", gap: "0 16px" },
			list: {
				marginTop: "10px",
				border: "0.5px solid var(--dsw-alias-border-l2)",
				borderRadius: "var(--dsw-radius-md)",
				overflow: "hidden",
			},
			listRow: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px" },
			listRowDivider: { borderTop: "0.5px solid var(--dsw-alias-border-l2)" },
			tagRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginTop: "8px" },
			header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
			actions: { marginTop: "10px", display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
			mono: { fontVariantNumeric: "tabular-nums" },
			input: {
				flex: 1, minWidth: 0, height: "34px", padding: "0 12px",
				border: "0.5px solid var(--dsw-alias-border-l4)",
				borderRadius: "var(--dsw-radius-md)",
				background: "var(--dsw-alias-bg-layer-3)",
				font: "inherit", fontSize: "13px", lineHeight: "1.5",
				color: "var(--dsw-alias-label-primary)",
			},
		};

		function validCidrV4(text) {
			const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(0|[1-9]\d?)$/.exec(String(text).trim());
			if (match === null) return false;
			const octets = match[1].split(".");
			if (octets.some(part => Number(part) > 255 || (part.length > 1 && part.startsWith("0")))) return false;
			return Number(match[2]) <= 32;
		}

		function validCidrV6(text) {
			const match = /^([0-9a-fA-F:.]+)\/(0|[1-9]\d{0,2})$/.exec(String(text).trim());
			if (match === null) return false;
			if (Number(match[2]) > 128) return false;
			try { return new URL(`http://[${match[1]}]/`).hostname.startsWith("["); }
			catch (_invalidAddress) { return false; }
		}

		function validCidr(text) {
			return validCidrV4(text) || validCidrV6(text);
		}

		function errorText(error) {
			if (error && typeof error.message === "string" && error.message.length > 0) return error.message;
			return String(error);
		}

		function formatTime(iso) {
			try {
				return new Date(iso).toLocaleString();
			} catch (_unparsableDate) {
				return String(iso);
			}
		}

		function Section(props) {
			return h("section", { style: css.section },
				h("div", { style: css.header },
					h("h3", { style: css.heading }, props.title),
					props.accessory ?? null,
				),
				props.desc === undefined ? null : h("p", { style: css.desc }, props.desc),
				props.children,
			);
		}

		/** Chips describing one DNS answer set and whether each answer lands inside the configured ranges. */
		function AnswerChips(answers) {
			const list = Array.isArray(answers) ? answers : [];
			if (list.length === 0) return h("span", { style: css.meta }, "DNS 没有返回地址");
			return h("div", { style: css.tagRow }, list.map((answer, index) => h(Tag, {
				key: index,
				tone: answer.inRange === true ? "success" : "danger",
			}, `${answer.address}${answer.family === 6 ? " · IPv6" : ""} · ${answer.inRange === true ? "在网段内" : "不在网段内"}`)));
		}

		/** Render the DNS probe outcome: answers, range membership, and the suggested /16. */
		function renderProbeResult(probeResult, draftRanges, onAddSuggestion) {
			if (probeResult === null || probeResult === undefined) return null;
			const suggestion = probeResult.suggestion;
			const added = typeof suggestion === "string" && draftRanges.map(item => String(item).trim()).includes(suggestion);
			return h("div", null,
				h("div", { style: css.tagRow },
					h("span", { style: css.meta }, `本机解析 ${probeResult.host}`),
					AnswerChips(probeResult.answers),
				),
				typeof suggestion !== "string" || added
					? null
					: h("div", { style: { ...css.tagRow, marginTop: "6px" } },
						h("span", { style: css.meta }, `建议网段 ${suggestion}`),
						h(Button, { size: "sm", variant: "outline", onClick: () => onAddSuggestion(suggestion) }, "采纳"),
					),
			);
		}

		/** One-line verdict for the status card. */
		function statusOf(payload, error) {
			if (error) return { tone: "warning", text: "状态未知" };
			if (payload !== null && payload !== undefined && payload.conflict !== undefined && payload.conflict !== null) {
				return { tone: "danger", text: "provider 冲突" };
			}
			const state = payload !== null && payload !== undefined ? payload.state : undefined;
			if (state === null || state === undefined) return { tone: "neutral", text: "待自检" };
			const supported = state.versionCheck !== undefined && state.versionCheck !== null ? state.versionCheck.supported : undefined;
			if (supported === false) return { tone: "warning", text: "宿主不支持" };
			const fetch = state.fetch;
			if (fetch === null || fetch === undefined) return { tone: "neutral", text: "待自检" };
			if (fetch.skipped === "no-ranges") return { tone: "neutral", text: "未配置网段" };
			if (fetch.ok === true) return { tone: "success", text: "运行中" };
			return { tone: "danger", text: "抓取失败" };
		}

		/** The self-check lines: build identity, network verdict, and the DNS answers it saw. */
		function renderSelfCheck(payload, error) {
			if (error) return h("p", { style: css.error }, `自检状态读取失败：${error}`);
			if (payload === null || payload === undefined) return h("p", { style: css.meta }, "尚未运行自检；每次启动都会做版本检查，指纹变化时自动跑网络自检。");
			const state = payload.state;
			if (state === null || state === undefined) return h("p", { style: css.meta }, "尚未运行自检。");
			const stale = payload.fingerprint !== undefined && state.fingerprint !== payload.fingerprint;
			const versionCheck = state.versionCheck !== undefined && state.versionCheck !== null ? state.versionCheck : undefined;
			const fetch = state.fetch;
			let verdict;
			if (stale) verdict = "宿主或插件已变化，本次启动正在重跑自检…";
			else if (versionCheck !== undefined && versionCheck.supported !== true) verdict = "当前 DSH 构建不支持 Fake-IP 放行（可注入地址解析器不可用），已降级为内置行为。";
			else if (fetch !== null && fetch !== undefined && fetch.skipped === "no-ranges") verdict = "已跳过网络自检：还没有配置网段。";
			else if (fetch !== null && fetch !== undefined && fetch.ok === true) {
				verdict = `通过 · ${fetch.path === "fallback" ? "Fake-IP 备选路径" : "直连路径"} · ${fetch.ms} ms · HTTP ${fetch.status}`;
			} else {
				const reason = fetch === null || fetch === undefined ? "未知原因" : (fetch.code !== undefined ? fetch.code : fetch.message);
				verdict = `失败：${String(reason)}`;
			}
			return h("div", null,
				versionCheck === undefined
					? null
					: h("p", { style: { ...css.meta, margin: "0 0 4px" } }, `版本检查 ${formatTime(versionCheck.checkedAt)} · 插件 ${versionCheck.pluginVersion} · 宿主传输 ${versionCheck.providerVersion} · 解析器 ${versionCheck.supported === true ? "可用" : "不可用"}`),
				h("p", { style: { ...css.meta, margin: 0 } }, `网络自检 ${formatTime(state.checkedAt)} · ${verdict}`),
				h("div", { style: css.tagRow },
					h("span", { style: css.meta }, "DNS"),
					AnswerChips(state.dns !== null && state.dns !== undefined ? state.dns.answers : []),
				),
			);
		}

		/** The settings page: quiet status, one ranges control, then self check and advanced transport fields. */
		function LocalFetchPage(props) {
			const form = props.form;
			const state = form === undefined ? undefined : form.state;
			const value = state && state.value !== undefined && state.value !== null ? state.value : {};
			const revision = state === undefined ? undefined : state.revision;
			const writable = state === undefined ? true : state.writable !== false;
			const configuredRanges = Array.isArray(value.fakeIpRanges) ? value.fakeIpRanges : [];
			const configuredLimits = {
				maxResponseBytes: String(value.maxResponseBytes === undefined ? 5000000 : value.maxResponseBytes),
				maxBodyChars: String(value.maxBodyChars === undefined ? 100000 : value.maxBodyChars),
				timeoutMs: String(value.timeoutMs === undefined ? 30000 : value.timeoutMs),
				maxRedirects: String(value.maxRedirects === undefined ? 5 : value.maxRedirects),
				userAgent: String(value.userAgent === undefined ? "" : value.userAgent),
			};
			const [draftRanges, setDraftRanges] = useState(() => configuredRanges.map(String));
			const [draftLimits, setDraftLimits] = useState(configuredLimits);
			const [saving, setSaving] = useState(false);
			const [failed, setFailed] = useState(false);
			const [probeError, setProbeError] = useState("");
			const [probing, setProbing] = useState(false);
			const [probeResult, setProbeResult] = useState(null);
			const [selfCheck, setSelfCheck] = useState(null);
			const [selfCheckError, setSelfCheckError] = useState("");
			const [selfChecking, setSelfChecking] = useState(false);
			const revisionRef = useRef(revision);

			const seed = () => {
				setDraftRanges((Array.isArray(value.fakeIpRanges) ? value.fakeIpRanges : []).map(String));
				setDraftLimits(configuredLimits);
				setFailed(false);
			};

			useEffect(() => {
				if (revisionRef.current === revision) return;
				revisionRef.current = revision;
				seed();
			}, [revision, value]);

			useEffect(() => {
				let cancelled = false;
				void (async () => {
					try {
						const response = await fetch(SELFCHECK_PATH, { credentials: "same-origin" });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (!cancelled) setSelfCheck(payload);
					} catch (cause) {
						if (!cancelled) setSelfCheckError(errorText(cause));
					}
				})();
				return () => { cancelled = true; };
			}, []);

			if (props.view === "summary") {
				const status = statusOf(selfCheck, selfCheckError);
				return h("span", null, `${status.text} · ${configuredRanges.length} 个网段`);
			}
			if (form === undefined) {
				return h(SettingsForm, {
					labels: { unavailable: "配置尚未就绪，稍后再试。", readOnly: "", saveFailed: "", save: "保存", saving: "保存中…" },
					state: { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false },
					onSave: () => {},
					onDiscard: () => {},
				});
			}

			const normalizedRanges = draftRanges.map(item => String(item).trim()).filter(item => item.length > 0);
			const invalidRanges = normalizedRanges.filter(item => !validCidr(item));
			const numericFields = ["maxResponseBytes", "maxBodyChars", "timeoutMs", "maxRedirects"];
			const invalidNumbers = numericFields.filter(field => {
				const number = Number(draftLimits[field]);
				return !Number.isSafeInteger(number) || number < (field === "maxRedirects" ? 0 : 1)
					|| (field === "timeoutMs" && number > 2147483647);
			});
			const invalidAgent = draftLimits.userAgent.trim().length === 0 || /[\r\n]/.test(draftLimits.userAgent);
			const rangesDirty = JSON.stringify(normalizedRanges) !== JSON.stringify(configuredRanges.map(item => String(item).trim()));
			const limitsDirty = JSON.stringify(draftLimits) !== JSON.stringify(configuredLimits);
			const dirty = rangesDirty || limitsDirty;
			const invalid = invalidRanges.length > 0 || invalidNumbers.length > 0 || invalidAgent;

			const onSave = () => {
				if (invalid) return;
				setSaving(true);
				setFailed(false);
				const ops = [{ op: "set", path: ["fakeIpRanges"], value: normalizedRanges }];
				for (const field of numericFields) ops.push({ op: "set", path: [field], value: Number(draftLimits[field]) });
				ops.push({ op: "set", path: ["userAgent"], value: draftLimits.userAgent.trim() });
				void (async () => {
					try {
						const accepted = await form.mutate(ops, revision);
						if (accepted !== true) setFailed(true);
					} catch (_transportFailure) {
						setFailed(true);
					} finally {
						setSaving(false);
					}
				})();
			};

			const runProbe = async () => {
				setProbing(true);
				setProbeError("");
				try {
					const response = await fetch(PROBE_PATH, { credentials: "same-origin" });
					if (!response.ok) throw new Error(`探测接口返回 HTTP ${response.status}`);
					setProbeResult(await response.json());
				} catch (cause) {
					setProbeError(`探测失败：${errorText(cause)}`);
				} finally {
					setProbing(false);
				}
			};

			const rerunSelfCheck = async () => {
				setSelfChecking(true);
				setSelfCheckError("");
				try {
					const response = await fetch(SELFCHECK_PATH, { method: "POST", credentials: "same-origin" });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					setSelfCheck(await response.json());
				} catch (cause) {
					setSelfCheckError(errorText(cause));
				} finally {
					setSelfChecking(false);
				}
			};

			const status = statusOf(selfCheck, selfCheckError);
			const routePluginVersion = selfCheck !== null && selfCheck !== undefined && selfCheck.pluginVersion !== undefined ? selfCheck.pluginVersion : "";
			const routeProviderVersion = selfCheck !== null && selfCheck !== undefined && selfCheck.providerVersion !== undefined ? selfCheck.providerVersion : "";
			const supported = selfCheck !== null && selfCheck !== undefined && selfCheck.state !== null && selfCheck.state !== undefined
				&& selfCheck.state.versionCheck !== undefined && selfCheck.state.versionCheck !== null
				? selfCheck.state.versionCheck.supported
				: undefined;
			const conflict = selfCheck !== null && selfCheck !== undefined && selfCheck.conflict !== undefined && selfCheck.conflict !== null ? selfCheck.conflict : undefined;

			return h(SettingsForm, {
				labels: {
					unavailable: "该 profile 没有暴露 fakeip-fetch 配置。",
					readOnly: "当前 profile 配置为只读，无法保存。",
					saveFailed: "保存失败，请重试。",
					save: "保存",
					saving: "保存中…",
				},
				state: { available: true, writable, dirty, invalid, saving, failed },
				onSave,
				onDiscard: seed,
			},
				h(Section, {
					title: "运行状态",
					accessory: h(Tag, { tone: status.tone }, status.text),
				},
					h("p", { style: { ...css.meta, margin: "8px 0 0" } }, conflict === undefined
						? `插件 ${routePluginVersion} · 宿主传输 ${routeProviderVersion} · 解析器 ${supported === false ? "不可用" : "可用"}`
						: `"http" provider 被其他插件占用：多半是旧包 dsh-local-fetch 未卸载，请卸载后重启。`),
				),
				h(Section, {
					title: "Fake-IP 网段",
					desc: "TUN 代理实际使用的地址段；Clash/Mihomo 默认 198.18.0.0/16，IPv6 常见 fd00::/8。不要填 0.0.0.0/0、::/0、私网或回环段。",
					accessory: null,
				},
					h("div", { style: css.list },
						draftRanges.length === 0
							? h("div", { style: { ...css.listRow, ...css.meta } }, "还没有网段；添加一个后抓取即生效。")
							: draftRanges.map((item, index) => h("div", {
								key: index,
								style: index === 0 ? css.listRow : { ...css.listRow, ...css.listRowDivider },
							},
								h("input", {
									value: item,
									placeholder: "198.18.0.0/16",
									style: css.input,
									onChange: (event) => {
										const next = draftRanges.slice();
										next[index] = event.target.value;
										setDraftRanges(next);
										setFailed(false);
									},
								}),
								validCidr(item) || String(item).trim().length === 0
									? null
									: h(Tag, { tone: "danger" }, "格式不对"),
								h(Button, {
									size: "sm",
									variant: "ghost",
									disabled: saving,
									onClick: () => {
										setDraftRanges(draftRanges.filter((_, i) => i !== index));
										setFailed(false);
									},
								}, "删除"),
							)),
					),
					invalidRanges.length > 0
						? h("p", { style: css.error }, `网段格式不对：${invalidRanges.join(", ")}（支持 IPv4/IPv6 CIDR）`)
						: null,
					h("div", { style: css.actions },
						h(Button, { size: "sm", variant: "outline", disabled: saving, onClick: () => { setDraftRanges([...draftRanges, "198.18.0.0/16"]); setFailed(false); } }, "添加网段"),
						h(Button, { size: "sm", variant: "ghost", disabled: probing, onClick: runProbe }, probing ? "探测中…" : "探测本机 DNS"),
					),
					probeError.length > 0 ? h("p", { style: css.error }, probeError) : null,
					probeResult === null ? null : renderProbeResult(probeResult, draftRanges, (suggestion) => {
						if (draftRanges.map(item => String(item).trim()).includes(suggestion)) return;
						setDraftRanges([...draftRanges, suggestion]);
						setFailed(false);
					}),
				),
				h(Section, {
					title: "自检",
					accessory: h(Button, { size: "sm", variant: "outline", disabled: selfChecking, onClick: rerunSelfCheck }, selfChecking ? "自检中…" : "重跑自检"),
				},
					renderSelfCheck(selfCheck, selfCheckError),
				),
				h(Section, {
					title: "高级传输设置",
					desc: "一般不需要改；只在超时、响应过大或站点拒绝默认 UA 时调整。",
				},
					h("div", { style: css.grid },
						h(SettingsValueField, {
							id: "fakeip-fetch-max-response-bytes",
							label: "响应上限（字节）",
							hint: "单次响应读取的最大字节数",
							text: draftLimits.maxResponseBytes,
							numeric: true,
							overridden: false,
							invalid: invalidNumbers.includes("maxResponseBytes"),
							overriddenLabel: "",
							resetLabel: "",
							invalidLabel: "必须是正整数",
							disabled: saving || !writable,
							onEdit: (text) => { setDraftLimits({ ...draftLimits, maxResponseBytes: text }); setFailed(false); },
							onReset: () => {},
						}),
						h(SettingsValueField, {
							id: "fakeip-fetch-max-body-chars",
							label: "正文上限（字符）",
							hint: "转换后正文保留的最大字符数",
							text: draftLimits.maxBodyChars,
							numeric: true,
							overridden: false,
							invalid: invalidNumbers.includes("maxBodyChars"),
							overriddenLabel: "",
							resetLabel: "",
							invalidLabel: "必须是正整数",
							disabled: saving || !writable,
							onEdit: (text) => { setDraftLimits({ ...draftLimits, maxBodyChars: text }); setFailed(false); },
							onReset: () => {},
						}),
						h(SettingsValueField, {
							id: "fakeip-fetch-timeout-ms",
							label: "超时（毫秒）",
							hint: "单次抓取的总预算，含 Fake-IP 重试",
							text: draftLimits.timeoutMs,
							numeric: true,
							overridden: false,
							invalid: invalidNumbers.includes("timeoutMs"),
							overriddenLabel: "",
							resetLabel: "",
							invalidLabel: "必须是 1 到 2147483647 之间的整数",
							disabled: saving || !writable,
							onEdit: (text) => { setDraftLimits({ ...draftLimits, timeoutMs: text }); setFailed(false); },
							onReset: () => {},
						}),
						h(SettingsValueField, {
							id: "fakeip-fetch-max-redirects",
							label: "重定向次数",
							hint: "同源重定向最多跟随多少跳",
							text: draftLimits.maxRedirects,
							numeric: true,
							overridden: false,
							invalid: invalidNumbers.includes("maxRedirects"),
							overriddenLabel: "",
							resetLabel: "",
							invalidLabel: "必须是非负整数",
							disabled: saving || !writable,
							onEdit: (text) => { setDraftLimits({ ...draftLimits, maxRedirects: text }); setFailed(false); },
							onReset: () => {},
						}),
					),
					h(SettingsValueField, {
						id: "fakeip-fetch-user-agent",
						label: "User-Agent",
						hint: "本机抓取请求使用的 UA",
						text: draftLimits.userAgent,
						overridden: false,
						invalid: invalidAgent,
						overriddenLabel: "",
						resetLabel: "",
						invalidLabel: "不能为空或包含换行",
						disabled: saving || !writable,
						onEdit: (text) => { setDraftLimits({ ...draftLimits, userAgent: text }); setFailed(false); },
						onReset: () => {},
					}),
				),
			);
		}

		/** Keep a render failure inside this page instead of unmounting the Plugins screen. */
		class SettingsErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				if (typeof console !== "undefined" && typeof console.error === "function") {
					console.error("fakeip-fetch settings page failed to render", error);
				}
			}

			render() {
				if (this.state.error !== null) {
					return h("p", { style: css.error }, `设置页渲染出错：${String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}`);
				}
				return this.props.children;
			}
		}

		function LocalFetchPageWithBoundary(props) {
			return h(SettingsErrorBoundary, null, h(LocalFetchPage, props));
		}

		/** Mount the settings page on the plugin manager's row configuration slot. */
		function apply(ctx) {
			ctx.effect(() => ctx.slots.register({
				name: "plugins.row.config",
				key: ROW_KEY,
				order: 10,
			}, LocalFetchPageWithBoundary), "fakeip-fetch: settings page");
		}

		exports.NS = NS;
		exports.ROW_KEY = ROW_KEY;
		exports.LocalFetchPage = LocalFetchPage;
		exports.renderProbeResult = renderProbeResult;
		exports.renderSelfCheck = renderSelfCheck;
		exports.apply = apply;
		exports.inject = ["slots", "configForms"];
		return module.exports;
	}
});
