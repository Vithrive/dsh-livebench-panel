window.__ModuleLoader__.load({
	id: "dsh-livebench-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = react;

		//#region dsh-css:livebench-panel.css
		const css = `.dlb_root{width:100%;max-width:1400px;margin:0 auto;padding:16px 20px 32px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.dlb_head{display:flex;align-items:baseline;gap:10px}
.dlb_head h2{margin:0;font-size:16px;font-weight:600}
.dlb_sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dlb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px}
.dlb_fields{display:flex;flex-direction:column;gap:12px}
.dlb_grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
@media (max-width:860px){.dlb_grid>.dlb_field{grid-column:1/-1 !important}}
.dlb_field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dlb_label{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase;letter-spacing:.02em}
.dlb_select,.dlb_input{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;border-radius:8px;padding:0 8px;outline:none;min-width:0}
.dlb_select:focus-visible,.dlb_input:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
.dlb_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dlb_row{align-items:flex-start}
.dlb_cardHead{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dlb_btn{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:6px 14px;font-size:13px;border:1px solid transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.dlb_btn:disabled{cursor:default;opacity:.55}
.dlb_btnGhost{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dlb_btnDanger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dlb_badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dlb_badge[data-ok="1"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.dlb_badge[data-ok="0"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.dlb_log{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dlb_tableWrap{overflow:auto;max-height:min(64vh,620px);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dlb_table{table-layout:fixed;border-collapse:separate;border-spacing:0;font-size:11.5px}
.dlb_table th,.dlb_table td{padding:4px 5px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;vertical-align:middle;text-align:left;overflow:hidden;text-overflow:ellipsis}
.dlb_table td{height:34px}
.dlb_table thead th{color:var(--dsw-alias-label-tertiary);font-weight:500;background:var(--dsw-alias-bg-layer-2);position:sticky;top:0;z-index:3}
.dlb_table thead tr.dlb_catRow th{top:0;height:20px;padding:0 6px;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;background:var(--dsw-alias-bg-layer-1);cursor:default}
.dlb_table thead tr.dlb_thRow th{top:20px;height:26px;font-size:11px;box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2)}
.dlb_table tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--dsw-alias-fill-l1,rgba(255,255,255,.04)) 55%,transparent)}
.dlb_table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}
.dlb_stick{position:sticky;background:var(--dsw-alias-bg-layer-2);z-index:2}
.dlb_table thead tr.dlb_catRow th.dlb_stick{z-index:5}
.dlb_table thead tr.dlb_thRow th.dlb_stick{z-index:5}
.dlb_table tbody tr:nth-child(even) .dlb_stick{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 90%,var(--dsw-alias-fill-l1,rgba(255,255,255,.05)))}
.dlb_table tbody tr:hover .dlb_stick{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,var(--dsw-alias-state-business-primary))}
.dlb_grpStart{border-left:1px solid var(--dsw-alias-border-l2) !important}
.dlb_cellScore{text-align:center !important;font-variant-numeric:tabular-nums;font-weight:600;padding-left:2px !important;padding-right:2px !important}
.dlb_cellSub{font-size:9px;font-weight:400;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dlb_thTask{font-size:10.5px !important;text-align:center !important;cursor:default}
.dlb_modelCell{padding-left:8px !important}
.dlb_modelName{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.dlb_dim{opacity:.35;font-weight:400}
.dlb_timeCell{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:center !important}
.dlb_sHigh{color:var(--dsw-alias-state-success-primary)}
.dlb_sMid{color:var(--dsw-alias-state-warning-primary,#d08700)}
.dlb_sLow{color:var(--dsw-alias-state-error-primary)}
.dlb_score{font-variant-numeric:tabular-nums;font-weight:600}
.dlb_error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0}
.dlb_hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin:0;line-height:1.5}
.dlb_notice{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dlb_noticeTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.dlb_steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dlb_code{display:block;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;user-select:all}
.dlb_details{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 14px}
.dlb_details summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);user-select:none}
.dlb_details summary:hover{color:var(--dsw-alias-label-primary)}
.dlb_details[open] summary{margin-bottom:10px;color:var(--dsw-alias-label-primary)}
.dlb_helpTable{width:100%;border-collapse:collapse;font-size:12px}
.dlb_helpTable th,.dlb_helpTable td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dlb_helpTable th{color:var(--dsw-alias-label-tertiary);font-weight:500;white-space:nowrap}
.dlb_helpTable td{color:var(--dsw-alias-label-secondary);line-height:1.55}
.dlb_helpP{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dlb_chips{display:flex;flex-wrap:wrap;gap:6px}
.dlb_chip{appearance:none;font:inherit;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 12px;font-size:12px;line-height:18px}
.dlb_chip:disabled{opacity:.4;cursor:not-allowed}
.dlb_chipOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.dlb_btnRow{display:flex;gap:10px;justify-content:center;margin-top:2px}
.dlb_btnBar{min-width:190px;min-height:40px;font-weight:600;text-align:center}
@media (max-width:700px){.dlb_btnRow{flex-wrap:wrap}.dlb_btnBar{max-width:none}}
.dlb_drag{cursor:grab;color:var(--dsw-alias-label-tertiary);text-align:center;user-select:none}`;
		const tagId = "dsh-livebench-panel/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-livebench-panel";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const c = (n) => "dlb_" + n;
		//#endregion

		//#region lib/types/client/livebench.js
		const NS = "livebenchPanel";
		const inject = ["slots", "locale"];

		const API = "/dsh-livebench-panel/api";

		async function api(path, options) {
			const response = await fetch(API + path, options);
			const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
			return payload;
		}

		/** Grouped <select> options: one optgroup per harness provider. */
		function modelOptions(providers, selected) {
			const out = [];
			for (const p of providers) {
				if (p.models.length === 0) continue;
				out.push(h("optgroup", { key: p.id, label: p.name + (p.routable ? "" : " ·未接LiveBench") },
					p.models.map((m) => h("option", { key: p.id + "::" + m.id, value: p.id + "::" + m.id }, `${m.name} — ${p.name}`))));
			}
			if (out.length === 0) {
				out.push(h("option", { value: "" }, "（未发现 harness 模型）"));
			}
			void selected;
			return out;
		}

		function LiveBenchView() {
					const [config, setConfig] = useState(null);
					const [configError, setConfigError] = useState(null);
					// maxTokens 默认 32000（用户口径）：LiveBench 自带默认只有 4096，跑推理模型
					// 会"思考吃满、正文为空"；32k 是够用与耗时之间的折中。难题若出现
					// "思考占满 max-tokens、未产出答案"，把它调到 65536 重跑即可（上限 200k）。
					const [sel, setSel] = useState({ models: [], efforts: {}, cats: [], tasks: [], release: "2024-11-25", begin: "", end: "", maxTokens: "32000", parallel: "1", baseline: null });
					const [modelDdOpen, setModelDdOpen] = useState(false);
					const [busy, setBusy] = useState(false);
					const [running, setRunning] = useState(false);
					const [runsList, setRunsList] = useState([]);
					const [startError, setStartError] = useState(null);
					const [homeInput, setHomeInput] = useState("");
					const [homeBusy, setHomeBusy] = useState(false);
					const [results, setResults] = useState(null);
					const [pickedModels, setPickedModels] = useState(() => new Set());
					const [sortBy, setSortBy] = useState("time");
					const [sortDir, setSortDir] = useState("desc");
					const [modelOrder, setModelOrder] = useState(() => {
						try { return JSON.parse(localStorage.getItem("dlb_model_order_v1")) ?? []; } catch { return []; }
					});
					const dragKey = useRef(null);
			const modelDdRef = useRef(null);

					// 点击面板外部时关闭模型下拉
					useEffect(() => {
						if (!modelDdOpen) return undefined;
						const onDocDown = (event) => {
							if (modelDdRef.current && !modelDdRef.current.contains(event.target)) setModelDdOpen(false);
						};
						document.addEventListener("mousedown", onDocDown);
						return () => document.removeEventListener("mousedown", onDocDown);
					}, [modelDdOpen]);

					const loadConfig = useCallback(async () => {
						const payload = await api("/config");
						if (payload.ok) {
							setConfig(payload);
							setConfigError(null);
							setSel((prev) => {
								const next = { ...prev, release: payload.releases.includes(prev.release) ? prev.release : "2024-11-25" };
								next.models = prev.models.filter((value) => {
									const pid = value.split("::")[0];
									return payload.providers.some((p) => p.id === pid);
								});
								return next;
							});
						} else {
							setConfigError(payload.error ?? "config unavailable");
						}
					}, []);

					const loadResults = useCallback(async () => {
						const payload = await api("/results");
						if (payload.ok) setResults(payload);
					}, []);

					const refreshStatus = useCallback(async () => {
						const payload = await api("/status");
						if (payload.ok) {
							setRunsList(payload.runs ?? []);
							setRunning(payload.running === true);
							return payload.running === true;
						}
						return false;
					}, []);

					useEffect(() => {
						loadConfig();
						loadResults();
						refreshStatus();
					}, [loadConfig, loadResults, refreshStatus]);

					// 轮询评测状态；从运行中转为结束后自动刷新成绩
					const wasRunning = useRef(false);
					useEffect(() => {
						const timer = setInterval(async () => {
							const active = await refreshStatus();
							if (wasRunning.current && !active) loadResults();
							wasRunning.current = active;
						}, 2500);
						return () => clearInterval(timer);
					}, [refreshStatus, loadResults]);

					const categories = useMemo(() => (config ? Object.keys(config.tasks) : []), [config]);
					// 有效题数：LiveBench 丢弃「发布晚于所选 release」与「在所选 release 前已退役」的题目
					const countFor = useCallback((category, task) => {
						if (!config || category.length === 0) return null;
						const meta = (config.tasks[category] ?? {})[task];
						if (!meta || !Array.isArray(meta.buckets)) return null;
						const option = sel.release;
						return meta.buckets.reduce((sum, b) => {
							const releasedOk = b.r !== "" && b.r <= option;
							const notRemoved = b.rm === "" || b.rm > option;
							return sum + (releasedOk && notRemoved ? b.n : 0);
						}, 0);
					}, [config, sel.release]);
					const catCount = useCallback((category) => {
						if (!config) return 0;
						return Object.keys(config.tasks[category] ?? {}).reduce((sum, task) => sum + (countFor(category, task) ?? 0), 0);
					}, [config, countFor]);
					const taskChips = useMemo(() => {
						const cats = sel.cats.length > 0 ? sel.cats : categories;
						return cats.flatMap((cat) => Object.keys(config?.tasks[cat] ?? {}).map((task) => `${cat}/${task}`));
					}, [sel.cats, categories, config]);
					const toggleList = (key, value) => setSel((prev) => {
						const list = prev[key];
						const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
						const out = { ...prev, [key]: next };
						if (key === "cats") {
							// 取消分类时同步清除该分类下已选的任务：否则这些任务标签
							// 会从界面消失（分类不再选中）却仍在提交列表里 —— 用户只选了
							// coding_completion 却连带跑了 cta 就是这个原因。
							out.tasks = prev.tasks.filter((t) => next.includes(t.split("/")[0]));
						}
						return out;
					});

					// 已选模型解析（provider::model）
					const selectedModelEntries = useMemo(() => sel.models.map((value) => {
						const sep = value.indexOf("::");
						const pid = value.slice(0, sep);
						const mid = value.slice(sep + 2);
						const provider = config?.providers.find((p) => p.id === pid) ?? null;
						const model = provider?.models.find((m) => m.id === mid) ?? null;
						return { providerId: pid, modelId: mid, modelValue: value, efforts: model?.efforts ?? [] };
					}), [sel.models, config]);

					// Baseline 三层选择：参考模型 -> 任务 -> 做对/做错
					const baselineObj = useMemo(
						() => (config?.baselines ?? []).find((b) => b.id === sel.baseline) ?? null,
						[config, sel.baseline]);
					const baselineTaskObj = useMemo(
						() => (baselineObj?.tasks ?? []).find((t) => t.task === sel.baselineTask) ?? null,
						[baselineObj, sel.baselineTask]);
					// 当前勾选真正会跑几题：题号范围的上界就是它 - 1
					const baselineSelectedCount = useMemo(() => {
						if (baselineTaskObj === null) return 0;
						let n = 0;
						if (sel.baselinePicks.includes("failed")) n += baselineTaskObj.failedCount;
						if (sel.baselinePicks.includes("passed")) n += baselineTaskObj.passedCount;
						return n;
					}, [baselineTaskObj, sel.baselinePicks]);

					const onStart = async () => {
						setStartError(null);
						if (selectedModelEntries.length === 0) {
							setStartError("请先在模型下拉中至少勾选一个模型。");
							return;
						}
						// Baseline 题库：绕开分类/任务的"不选 = 全部"推导，
						// 由服务端按「参考模型 + 任务 + 做对/做错」解析出 question id。
						let benchNames = null;
						if (baselineObj !== null) {
							if (baselineTaskObj === null) {
								setStartError("已选 Baseline，请再选择它下面的任务（例如 olympiad）。");
								return;
							}
							if (sel.baselinePicks.length === 0) {
								setStartError("已选 Baseline 任务，请至少勾选「做错」或「做对」之一。");
								return;
							}
						} else {
							benchNames = [];
							if (sel.cats.length === 0) {
								benchNames.push("live_bench");
							} else if (sel.tasks.length === 0) {
								for (const cat of sel.cats) benchNames.push(`live_bench/${cat}`);
							} else {
								for (const t of sel.tasks) benchNames.push(`live_bench/${t}`);
							}
							const zeroTask = sel.tasks.find((t) => countFor(t.split("/")[0], t.split("/")[1]) === 0);
							if (zeroTask) {
								setStartError(`任务 ${zeroTask.split("/")[1]} 在 release ${sel.release} 下没有可用题目（该批题目已退役），请取消勾选或换 release。`);
								return;
							}
						}
						setBusy(true);
						try {
							// 每个模型并发启动一个评测（服务端并发上限 6）
							const failures = [];
							const launches = selectedModelEntries.map(async (entry) => {
								const payload = await api("/start", {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({
										provider: entry.providerId,
										model: entry.modelId,
										reasoningEffort: sel.efforts[entry.modelValue] ?? "default",
										...(baselineObj !== null
											? { baseline: baselineObj.id, baselineTask: sel.baselineTask, baselinePicks: sel.baselinePicks }
											: { benchNames }),
										release: sel.release,
										begin: sel.begin,
										end: sel.end,
										maxTokens: sel.maxTokens,
										parallel: sel.parallel,
									}),
								});
								if (!payload.ok) failures.push(`${entry.modelId}: ${payload.error ?? "启动失败"}`);
							});
							await Promise.all(launches);
							if (failures.length > 0) setStartError(failures.join("；"));
							await refreshStatus();
						} catch (error) {
							setStartError(String(error.message ?? error));
						} finally {
							setBusy(false);
						}
					};

					const onStop = async () => {
						await api("/stop", { method: "POST" });
						await refreshStatus();
					};

					const saveHome = async () => {
						setHomeBusy(true);
						setStartError(null);
						try {
							const payload = await api("/home", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ path: homeInput }),
							});
							if (!payload.ok) setStartError(payload.error ?? "设置失败");
							else { setHomeInput(""); await loadConfig(); }
						} catch (error) {
							setStartError(String(error.message ?? error));
						} finally {
							setHomeBusy(false);
						}
					};

					const setField = (key) => (event) => {
						const value = event.target.value;
						setSel((prev) => ({ ...prev, [key]: value }));
					};
					const toggleModel = (value) => setSel((prev) => {
						const set = new Set(prev.models);
						const nextEfforts = { ...prev.efforts };
						if (set.has(value)) { set.delete(value); delete nextEfforts[value]; }
						else set.add(value);
						return { ...prev, models: [...set], efforts: nextEfforts };
					});
					const setModelEffort = (value) => (event) => {
						const v = event.target.value;
						setSel((prev) => ({ ...prev, efforts: { ...prev.efforts, [value]: v } }));
					};

					// ---- 成绩矩阵：model 为行标识、category/task 为列标识 ----
					// time 列 = 该模型这次评测的开始时间：
					//   1) 评测元数据 startedAt；2) displayName 尾部的运行戳 __rYYYYMMDD-HHMMSS；3) 最早的判分时间
					const runStampSeconds = (modelName) => {
						const m = /__r(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(modelName));
						if (!m) return null;
						const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
						return Number.isFinite(t) ? Math.floor(t / 1000) : null;
					};
					const taskKey = (category, task) => `${category}/${task}`;
					const matrix = useMemo(() => {
						if (!results) return null;
						const models = [...new Set(results.rows.map((r) => r.model))].sort();
						const taskSet = new Set(results.rows.map((r) => taskKey(r.category, r.task)));
						const tasks = [...taskSet].sort();
						// 按 category 分组（同一 category 的 task 相邻），列上以分隔线分组
						const groups = [];
						const byCat = new Map();
						for (const key of tasks) {
							const category = key.split("/")[0];
							if (!byCat.has(category)) { byCat.set(category, []); groups.push({ category, tasks: byCat.get(category) }); }
							byCat.get(category).push(key);
						}
						groups.sort((a, b) => a.category.localeCompare(b.category));
						const groupStart = new Set(groups.map((g) => g.tasks[0]));
						const cells = new Map();
						const startTimes = new Map();
						// 哪些 模型×任务 是 Baseline 子集跑出来的：同一列里会混着"全量"和
						// "题库子集"两种分数，必须在界面上标出来，否则没法解读。
						const baselineCells = new Set();
						for (const row of results.rows) {
							const key = `${row.model}__@__${taskKey(row.category, row.task)}`;
							cells.set(key, row);
							if (row.baselineLabel) baselineCells.add(key);
							const fromMeta = row.runStartedAt ? Math.floor(Date.parse(row.runStartedAt) / 1000) : null;
							const candidate = (Number.isFinite(fromMeta) ? fromMeta : null) ?? runStampSeconds(row.model) ?? row.time ?? null;
							const prev = startTimes.get(row.model);
							if (candidate && (prev === undefined || candidate < prev)) startTimes.set(row.model, candidate);
						}
						const taskTotals = (results && results.taskTotals) || {};
						return { models, tasks, groups, groupStart, cells, startTimes, taskTotals, baselineCells };
					}, [results]);
					const cellOf = (model, key) => matrix.cells.get(`${model}__@__${key}`);
					// 排序：sortBy=null 时用拖拽自定义顺序；点击表头在 正序/倒序 间切换
					const sortedModels = useMemo(() => {
						if (!matrix) return [];
						const base = [...matrix.models];
						if (sortBy === "model") {
							base.sort((a, b) => (sortDir === "asc" ? a.localeCompare(b) : b.localeCompare(a)));
							return base;
						}
						if (sortBy === "time") {
							base.sort((a, b) => {
								// 没有时间戳的排在最后，不管升序降序 —— 否则空值会被当成 0
								// 混在中间/开头，看起来像"最旧的一次评测"。
								const ta = matrix.startTimes.get(a) ?? 0;
								const tb = matrix.startTimes.get(b) ?? 0;
								if (ta === 0 && tb === 0) return a.localeCompare(b);
								if (ta === 0) return 1;
								if (tb === 0) return -1;
								return sortDir === "asc" ? ta - tb : tb - ta;
							});
							return base;
						}
						const indexOf = new Map(modelOrder.map((key, index) => [key, index]));
						return base.sort((a, b) => {
							const ia = indexOf.has(a) ? indexOf.get(a) : Number.MAX_SAFE_INTEGER;
							const ib = indexOf.has(b) ? indexOf.get(b) : Number.MAX_SAFE_INTEGER;
							if (ia !== ib) return ia - ib;
							return a.localeCompare(b);
						});
					}, [matrix, modelOrder, sortBy, sortDir]);

					// 点击表头：切换排序字段（再次点击同一列则反转方向）
					const toggleSort = (field) => {
						if (sortBy === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
						else { setSortBy(field); setSortDir(field === "time" ? "desc" : "asc"); }
					};
					const sortMark = (field) => (sortBy === field ? (sortDir === "asc" ? " ↑" : " ↓") : "");

					const persistModelOrder = (keys) => {
						setModelOrder(keys);
						try { localStorage.setItem("dlb_model_order_v1", JSON.stringify(keys)); } catch { /* ignore */ }
					};

					const onRowDrop = (targetModel) => {
						const sourceModel = dragKey.current;
						dragKey.current = null;
						if (!sourceModel || sourceModel === targetModel) return;
						setSortBy(null); // 拖拽即回到自定义顺序
						const keys = sortedModels.slice();
						const from = keys.indexOf(sourceModel);
						const to = keys.indexOf(targetModel);
						if (from < 0 || to < 0) return;
						keys.splice(to, 0, keys.splice(from, 1)[0]);
						persistModelOrder(keys);
					};

					const togglePicked = (model) => setPickedModels((prev) => {
						const next = new Set(prev);
						if (next.has(model)) next.delete(model); else next.add(model);
						return next;
					});

					// 删除一个模型行 = 删除该模型在所有任务下的判分与答案记录
					const deleteModels = async (modelsToDelete) => {
						if (!results || modelsToDelete.length === 0) return;
						const serverRows = [];
						for (const row of results.rows) {
							if (modelsToDelete.includes(row.model)) {
								serverRows.push({ model: row.model, category: row.category, task: row.task });
							}
						}
						if (serverRows.length === 0) return;
						if (!window.confirm(`确认删除所选 ${modelsToDelete.length} 个模型的全部评测成绩（共 ${serverRows.length} 条记录，含答案）？不可恢复。`)) return;
						const delRes = await api("/delete", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ rows: serverRows }),
						});
						setPickedModels(new Set());
						if (delRes && delRes.skipped > 0) {
							window.alert(`${delRes.skipped} 个模型正在评测中，已跳过未删除；请等评测结束后再删。`);
						}
						persistModelOrder(modelOrder.filter((model) => !modelsToDelete.includes(model)));
						await loadResults();
					};

					// 显示用短名：去掉运行时间戳后缀（运行时间单列显示在模型名下方）
			const shortModelName = (m) => String(m).replace(/__r[0-9]{8}-[0-9]{6}$/, "");
			const fmtTimeShort = (t) => {
				if (!t) return "—";
				const dt = new Date(t * 1000);
				const pad = (n) => String(n).padStart(2, "0");
				return `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
			};

			const fmtTime = (t) => {
						if (!t) return "—";
						const dt = new Date(t * 1000);
						const pad = (n) => String(n).padStart(2, "0");
						return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
					};

					return h("div", { className: c("root") },
						h("div", { className: c("head") },
							h("h2", null, "LiveBench"),
							h("span", { className: c("sub") }, config?.root ? `LiveBench 评测面板 · ${config.root}` : "LiveBench 评测面板"),
							h("span", { className: c("badge"), "data-ok": config?.available ? "1" : "0" },
								config === null ? "检测中…" : config.available ? "LiveBench 就绪" : "未找到 LiveBench"),
						),
						h("div", { className: c("row") },
							h("span", { className: c("label") }, "LiveBench 路径"),
							h("input", {
								className: c("input"), style: { flex: "1", minWidth: "240px" },
								placeholder: config?.root ?? "选择或输入 LiveBench 目录",
								value: homeInput, onChange: (event) => setHomeInput(event.target.value),
							}),
							h("button", { className: c("btnGhost") + " " + c("btn"), disabled: homeBusy || homeInput.trim().length === 0, onClick: saveHome },
								homeBusy ? "保存中…" : "设置路径"),
							h("span", { className: c("hint") }, "需含 livebench\\run_livebench.py 与 .venv；也可用环境变量 DSH_LIVEBENCH_HOME"),
						),
						configError !== null && h("p", { className: c("error") }, `加载配置失败：${configError}`),
						h("div", { className: c("card") },
							h("div", { className: c("fields") },
								h("div", { className: c("field"), ref: modelDdRef },
									h("label", { className: c("label") }, "模型（harness 全部模型，可多选；勾选后可在行内单独设定推理强度）"),
									h("button", {
										type: "button", className: c("select"), style: { textAlign: "left", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
										onClick: () => setModelDdOpen((v) => !v),
									}, sel.models.length === 0
										? "点击选择模型…"
										: sel.models.length === 1
											? sel.models[0].split("::")[1]
											: `已选 ${sel.models.length} 个模型`),
									modelDdOpen && h("div", {
										style: {
											marginTop: "6px", maxHeight: "340px", overflowY: "auto", border: "1px solid var(--dsw-alias-border-l2)",
											borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1)", padding: "6px",
										},
									},
										(config?.providers ?? []).map((p) => h("div", { key: p.id, style: { marginBottom: "4px" } },
											h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", padding: "3px 4px" } },
												p.name + (p.routable ? "" : " ·未接LiveBench")),
											p.models.map((m) => {
												const value = p.id + "::" + m.id;
												const checked = sel.models.includes(value);
												return h("div", { key: value, style: { borderBottom: "1px solid var(--dsw-alias-border-l2)", padding: "3px 4px" } },
													h("div", {
														style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" },
														onClick: () => toggleModel(value),
													},
														h("input", { type: "checkbox", checked, readOnly: true, style: { cursor: "pointer" } }),
														h("span", { style: { fontSize: "12.5px", flex: 1 } }, m.name)),
													checked && m.efforts.length > 0 && h("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "4px 0 2px 26px" } },
														h("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" } }, "推理强度"),
														h("select", {
															className: c("select"), style: { height: "28px", fontSize: "12px", flex: 1 },
															value: sel.efforts[value] ?? "default",
															onClick: (event) => event.stopPropagation(),
															onChange: setModelEffort(value),
														},
															h("option", { value: "default" }, "（模型默认）"),
															m.efforts.map((e) => h("option", { key: e, value: e }, e === "off" ? "off（关闭思考）" : e)))));
											}))),
								),
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "题集 release"),
									h("select", { className: c("select"), value: sel.release, onChange: setField("release") },
										(config?.releases ?? ["2024-11-25"]).map((r) => h("option", { key: r, value: r }, r))),
								),
								),
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "max-tokens"),
									h("input", { className: c("input"), type: "number", min: 256, max: 200000, value: sel.maxTokens, onChange: setField("maxTokens"), title: "单题输出上限（默认 32000，会自动夹到该模型在 settings.yaml 里声明的上限）。LiveBench 自带默认只有 4096，推理模型会思考吃满、正文为空（成绩表里记「没做出来」）；难题遇到这种情况就调到 65536 重跑。" }),
								),
								// Anthropic/Claude 这类模型答一道难题常常要思考几分钟（网关期间只发 ping、
								// 正文不来），单题串行会把总时长拉得很长；这里允许同一次评测内并发多题。
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "并发请求数"),
									h("select", { className: c("select"), value: sel.parallel, onChange: setField("parallel"), title: "同一次评测内同时请求几道题（--parallel-requests）。默认 1 = 串行；模型思考慢时调大可以显著缩短总时长。中转限流/502 会由容错层退避重试。" },
										["1", "2", "3", "4", "6", "8"].map((n) => h("option", { key: n, value: n }, n === "1" ? "1（串行）" : n))),
								),
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "题目序号范围（可选，0 起，含首尾）"),
									h("div", { className: c("row"), style: { flexWrap: "nowrap" } },
										h("input", { className: c("input"), type: "number", min: 0, placeholder: "起（含）", title: "起始题号（0 起，包含该题）", value: sel.begin, onChange: setField("begin"), style: { flex: "1", minWidth: "0" } }),
										h("input", { className: c("input"), type: "number", min: 0, placeholder: "止（含）", title: "结束题号（包含该题）；只填起不填止 = 从该题跑到底", value: sel.end, onChange: setField("end"), style: { flex: "1", minWidth: "0" } }),
									),
								// Baseline 题库：位于「分类 / 任务」之上的独立条目，三层选择。
								// 选中后走它自己的任务 + 一组 question id，因此不需要（也不应该）
								// 再受"不选分类 = 全部分类"这条规则约束。
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "Baseline 题库（探针，可单独使用，不必选分类/任务）"),
									// 第 1 层：参考模型
									h("div", { className: c("chips") },
										(config?.baselines ?? []).map((b) => h("button", {
											key: b.id,
											type: "button",
											className: c("chip") + (sel.baseline === b.id ? " " + c("chipOn") : ""),
											title: `参考模型 ${b.referenceModel}\n已实测 ${b.tasks.length} 个任务`,
											onClick: () => setSel((prev) => (prev.baseline === b.id
												? { ...prev, baseline: null, baselineTask: null, baselinePicks: [] }
												: { ...prev, baseline: b.id, baselineTask: null, baselinePicks: [] })),
										}, b.label)),
									),
									// 第 2 层：任务（该参考模型已实测过的任务）
									baselineObj !== null && h("div", { className: c("chips"), style: { marginTop: "6px" } },
										h("span", { className: c("hint"), style: { alignSelf: "center" } }, "任务："),
										(baselineObj.tasks ?? []).map((t) => h("button", {
											key: t.task,
											type: "button",
											className: c("chip") + (sel.baselineTask === t.task ? " " + c("chipOn") : ""),
											title: `${t.task} · release ${t.release}\n该任务全量 ${t.total} 题（做对 ${t.passedCount} / 做错 ${t.failedCount}）`,
											onClick: () => setSel((prev) => (prev.baselineTask === t.task
												? { ...prev, baselineTask: null, baselinePicks: [] }
												// 默认勾「做错」：探针的用途就是拿参考模型做不出来的题去量别人
												: { ...prev, baselineTask: t.task, baselinePicks: ["failed"] })),
										}, `${t.taskName}（${t.total}）`)),
									),
									// 第 3 层：做对 / 做错，各带题目数量
									baselineTaskObj !== null && h("div", { className: c("chips"), style: { marginTop: "6px" } },
										h("span", { className: c("hint"), style: { alignSelf: "center" } }, "题目："),
										[["failed", "做错"], ["passed", "做对"]].map(([key, text]) => {
											const count = key === "failed" ? baselineTaskObj.failedCount : baselineTaskObj.passedCount;
											const on = sel.baselinePicks.includes(key);
											return h("button", {
												key,
												type: "button",
												className: c("chip") + (on ? " " + c("chipOn") : ""),
												disabled: count === 0,
												title: key === "failed"
													? `${baselineTaskObj.referenceModel} 得 0 分的 ${count} 题（探针首选：做不出来的题才有分辨力）`
													: `${baselineTaskObj.referenceModel} 判分 ≥0.5 的 ${count} 题（反向验证用）`,
												onClick: () => setSel((prev) => ({
													...prev,
													baselinePicks: prev.baselinePicks.includes(key)
														? prev.baselinePicks.filter((p) => p !== key)
														: [...prev.baselinePicks, key],
												})),
											}, `${text}（${count}）`);
										}),
									),
									baselineTaskObj !== null && h("span", { className: c("hint") },
										`已选 ${baselineTaskObj.referenceModel} 的 ${baselineTaskObj.taskName}：`
										+ `本次只跑勾选的题（共 ${baselineSelectedCount} 题，有效题号 0–${Math.max(0, baselineSelectedCount - 1)}），`
										+ "上面的「分类/任务」被忽略；"
										+ "「题目序号范围」仍然生效（序号相对本题库，从 0 起、含首尾；超出上界不会报错，会按实际题数截断）；"
										+ `release 固定为 ${baselineTaskObj.release}。`),
								),
								h("div", { className: c("field") },
									h("label", { className: c("label") }, "分类（可多选，不选 = 全部分类；括号内为该 release 下有效题数）"),
									h("div", { className: c("chips") },
										categories.map((cat) => {
											const n = catCount(cat);
											const active = sel.cats.includes(cat);
											return h("button", {
												key: cat, type: "button", className: c("chip") + (active ? " " + c("chipOn") : ""),
												onClick: () => toggleList("cats", cat), disabled: n === 0,
											}, `${cat}（${n}）`);
										})),
								),
								sel.cats.length > 0 && h("div", { className: c("field") },
									h("label", { className: c("label") }, "任务（可多选，不选 = 所选分类的全部任务）"),
									h("div", { className: c("chips") },
										taskChips.map((key) => {
											const [cat, task] = key.split("/");
											const n = countFor(cat, task) ?? 0;
											const active = sel.tasks.includes(key);
											return h("button", {
												key, type: "button", className: c("chip") + (active ? " " + c("chipOn") : ""),
												onClick: () => toggleList("tasks", key), disabled: n === 0,
												title: n === 0 ? "该任务在此 release 下已无可用题目" : `${n} 题有效`,
											}, `${task}（${n}）`);
										})),
								),
							),
							h("div", { className: c("btnRow") },
								h("button", {
									className: c("btn") + " " + c("btnBar"), onClick: onStart,
									disabled: busy || !config?.available || sel.models.length === 0,
								}, `开始评测（${sel.models.length} 个模型并发）`),
								running && h("button", { className: c("btn") + " " + c("btnDanger") + " " + c("btnBar"), onClick: onStop }, "停止全部"),
								h("button", { className: c("btnGhost") + " " + c("btn") + " " + c("btnBar"), onClick: async () => {
									try { await api("/clear", { method: "POST" }); } catch { /* ignore */ }
									loadConfig(); loadResults(); refreshStatus();
								} }, "刷新"),
							),
							startError !== null && h("p", { className: c("error") }, startError),
						),
						runsList.length > 0 && h("div", { className: c("card") },
							h("div", { className: c("row") },
								h("span", { className: c("badge"), "data-ok": running ? "1" : "0" },
									running ? "有评测运行中" : "无运行中的评测"),
							),
							runsList.map((r) => h("details", { key: r.runId, open: r.running },
								h("summary", { style: { cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } },
									h("span", { className: c("badge"), "data-ok": r.running ? "1" : "0" }, r.running ? "运行中" : r.exitCode === 0 ? "完成" : `退出(${r.exitCode})`),
									" ",
									r.displayName),
								h("pre", { className: c("log") }, r.log || "（暂无输出）"),
							))),
						),
						sortedModels.length > 0 && h("div", { className: c("card") },
							h("div", { className: c("row") },
								h("div", { className: c("cardHead") },
									h("span", { className: c("label") }, `评测成绩（行 = 模型，列 = 任务）· ${sortedModels.length} 个模型 × ${matrix.tasks.length} 个任务`),
									h("span", { className: c("hint") }, "分数 = 该任务平均分 ×100；括号 (-没做或没做完的题数/用户选择的题数，即题目序号范围的题数)；× = 未执行该任务；— = 无有效判分（如全部访问失败，不计入正确率）；颜色 ≥75 绿 / 40–75 橙 / <40 红；默认按 time 倒序（最新在前），点表头可在模型名/时间间切换排序，拖 ⠿ 则回到本机保存的自定义行序。"),
								),
								h("button", {
									className: c("btn") + " " + c("btnDanger"),
									disabled: pickedModels.size === 0,
									onClick: () => deleteModels([...pickedModels]),
								}, `删除所选（${pickedModels.size}）`),
							),
							h("div", { className: c("tableWrap") },
								h("table", {
									className: c("table"),
									style: { width: `${20 + 26 + 190 + matrix.tasks.length * 74 + 30 + 86}px` },
								},
									h("colgroup", null,
										h("col", { style: { width: "20px" } }),
										h("col", { style: { width: "26px" } }),
										h("col", { style: { width: "190px" } }),
										matrix.tasks.map((taskKeyCol) => h("col", { key: taskKeyCol, style: { width: "74px" } })),
										h("col", { style: { width: "30px" } }),
										h("col", { style: { width: "86px" } }),
									),
									h("thead", null,
										// 第一行：category 分组（同一 category 的 task 列相邻，组间有分隔线）
										h("tr", { className: c("catRow") },
											h("th", { className: c("stick"), style: { left: 0 }, colSpan: 3 }, "分类 ↓"),
											matrix.groups.map((group) => h("th", {
												key: group.category,
												className: c("grpStart"),
												colSpan: group.tasks.length,
												style: { textAlign: "center" },
												title: `${group.category}（${group.tasks.length} 个任务）`,
											}, `${group.category} · ${group.tasks.length}`)),
											h("th", null, ""),
											h("th", null, ""),
										),
										// 第二行：task 列头 + model / time 排序
										h("tr", { className: c("thRow") },
											h("th", { className: c("stick"), style: { left: 0 } }, "⠿"),
											h("th", { className: c("stick"), style: { left: "20px" } },
												h("input", { type: "checkbox", checked: pickedModels.size > 0 && pickedModels.size === sortedModels.length,
													onChange: (event) => setPickedModels(event.target.checked ? new Set(sortedModels) : new Set()) })),
											h("th", {
												className: c("stick"),
												style: { left: "46px", cursor: "pointer", userSelect: "none", paddingLeft: "8px" },
												title: "点击按模型名排序（再次点击切换正序/倒序）",
												onClick: () => toggleSort("model"),
											}, "模型 / 运行时间" + sortMark("model")),
											matrix.tasks.map((taskKeyCol) => {
												const [cat, task] = taskKeyCol.split("/");
												return h("th", {
													key: taskKeyCol,
													className: c("thTask") + (matrix.groupStart.has(taskKeyCol) ? " " + c("grpStart") : ""),
													title: `${cat} / ${task}`,
												}, task);
											}),
											h("th", { title: "删除该模型的这一行成绩" }, "✕"),
											h("th", {
												style: { cursor: "pointer", userSelect: "none" },
												title: "点击按运行时间排序（再次点击切换正序/倒序）",
												onClick: () => toggleSort("time"),
											}, "time" + sortMark("time")),
										),
									),
									h("tbody", null,
										sortedModels.map((model) => {
											const checked = pickedModels.has(model);
											const startTime = matrix.startTimes.get(model);
											return h("tr", {
												key: model,
												draggable: true,
												onDragStart: () => { dragKey.current = model; },
												onDragOver: (event) => event.preventDefault(),
												onDrop: () => onRowDrop(model),
											},
												h("td", { className: c("stick") + " " + c("drag"), style: { left: 0 }, title: "按住拖动排序" }, "⠿"),
												h("td", { className: c("stick"), style: { left: "20px" } },
													h("input", { type: "checkbox", checked, onChange: () => togglePicked(model) })),
												h("td", { className: c("stick") + " " + c("modelCell"), style: { left: "46px" }, title: model },
													h("div", { className: c("modelName") }, shortModelName(model)),
													h("div", { className: c("cellSub") }, fmtTimeShort(startTime))),
												matrix.tasks.map((taskKeyCol) => {
													const row = matrix.cells.get(`${model}__@__${taskKeyCol}`);
													// 单元格：上方正确率，下方 (-没做或没做完的题数/用户选择的题数)。
													// 「用户选择的题数」= 题目序号范围选定的题数（end 含端点）。
													// 该任务总题数不参与正确率计算，故不展示。
													const cls = c("cellScore") + (matrix.groupStart.has(taskKeyCol) ? " " + c("grpStart") : "");
													if (!row) {
														return h("td", { key: taskKeyCol, className: cls, title: "未执行该任务" },
															h("div", { className: c("dim") }, "×"));
													}
													const sub = `(-${row.notDone ?? 0}/${row.configured ?? 0})`;
													const emptyCount = row.empty ?? 0;
													// 「没做出来」= API 失败 + 空答案（思考吃满 max-tokens 没产出正文），
													// 两者都不进正确率分母
													const notProduced = row.notProduced ?? row.errors ?? 0;
													const allFailed = row.answered > 0 && notProduced >= row.answered;
													const basePrefix = row.baselineLabel ? `【${row.baselineLabel}】` : "";
													const reasons = [
														row.errors > 0 ? `${row.errors} 题 API 失败` : null,
														emptyCount > 0 ? `${emptyCount} 题思考占满 max-tokens、未产出答案` : null,
													].filter(Boolean).join("，");
													const missing = Array.isArray(row.missingIndexes) ? row.missingIndexes : null;
													const missingText = missing !== null && missing.length > 0
														? `\n没做出来的题号（0 起，可复制去重跑）：${missing.join("、")}`
														: "";
													const title = basePrefix + (allFailed
														? `本次选择 ${row.configured ?? 0} 题，全部没做出来（${reasons}），不计入正确率 ${sub}`
														: `本次选择 ${row.configured ?? 0} 题，做出来 ${row.done ?? 0} 题，没做出来 ${row.notDone ?? 0} 题 ${sub}`
															+ (reasons ? `（其中 ${reasons}）` : "")) + missingText;													if (allFailed || row.judged === 0) {
														return h("td", { key: taskKeyCol, className: cls, title },
															h("div", { className: c("dim") }, "—"),
															h("div", { className: c("cellSub") }, sub));
													}
													const scoreCls = row.score >= 75 ? c("sHigh") : row.score >= 40 ? c("sMid") : c("sLow");
													return h("td", { key: taskKeyCol, className: cls, title },
														h("div", { className: scoreCls }, row.score.toFixed(1)),
														h("div", { className: c("cellSub") }, sub));
												}),
												h("td", { style: { textAlign: "center" } }, h("button", {
													className: c("btnGhost") + " " + c("btn"), style: { padding: "1px 7px", fontSize: "11px", lineHeight: "16px" },
													title: "删除该模型的所有评测成绩",
													onClick: () => deleteModels([model]),
												}, "✕")),
												h("td", { className: c("timeCell") }, fmtTimeShort(startTime)),
											);
										}),
									),
								),
							),
						),
						config !== null && config.available === false && h("div", { className: c("card") + " " + c("notice") },
							h("p", { className: c("noticeTitle") }, "⚠ 本面板需要本地安装 LiveBench（当前未检测到）"),
							h("p", { className: c("hint") },
								"dsh-livebench-panel 只是控制台，真正的评测由 LiveBench 项目完成。面板会依次查找：本页「LiveBench 路径」输入框保存的目录、环境变量 DSH_LIVEBENCH_HOME、用户目录 ~/LiveBench（需含 .venv 与 livebench\\run_livebench.py）。按下面步骤安装："),
							h("ol", { className: c("steps") },
								h("li", null, "克隆 LiveBench 仓库：",
									h("code", { className: c("code") }, "git clone https://github.com/LiveBench/LiveBench V:\\PythonProject\\C_UtilizeSpace\\LiveBench")),
								h("li", null, "用 Python 3.11 建虚拟环境并安装（3.10 会因 litellm 报 NotRequired 错误）：",
									h("code", { className: c("code") }, "cd /d V:\\PythonProject\\C_UtilizeSpace\\LiveBench && py -3.11 -m venv .venv"),
									h("code", { className: c("code") }, ".venv\\Scripts\\python -m pip install -e .")),
								h("li", null, "（评测 coding 类才需要）安装评分依赖：",
									h("code", { className: c("code") }, ".venv\\Scripts\\python -m pip install -r livebench\\code_runner\\requirements_eval.txt")),
								h("li", null, "下载题目数据：",
									h("code", { className: c("code") }, "cd livebench && ..\\.venv\\Scripts\\python download_questions.py")),
								h("li", null, "重启 dsh web，回到本页点「刷新」。",
									h("br", null),
									"若装在其它目录：在本页顶部「LiveBench 路径」输入框填入目录并点「设置路径」即可，也可用环境变量 DSH_LIVEBENCH_HOME。"),
							),
							h("p", { className: c("hint") },
								"除 LiveBench 外无需其它配置：评测所需的 API Key 会自动从 harness 凭据库读取并注入；npm 安装本插件时可一并执行 dsh plugin --profile web add dsh-livebench-panel。完整说明见插件目录内 README：~\\.dsh\\plugins\\dsh-livebench-panel\\README.md"),
						),
						h("details", { className: c("details") },
							h("summary", null, "❓ 使用说明 · 选项含义与选择建议（点击展开）"),
							h("p", { className: c("helpP") },
								"操作流程：选择参数 → 点「开始评测」→ 日志区实时显示运行进度 → 结束后成绩表自动刷新（运行中可「停止」）。全部判分均为客观比对（文本/符号执行/测试用例），不使用 AI 评分。"),
							h("table", { className: c("helpTable") },
								h("thead", null, h("tr", null, h("th", null, "选项"), h("th", null, "含义与选择建议"))),
								h("tbody", null,
									h("tr", null, h("th", null, "模型"), h("td", null,
										"harness 全部 provider 的全部模型（含内置 DeepSeek 官方）。API Key 自动从 harness 凭据库读取并注入，无需手工配置；名字带「·未接LiveBench」的 provider 无法自动路由，评测会按模型名原生尝试。")),
									h("tr", null, h("th", null, "推理强度"), h("td", null,
										"在模型下拉中勾选模型后，于该行内的次级下拉单独设定；强度会编码进条目名（如 glm-5.3@max），不同强度在成绩表中是独立条目，方便对比。")),
									h("tr", null, h("th", null, "题集 release"), h("td", null,
										"题目发布批次。推荐 2024-11-25（公开题目最全）。LiveBench 每月换题：新批次下老任务会陆续退役，任务下拉括号内就是该批次下的有效题数。")),
									h("tr", null, h("th", null, "分类 / 任务"), h("td", null,
										"六大类共 18 个任务：coding（代码生成/补全）、math（竞赛数学等）、reasoning（空间推理/逻辑谜题）、language（拼写/连线/语义）、data_analysis（表格操作）、instruction_following（指令遵循）。首次验证推荐 language → typos。")),
									h("tr", null, h("th", null, "题目序号范围"), h("td", null,
										"从 0 起，起止都包含。冒烟测试填 0 到 2（跑 3 题）；只填「起」= 从该题跑到底。2 题得分噪声很大（对一题就是 0↔100 的波动），想看真实水平建议 20 题以上。")),
									h("tr", null, h("th", null, "max-tokens"), h("td", null,
										"单题回答的 token 上限，默认 32000。推理模型思考也占 token，不要低于 8192，否则思考被截断、答案为空会记 0 分。")),
								),
							),
							h("p", { className: c("helpP"), style: { marginTop: "10px" } },
								"提示：回答为 $ERROR$ 表示该题 API 调用失败（网络/鉴权/参数问题）计 0 分，可在上方日志区查看具体错误；zebra_puzzle（逻辑谜题）是公认最难的任务，低分属正常现象。"),
						),
						h("p", { className: c("hint") },
							"格式说明：单元格上方为正确率（= 做对 / 做完），下方括号 (-没做/设定/总)：没做或没做完的题（访问失败、网络中断、未跑到）不计入正确率。× 表示该模型完全没跑过该任务。正式榜单可用 release 2024-11-25。"),
					);
				}
		/**
		 * Mount the LiveBench tab into the Trajectory view.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh: { tab: "LiveBench" },
				en: { tab: "LiveBench" },
			}), "livebench-panel: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "livebench",
				order: 20,
				locale: NS,
				label: () => t("tab"),
				inject: () => ({}),
			}, LiveBenchView));
		}
		//#endregion

		exports.NS = NS;
		exports.inject = inject;
		exports.apply = apply;
		exports.LiveBenchView = LiveBenchView;
		return module.exports;
	}
});
