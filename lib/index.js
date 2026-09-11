/**
 * dsh-livebench-panel — node half.
 *
 * Registers same-origin HTTP routes under /dsh-livebench-panel/api/* that
 * bridge the web panel to a local LiveBench checkout:
 *
 *   GET  /config    availability, releases, category→task map, harness models
 *   POST /start     spawn one `run_livebench.py` evaluation (single run at a time)
 *   GET  /status    running flag + log tail + exit code of the last run
 *   POST /stop      kill the running evaluation
 *   GET  /results   per-model/per-task mean scores computed from the
 *                   ground-truth judgment files LiveBench writes on disk
 *
 * The harness model list is read from $DSH_HOME/settings.yaml
 * (llm-pi-ai.providers), which is the same source the model selection UI
 * shows, so the dropdown always mirrors what the harness can serve. API keys
 * are never returned to the browser: the node half resolves `apiKeyEnv` to a
 * process env var and forwards it to LiveBench via LIVEBENCH_API_KEY.
 *
 * LiveBench checkout location (override with env DSH_LIVEBENCH_HOME):
 *   V:\PythonProject\C_UtilizeSpace\LiveBench   (repo root)
 *   <root>\.venv\Scripts\python.exe             (evaluation venv, Python 3.11)
 *   <root>\livebench                            (cwd for run_livebench.py)
 *
 * @module dsh-livebench-panel
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Stable Cordis plugin name. */
const name = "dsh-livebench-panel";
/** Services required by this half: the webserver route registry. */
const inject = ["webServer"];
/** Route namespace. */
const API = "/dsh-livebench-panel/api";
/** Profile whose settings.yaml holds the harness provider config. */
const PROFILE = "web";
/** LiveBench location resolution: saved user path > env var > user home > legacy. */
const CONFIG_FILE = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "livebench-panel.json");
const LEGACY_LIVEBENCH_HOME = "V:\\PythonProject\\C_UtilizeSpace\\LiveBench";

/** Read the user-saved LiveBench path (set from the panel UI). */
function savedLivebenchHome() {
	try {
		const path = JSON.parse(readFileSync(CONFIG_FILE, "utf8")).livebenchHome;
		return typeof path === "string" && path.trim().length > 0 ? path.trim() : null;
	} catch {
		return null;
	}
}

/** Candidate roots, most explicit first. Windows and Linux both covered. */
function livebenchCandidates() {
	return [
		savedLivebenchHome(),
		process.env.DSH_LIVEBENCH_HOME ?? null,
		join(homedir(), "LiveBench"),
		LEGACY_LIVEBENCH_HOME,
	].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

/** A root counts as a LiveBench checkout when the venv python and entry script exist. */
function isLivebenchRoot(root) {
	return existsSync(join(root, ".venv", "Scripts", "python.exe")) || existsSync(join(root, ".venv", "bin", "python"))
		? existsSync(join(root, "livebench", "run_livebench.py"))
		: false;
}

/** Resolve the LiveBench layout from the first valid candidate. */
function livebenchLayout() {
	const candidates = livebenchCandidates();
	for (const root of candidates) {
		const pythonExe = join(root, ".venv", "Scripts", process.platform === "win32" ? "python.exe" : "python");
		if (existsSync(pythonExe) && existsSync(join(root, "livebench", "run_livebench.py"))) {
			return {
				root,
				livebenchDir: join(root, "livebench"),
				dataDir: join(root, "livebench", "data", "live_bench"),
				pythonExe,
				available: true,
			};
		}
	}
	const root = candidates[0] ?? join(homedir(), "LiveBench");
	return {
		root,
		livebenchDir: join(root, "livebench"),
		dataDir: join(root, "livebench", "data", "live_bench"),
		pythonExe: join(root, ".venv", process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python")),
		available: false,
	};
}
/** Question-set releases LiveBench accepts (mirrors livebench/common.py). */
const RELEASES = [
	"2024-06-24", "2024-07-26", "2024-08-31", "2024-11-25",
	"2025-04-02", "2025-04-25", "2025-05-30", "2025-11-25",
	"2025-12-23", "2026-01-08", "2026-06-25",
];
/** Sane cap so a runaway run cannot eat memory with its log. */
const LOG_MAX_LINES = 600;
/** One evaluation at a time per model, but several models may run concurrently. */
const MAX_CONCURRENT_RUNS = 9;

/** Resolve the profile directory from the config-tree anchor (plugin-market pattern). */
function resolveProfileDir(ctx) {
	if (typeof ctx.baseUrl === "string" && ctx.baseUrl.startsWith("file:")) {
		const path = fileURLToPath(ctx.baseUrl).replace(/[\\/]+$/, "");
		if (existsSync(join(path, "package.json"))) return path;
	}
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const fallback = join(home, "profiles", PROFILE);
	if (existsSync(join(fallback, "package.json"))) return fallback;
	throw new Error(`${name}: cannot locate the ${PROFILE} profile directory (ctx.baseUrl=${String(ctx.baseUrl)})`);
}

/** Load yaml parser through the profile's own dependency tree. */
function loadYaml(profileDir) {
	const requireFromProfile = createRequire(join(profileDir, "package.json"));
	return requireFromProfile("yaml");
}

/**
 * Read harness providers from settings.yaml, plus the built-in
 * `deepseek-official` provider (registered by @deepseek-ai/dsh-llm-deepseek,
 * which never appears under llm-pi-ai.providers).
 * @returns {Array<{id: string, name: string, api: string|null, baseURL: string|null, keyEnv: string|null, models: Array<{id: string, name: string, efforts: string[]}>}>}
 */
function readProviders(profileDir) {
	// profileDir = ~/.dsh/profiles/web  →  settings.yaml = ~/.dsh/settings.yaml
	const settingsPath = join(profileDir.replace(/[\\/]+$/, ""), "..", "..", "settings.yaml");
	const settings = existsSync(settingsPath) ? loadYaml(profileDir).parse(readFileSync(settingsPath, "utf8")) ?? {} : {};

	const providers = [];
	const piAi = settings?.["llm-pi-ai"]?.providers ?? {};
	for (const [id, cfg] of Object.entries(piAi)) {
		providers.push({
			id,
			name: typeof cfg?.displayName === "string" && cfg.displayName.length > 0 ? cfg.displayName : id,
			api: typeof cfg?.api === "string" ? cfg.api : null,
			baseURL: typeof cfg?.baseURL === "string" ? cfg.baseURL : null,
			keyEnv: typeof cfg?.apiKeyEnv === "string" ? cfg.apiKeyEnv : null,
			models: Array.isArray(cfg?.models)
				? cfg.models
					.filter((m) => m && typeof m.id === "string" && m.id.trim().length > 0)
					.map((m) => ({ id: m.id.trim(), name: String(m.name ?? m.id).trim(), efforts: effortsOfModel(m) }))
				: [],
		});
	}

	// The harness's built-in DeepSeek route (dsh-llm-deepseek). Defaults mirror
	// that package: DEEPSEEK_API_KEY, https://api.deepseek.com, and the
	// off/low/high/max reasoning ladder; user settings may override any of it.
	const dsCfg = settings?.["llm-deepseek"] ?? {};
	const dsModels = Array.isArray(dsCfg.models) && dsCfg.models.length > 0
		? dsCfg.models
			.filter((m) => m && typeof m.id === "string" && m.id.trim().length > 0)
			.map((m) => ({ id: m.id.trim(), name: String(m.name ?? m.id).trim(), efforts: [...DEEPSEEK_EFFORTS] }))
		: DEFAULT_DEEPSEEK_MODELS.map((m) => ({ ...m, efforts: [...DEEPSEEK_EFFORTS] }));
	providers.push({
		id: "deepseek-official",
		name: "DeepSeek 官方",
		api: "openai-completions",
		baseURL: typeof dsCfg.baseURL === "string" && dsCfg.baseURL.length > 0 ? dsCfg.baseURL : "https://api.deepseek.com",
		keyEnv: typeof dsCfg.apiKeyEnv === "string" && dsCfg.apiKeyEnv.length > 0 ? dsCfg.apiKeyEnv : "DEEPSEEK_API_KEY",
		models: dsModels,
	});

	// Providers without an explicit baseURL may still be OpenAI-compatible with
	// a well-known endpoint: resolve it from the pi-ai provider registry
	// (@earendil-works/pi-ai, the same source the harness serves from).
	const piAiData = resolvePiAiDataDir(profileDir);
	if (piAiData !== null) {
		for (const provider of providers) {
			if (provider.baseURL === null) {
				const info = builtinProtocolInfo(piAiData, provider.id);
				if (info) {
					provider.baseURL = info.baseURL;
					provider.api = info.api;
				}
			}
		}
	}
	return providers;
}

/**
 * Locate the pi-ai provider data directory (providers/data/*.json).
 * @returns {string|null} directory path, or null when pi-ai cannot be found.
 */
function resolvePiAiDataDir(profileDir) {
	const candidates = [];
	// 1) resolvable from the profile's own dependency tree
	try {
		const requireFromProfile = createRequire(join(profileDir, "package.json"));
		candidates.push(join(dirname(requireFromProfile.resolve("@earendil-works/pi-ai/package.json")), "dist", "providers", "data"));
	} catch { /* not in the profile tree */ }
	// 2) the dsh installation the web process booted from (process.argv[1] = .../dsh/lib/bin.js)
	const bin = process.argv[1];
	if (typeof bin === "string" && bin.includes("@deepseek-ai")) {
		const dshRoot = dirname(dirname(bin));
		candidates.push(join(dshRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
	}
	// 3) the default global npm layout on Windows
	const appdata = process.env.APPDATA;
	if (appdata) {
		candidates.push(join(appdata, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Read one provider's built-in protocol + baseUrl from pi-ai data.
 * Prefers OpenAI Chat Completions; Anthropic Messages is also routable
 * (LiveBench talks it natively and honors ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY).
 */
function builtinProtocolInfo(piAiDataDir, providerId) {
	if (!/^[a-z0-9-]+$/.test(providerId)) return null;
	const file = join(piAiDataDir, `${providerId}.json`);
	if (!existsSync(file)) return null;
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		for (const api of ["openai-completions", "anthropic-messages"]) {
			const group = data?.[api];
			if (group && typeof group === "object") {
				for (const entry of Object.values(group)) {
					if (entry && typeof entry.baseUrl === "string" && entry.baseUrl.length > 0) {
						return { api, baseURL: entry.baseUrl };
					}
				}
			}
		}
	} catch { /* unreadable data file — treat as unknown */ }
	return null;
}

/** Reasoning efforts offered by the built-in DeepSeek route. */
const DEEPSEEK_EFFORTS = ["off", "low", "high", "max"];
/** Fallback catalog when settings.yaml has no llm-deepseek.models section. */
const DEFAULT_DEEPSEEK_MODELS = [
	{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
	{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
];

/**
 * Extract the reasoning-effort ladder from a settings.yaml model entry.
 * `reasoningEfforts` maps effort slots to wire values, e.g.
 * `{false: null, low: 'low', high: 'high', max: 'max'}` — a `false` slot whose
 * value is null means "thinking can be turned off"; every non-null value is a
 * selectable effort. Returns wire values, deduplicated, in insertion order.
 */
function effortsOfModel(model) {
	const efforts = [];
	const seen = new Set();
	if (model && typeof model === "object" && model.reasoningEfforts && typeof model.reasoningEfforts === "object") {
		for (const [slot, wire] of Object.entries(model.reasoningEfforts)) {
			if ((slot === "false" || slot === "true") && (wire === null || wire === undefined)) {
				if (!seen.has("off")) { seen.add("off"); efforts.push("off"); }
				continue;
			}
			const value = String(wire ?? slot);
			if (!seen.has(value)) { seen.add(value); efforts.push(value); }
		}
	}
	return efforts;
}

/** Scan data/live_bench/<category>/<task>/question.jsonl into a category→tasks map. */
function scanCategoryTasks(dataDir) {
	const tasks = {};
	if (!existsSync(dataDir)) return tasks;
	const categoryDirs = readDirSafe(dataDir);
	for (const category of categoryDirs) {
		const catDir = join(dataDir, category);
		for (const task of readDirSafe(catDir)) {
			const questionFile = join(catDir, task, "question.jsonl");
			if (!existsSync(questionFile)) continue;
			// Bucket questions by (release date, removal date) so the UI can
			// compute how many questions survive a chosen release option:
			// LiveBench drops questions released after the option and questions
			// removed at or before the option.
			const buckets = [];
			for (const q of readJsonl(questionFile)) {
				const r = typeof q.livebench_release_date === "string" ? q.livebench_release_date : "";
				const rm = typeof q.livebench_removal_date === "string" ? q.livebench_removal_date : "";
				const bucket = buckets.find((b) => b.r === r && b.rm === rm);
				if (bucket) bucket.n += 1;
				else buckets.push({ r, rm, n: 1 });
			}
			((tasks[category] ??= {})[task] = { buckets, total: buckets.reduce((sum, b) => sum + b.n, 0) });
		}
	}
	return tasks;
}

function readDirSafe(dir) {
	try {
		return readdirNames(dir);
	} catch {
		return [];
	}
}

/** 列出目录下的【文件】（可按扩展名过滤）——注意 readDirSafe 只列目录。 */
function readFilesSafe(dir, ext) {
	try {
		return readdirSync(dir).filter((f) => {
			try {
				if (!statSync(join(dir, f)).isFile()) return false;
				return ext === undefined || f.endsWith(ext);
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

function readdirNames(dir) {
	try {
		return readdirSync(dir).filter((entry) => {
			try {
				return statSync(join(dir, entry)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

/** Minimal JSON body reader with a hard size cap. */
function readBody(req, cap = 16 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > cap) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** Same-origin guard (plugin-market pattern). */
function originAllowed(req) {
	const origin = req.headers.origin;
	return origin === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

/** Filename-safe display name for a provider/model pair. */
function displayModelName(providerId, modelId) {
	return `${String(providerId).replace(/[^A-Za-z0-9._-]/g, "-")}__${String(modelId).replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/**
 * Write a single-entry model config into LiveBench's model_configs directory so
 * `get_model_config(displayName)` resolves it (instead of the bare custom-model
 * fallback) and the api_kwargs — e.g. `reasoning_effort` — reach the API call.
 * The file is regenerated on every start; secrets never go in here.
 * @returns {string|null} error message, or null on success.
 */
function writeGeneratedModelConfig(layout, YAML, { displayName, modelId, reasoningEffort, protocol }) {
	const configDir = join(layout.livebenchDir, "model", "model_configs");
	// 每个模型一个独立配置文件：并发启动多模型时共享单文件会互相覆盖，
	// 导致先启动的进程读到别人的配置 → anthropic/responses 路由失效 → 全 $ERROR$。
	const target = join(configDir, "dsh_panel_generated__" + displayName.replace(/[^A-Za-z0-9._@-]/g, "_") + ".yaml");
	void YAML;
	const lines = [
		"# Generated by dsh-livebench-panel — regenerated on every evaluation start.",
		"---",
		`display_name: ${displayName}`,
		"api_name:",
	];
	if (protocol === "anthropic") {
		// Route through LiveBench's native anthropic client; the endpoint is
		// pointed at the provider proxy via ANTHROPIC_BASE_URL (spawn env).
		lines.push(`  anthropic: ${modelId}`, "default_provider: anthropic");
		if (reasoningEffort) {
			// note: reasoning_effort is an OpenAI-style knob and is intentionally
			// not forwarded on the anthropic protocol path.
		}
	} else if (protocol === "openai_responses") {
		// OpenAI Responses API proxy: provider name matches
		// get_api_function('openai_responses') → chat_completion_openai_responses,
		// which converts reasoning_effort to reasoning:{effort} itself.
		lines.push(`  openai_responses: ${modelId}`);
		if (reasoningEffort) {
			lines.push("api_kwargs:", "  default:", `    reasoning_effort: ${reasoningEffort}`);
		}
	} else {
		lines.push(`  local: ${modelId}`);
		if (reasoningEffort) {
			lines.push("api_kwargs:", "  default:", `    reasoning_effort: ${reasoningEffort}`);
		}
	}
	lines.push("");
	const doc = lines.join("\n");
	try {
		if (!existsSync(configDir)) return `model_configs directory not found: ${configDir}`;
		writeFileSync(target, doc, "utf8");
		return null;
	} catch (error) {
		return `cannot write ${target}: ${error.message}`;
	}
}


/** Read a JSONL file into objects, skipping broken lines. */
function readJsonl(path) {
	if (!existsSync(path)) return [];
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((row) => row !== null);
	} catch {
		return [];
	}
}

/**
 * 异步流式读取一个 JSONL 文件，对每行回调。
 * 不整读入内存、不阻塞事件循环 —— coding 类 answer 单行可达数 MB，
 * 同步整读会卡死 node 事件循环（表现为 DSH 断连假死）。
 */
async function streamJsonl(path, onRow) {
	const fsPromises = await import("node:fs/promises");
	let handle;
	try {
		handle = await fsPromises.open(path, "r");
	} catch {
		return;
	}
	try {
		const decoder = new TextDecoder();
		let buffer = "";
		const chunkSize = 256 * 1024;
		const buf = Buffer.alloc(chunkSize);
		while (true) {
			// 每读一块就让出事件循环，避免大文件连续占用
			const { bytesRead } = await handle.read(buf, 0, chunkSize, null);
			if (bytesRead === 0) break;
			buffer += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
			let idx;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.trim().length > 0) onRow(line);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim().length > 0) onRow(buffer);
	} catch {
		/* 读取中断：尽力返回已读内容 */
	} finally {
		try { await handle.close(); } catch { /* ignore */ }
	}
}

/**
 * 从一行 answer JSON 提取 (model_id, 是否 $ERROR$)。不整对象解析时仍需 parse，
 * 但只保留必要字段并立即释放 —— 避免大对象堆积。
 */
function parseAnswerLineLight(line) {
	try {
		const row = JSON.parse(line);
		const turns = row.choices?.[0]?.turns;
		const text = Array.isArray(turns) ? String(turns[0] ?? "") : "";
		return { model: typeof row.model_id === "string" ? row.model_id : null, is_error: text.startsWith("$ERROR$"), raw: row };
	} catch {
		return null;
	}
}

/**
 * Compute mean scores per (model, category, task) from ground-truth judgment
 * files, plus judged/total question counts per task.
 *
 * 性能：数据目录可能上百 MB（每次评测生成独立答案文件）。这里：
 *  - answer 文件用【文件名】当模型名，只做行数与 "$ERROR$" 子串统计 —— 不解析大 JSON 行；
 *  - question.jsonl 只数行数；
 *  - 结果缓存 5 秒，避免前端频繁刷新时重复全量扫描。
 */
let resultsCache = { at: 0, data: null };

async function readTextFileAsync(path) {
	const fsPromises = await import("node:fs/promises");
	try {
		return await fsPromises.readFile(path, "utf8");
	} catch {
		return null;
	}
}

async function computeResults(dataDir) {
	const now = Date.now();
	if (resultsCache.data !== null && now - resultsCache.at < 5000) return resultsCache.data;
	const judged = new Map(); // `${model}\u0000${task}` -> {model, category, task, sum, n, time}
	const totals = new Map(); // task -> question count
	const answers = new Map(); // `${model}\u0000${task}` -> {answered, errors}
	const catByTask = new Map();
	if (!existsSync(dataDir)) return { rows: [], taskTotals: {} };
	// 读取每次评测的配置范围（displayName -> {benchNames, begin, end}）
	const runMeta = new Map();
	try {
		const metaDir = join(dataDir, ".dsh_runs");
		for (const f of readdirSync(metaDir)) {
			if (!f.endsWith(".json")) continue;
			try {
				runMeta.set(f.slice(0, -5), JSON.parse(readFileSync(join(metaDir, f), "utf8")));
			} catch { /* 单个元数据损坏忽略 */ }
		}
	} catch { /* 无元数据目录（历史数据） */ }
	for (const category of readDirSafe(dataDir)) {
		const catDir = join(dataDir, category);
		for (const task of readDirSafe(catDir)) {
			const taskDir = join(catDir, task);
			catByTask.set(task, category);
			const qText = await readTextFileAsync(join(taskDir, "question.jsonl"));
			totals.set(task, qText === null ? 0 : qText.split("\n").reduce((n, l) => n + (l.trim().length > 0 ? 1 : 0), 0));
			const answerDir = join(taskDir, "model_answer");
			for (const file of readFilesSafe(answerDir, ".jsonl")) {
				const model = file.slice(0, -".jsonl".length);
				const text = await readTextFileAsync(join(answerDir, file));
				if (text === null) continue;
				const key = `${model}\u0000${task}`;
				const stat = answers.get(key) ?? { answered: 0, errors: 0 };
				for (const line of text.split("\n")) {
					if (line.trim().length === 0) continue;
					stat.answered += 1;
					if (line.includes('"$ERROR$"')) stat.errors += 1;
				}
				// 空文件（尚未产出答案，或成绩已被删除只留下 0 字节壳）不计入结果：
				// 否则删掉的记录会在下一次扫描时凭“文件名仍在”重新冒出来。
				if (stat.answered > 0) answers.set(key, stat);
			}
			const jText = await readTextFileAsync(join(taskDir, "model_judgment", "ground_truth_judgment.jsonl"));
			if (jText !== null) {
				for (const line of jText.split("\n")) {
					if (line.trim().length === 0) continue;
					let row;
					try { row = JSON.parse(line); } catch { continue; }
					const model = typeof row.model === "string" ? row.model : null;
					const score = typeof row.score === "number" ? row.score : Number(row.score);
					if (model === null || !Number.isFinite(score) || score < 0) continue;
					const key = `${model}\u0000${task}`;
					const entry = judged.get(key) ?? { model, category, task, sum: 0, n: 0, time: 0 };
					entry.sum += score;
					entry.n += 1;
					const tstamp = Number(row.tstamp);
					if (Number.isFinite(tstamp) && tstamp > entry.time) entry.time = tstamp;
					judged.set(key, entry);
				}
			}
			// 让出事件循环，保证 HTTP/websocket 实时响应
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
	const keys = new Set([...judged.keys(), ...answers.keys()]);
	const rows = [...keys].map((key) => {
		const entry = judged.get(key);
		const stat = answers.get(key) ?? { answered: 0, errors: 0 };
		const [model, task] = key.split("\u0000");
		const category = entry?.category ?? catByTask.get(task) ?? "";
		const total = totals.get(task) ?? 0;
		const judgedCount = entry?.n ?? 0;
		// 做完的题 = 实际产出的有效答案（尝试数 - 访问失败数）
		const done = Math.max(0, stat.answered - stat.errors);
		// 选择题数 = 用户在「题目序号范围」里选择的题数（end 含端点）。
		// 有元数据就直接用范围大小；没有元数据（历史数据）时用本次实际写入的答案行数兜底：
		// LiveBench 会为范围内每一题写一行（访问失败也写 $ERROR$），所以跑完后
		// answered 就等于本次选择的题数。绝不能用该任务总题数兜底 —— 用户只选了几题时
		// 显示总题数毫无意义。
		let configured = stat.answered;
		const meta = runMeta.get(model);
		if (meta !== undefined) {
			const inScope = (meta.benchNames || []).some((bn) => {
				const parts = String(bn).split("/").filter((s) => s.length > 0);
				if (parts.length >= 3) return parts[1] === category && parts[2] === task;
				if (parts.length === 2) return parts[1] === category;
				return true;
			});
			if (inScope) {
				const hasRange = meta.begin !== null && meta.begin !== undefined && meta.end !== null && meta.end !== undefined;
				if (hasRange) configured = Math.min(total, Number(meta.end) - Number(meta.begin) + 1);
			}
		}
		// 实际尝试数比设定还多（断点重跑等）时，以实际为准
		if (configured < stat.answered) configured = stat.answered;
		const notDone = Math.max(0, configured - done);
		// 正确率 = 做对的题 / 已判分的做完题（访问失败/未做的题不计入分母）
		const judgedDone = Math.max(0, judgedCount - stat.errors);
		const score = entry && judgedDone > 0 ? (entry.sum / judgedDone) * 100 : null;
		return {
			model,
			category,
			task,
			score,
			judged: entry?.n ?? 0,
			total,
			time: entry && entry.time > 0 ? entry.time : null,
			answered: stat.answered,
			errors: stat.errors,
			done,
			configured,
			notDone,
			// 本次运行的开始时间（ISO）；旧数据没有元数据时为 null，前端退回解析 displayName 里的运行戳
			runStartedAt: meta !== undefined && typeof meta.startedAt === "string" ? meta.startedAt : null,
		};
	});
	// taskTotals 同时给出裸任务名与 `category/task` 两种键，便于前端按列取题目总数
	const taskTotals = Object.fromEntries(totals);
	for (const [t, n] of totals) taskTotals[`${catByTask.get(t) ?? ""}/${t}`] = n;
	const result = { rows, taskTotals };
	resultsCache = { at: Date.now(), data: result };
	return result;
}

/**
 * 异步统计某模型在指定 bench 范围内的 $ERROR$ 答案数（用于自动补跑判断）。
 * 只扫 body.benchNames 涉及的任务目录，流式读取不阻塞事件循环。
 */
async function countErrorAnswersAsync(dataDir, displayName, body) {
	if (!/^[A-Za-z0-9._@-]{1,160}$/.test(displayName)) return 0;
	const benches = Array.isArray(body?.benchNames) ? body.benchNames : [];
	let errors = 0;
	for (const bn of benches) {
		const parts = bn.split("/").filter((s) => s.length > 0); // live_bench/<cat>[/<task>]
		if (parts.length < 2) continue;
		const category = parts[1];
		const tasks = parts.length >= 3 ? [parts[2]] : readDirSafe(join(dataDir, category));
		for (const task of tasks) {
			if (!/^[A-Za-z0-9_]{1,80}$/.test(task)) continue;
			const file = join(dataDir, category, task, "model_answer", displayName + ".jsonl");
			await streamJsonl(file, (line) => {
				const parsed = parseAnswerLineLight(line);
				if (parsed && parsed.is_error) errors += 1;
			});
		}
	}
	return errors;
}

/**
 * Remove every JSONL line of one model from a file (matched on the given
 * field), rewriting the file only when something changed.
 * @returns {number} removed line count.
 */
function filterJsonlByModel(path, field, model) {
	if (!existsSync(path)) return 0;
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const kept = [];
	let removed = 0;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let match = false;
		try {
			const parsed = JSON.parse(line);
			match = parsed[field] === model;
		} catch {
			match = false;
		}
		if (match) removed += 1;
		else kept.push(line);
	}
	if (removed > 0) {
		if (kept.length > 0) writeFileSync(path, kept.join("\n") + "\n", "utf8");
		else {
			// 全部清空时直接删掉文件，别留 0 字节壳让扫描把它当成一行成绩。
			// （若文件被评测进程占用导致 unlink 失败，退化为写空文件。）
			try { unlinkSync(path); }
			catch { writeFileSync(path, "", "utf8"); }
		}
	} else if (kept.length === 0) {
		// 本来就是 0 字节空壳（早期删除留下的）：一并清掉
		try { unlinkSync(path); } catch { /* 被占用则保留 */ }
	}
	return removed;
}

/** Clamp helper for query params. */
function asInt(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Validate one bench path: "live_bench", "live_bench/<category>" or
 * "live_bench/<category>/<task>". Task names are mixed-case in LiveBench
 * (AMPS_Hard, LCB_generation, …), so segments allow A-Za-z0-9_.
 * @returns {string|null} error description, or null when valid.
 */
function validateBenchName(bn) {
	const parts = bn.split("/").filter((s) => s.length > 0);
	if (parts[0] !== "live_bench") return "must start with live_bench";
	if (parts.length > 3) return "too deep";
	for (const seg of parts) {
		if (!/^[A-Za-z0-9_]{1,80}$/.test(seg)) return `bad segment "${seg}"`;
	}
	return null;
}

function apply(ctx) {
	/** All runs: runId -> record. Several evaluations may run concurrently. */
	const runs = new Map();

	const startRun = async (body, autoRetries = 0) => {
		const layout = livebenchLayout();
		if (!layout.available) {
			return { status: 409, payload: { ok: false, error: `LiveBench venv not found under ${layout.root}` } };
		}
		const runningCount = [...runs.values()].filter((r) => r.exitCode === null).length;
		if (runningCount >= MAX_CONCURRENT_RUNS) {
			return { status: 409, payload: { ok: false, error: `已有 ${runningCount} 个评测在并发运行（上限 ${MAX_CONCURRENT_RUNS}），请等待或停止部分评测` } };
		}
		const providerId = typeof body.provider === "string" ? body.provider : "";
		const modelId = typeof body.model === "string" ? body.model.trim() : "";
		const release = typeof body.release === "string" ? body.release : "2024-11-25";
		const category = typeof body.category === "string" && body.category.length > 0 ? body.category : null;
		const task = typeof body.task === "string" && body.task.length > 0 ? body.task : null;
		const reasoningEffort = typeof body.reasoningEffort === "string" && body.reasoningEffort.length > 0 && body.reasoningEffort !== "default" ? body.reasoningEffort : null;
		if (modelId.length === 0 || modelId.length > 120 || /[^\w.:\/_-]/.test(modelId)) {
			return { status: 400, payload: { ok: false, error: "invalid model id" } };
		}
		if (reasoningEffort !== null && !/^[a-z0-9_-]{1,20}$/.test(reasoningEffort)) {
			return { status: 400, payload: { ok: false, error: `invalid reasoning effort: ${reasoningEffort}` } };
		}
		if (!RELEASES.includes(release)) {
			return { status: 400, payload: { ok: false, error: `unknown release: ${release}` } };
		}

		const profileDir = resolveProfileDir(ctx);
		const providers = readProviders(profileDir);
		const provider = providers.find((p) => p.id === providerId) ?? null;

		// Multi-select support: the client resolves its category/task chips into
		// an explicit bench-path list ("live_bench", "live_bench/<cat>",
		// "live_bench/<cat>/<task>"); gen_api_answer accepts nargs="+".
		let benchNames = null;
		if (Array.isArray(body.benchNames) && body.benchNames.length > 0) {
			if (body.benchNames.length > 24) {
				return { status: 400, payload: { ok: false, error: "too many bench names (max 24)" } };
			}
			benchNames = [];
			for (const bn of body.benchNames) {
				if (typeof bn !== "string") return { status: 400, payload: { ok: false, error: "invalid bench name" } };
				const error = validateBenchName(bn);
				if (error) return { status: 400, payload: { ok: false, error: `invalid bench path: ${bn} (${error})` } };
				benchNames.push(bn.split("/").filter((s) => s.length > 0).join("/"));
			}
		}

		// A global effort only applies to models whose own effort ladder
		// includes it; others silently fall back to their default behaviour.
		const modelMeta = provider?.models.find((m) => m.id === modelId) ?? null;
		const effort = reasoningEffort !== null && modelMeta?.efforts?.length > 0 && !modelMeta.efforts.includes(reasoningEffort)
			? null
			: reasoningEffort;
		const hasEffortSuffix = effort !== null && effort !== "off";
		// 每次评测使用带时间戳的独立 display-name：答案/判分文件各自独立，
		// 成绩表里每次评测是独立一行，可对比模型的历史变化（不再覆盖旧数据）。
		const _now = new Date();
		const _pad = (n) => String(n).padStart(2, "0");
		const runStamp = `r${_now.getFullYear()}${_pad(_now.getMonth() + 1)}${_pad(_now.getDate())}-${_pad(_now.getHours())}${_pad(_now.getMinutes())}${_pad(_now.getSeconds())}`;
		const displayName = displayModelName(providerId || "direct", modelId) + (hasEffortSuffix ? "@" + effort : "") + "__" + runStamp;
		let cliModel = modelId;
		let writeError = null;		// Anthropic-protocol proxies cannot go through --api-base (that path
		// speaks OpenAI Chat Completions). Instead the generated model config
		// selects LiveBench's native anthropic client and the spawn env points
		// the SDK at the proxy (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY).
		const isAnthropicRoute = provider && provider.api === "anthropic-messages" && provider.baseURL;
		// OpenAI Responses-API proxies (api: openai-responses) select LiveBench's
		// openai_responses client; --api-base + LIVEBENCH_API_KEY route them the
		// usual way, and reasoning_effort converts to reasoning:{effort} inside.
		const isOpenAIResponsesRoute = provider
			&& (provider.api === "openai-responses" || provider.api === "openai_responses")
			&& provider.baseURL;
		const needConfig = isAnthropicRoute || isOpenAIResponsesRoute || hasEffortSuffix;
		if (needConfig) {
			writeError = writeGeneratedModelConfig(layout, loadYaml(profileDir), {
				displayName,
				modelId,
				reasoningEffort: isAnthropicRoute ? null : effort,
				protocol: isAnthropicRoute ? "anthropic" : isOpenAIResponsesRoute ? "openai_responses" : "openai",
			});
			if (writeError) return { status: 500, payload: { ok: false, error: writeError } };
			cliModel = displayName;
		}

		const benchParts = ["live_bench", ...(category ? [category] : []), ...(task ? [task] : [])];
		const args = [
			"run_livebench.py",
			"--model", cliModel,
			"--model-display-name", displayName,
			"--bench-name",
			...(benchNames !== null ? benchNames : [benchParts.join("/")]),
			"--livebench-release-option", release,
			"--max-tokens", String(asInt(body.maxTokens, 256, 32768, 32000)),
			"--parallel-requests", String(asInt(body.parallel, 1, 8, 1)),
			// 流式：中转网关（Cloudflare 等）对非流式请求有 ~100s 超时（524），
			// 高推理强度模型思考数分钟必然超时。流式保持字节流动可规避。
			"--stream",
			"--mode", "single",
		];
		if (body.begin !== undefined && body.begin !== null && `${body.begin}`.length > 0) {
			args.push("--question-begin", String(asInt(body.begin, 0, 100000, 0)));
		}
		if (body.end !== undefined && body.end !== null && `${body.end}`.length > 0) {
			// 面板的「止」按用户直觉是闭区间；LiveBench 的 --question-end 是开区间
			// （gen_api_answer.py: questions[begin:end]），这里 +1 对齐，否则实际少跑一题。
			args.push("--question-end", String(asInt(body.end, 0, 100000, 0) + 1));
		}
		if (body.resume === true) args.push("--resume");
		if (body.retryFailures === true) args.push("--retry-failures");

		const env = {
			...process.env,
			HF_HOME: join(layout.root, ".hf_cache"),
			HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
			// 限制评测进程的数值库线程（numpy/pyarrow/MKL 默认吃满全核，
			// 多模型并发时会把 node 事件循环饿死 → websocket 断连）。
			OMP_NUM_THREADS: "1",
			MKL_NUM_THREADS: "1",
			OPENBLAS_NUM_THREADS: "1",
			NUMEXPR_NUM_THREADS: "1",
			RAYON_NUM_THREADS: "1",
			// run_livebench.py shells out to bare `python`; without the venv on
			// PATH that resolves to the system interpreter and dies on the first
			// livebench import (shortuuid etc.).
			PATH: `${join(layout.root, ".venv", "Scripts")}${delimiter}${process.env.PATH ?? ""}`,
		};
		// Provider routing: keys are resolved through the harness credential seam
		// when available (values may live encrypted in .credentials.yaml rather
		// than in the process env), falling back to the plain environment
		// variable. Secrets travel via env only — never the command line.
		if (provider && provider.baseURL) {
			let key;
			if (provider.keyEnv) {
				try {
					const credentials = ctx.get ? ctx.get("credentials") : undefined;
					if (credentials && typeof credentials.resolve === "function") {
						const resolved = await credentials.resolve(provider.keyEnv);
						if (resolved && typeof resolved.value === "string" && resolved.value.length > 0) key = resolved.value;
					}
				} catch { /* credential seam unavailable — fall through to env */ }
				if (!key && process.env[provider.keyEnv]) key = process.env[provider.keyEnv];
			}
			if (provider.api === "openai-completions" || provider.api === "openai-responses" || provider.api === "openai_responses") {
				// openai-responses 与 openai-completions 一样走 --api-base + LIVEBENCH_API_KEY
				// （Responses 客户端同样从 api_dict 读 base_url/api_key）。
				args.push("--api-base", provider.baseURL);
				if (key) env.LIVEBENCH_API_KEY = key;
			} else if (provider.api === "anthropic-messages") {
				// The generated model config selects the native anthropic client;
				// the Anthropic SDK picks endpoint+key up from these env vars.
				if (key) env.ANTHROPIC_API_KEY = key;
				env.ANTHROPIC_BASE_URL = provider.baseURL;
			}
		}

		// 记录本次评测的配置范围：/results 用它计算每个任务的"选择题数"。
		// 注意 begin/end 存的是面板上的原始输入（闭区间，含首尾），
		// 供 computeResults 算 end - begin + 1；传给 LiveBench 时 end 已 +1。
		try {
			const metaDir = join(layout.dataDir, ".dsh_runs");
			if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
			writeFileSync(join(metaDir, displayName + ".json"), JSON.stringify({
				benchNames: benchNames !== null ? benchNames : [benchParts.join("/")],
				begin: body.begin ?? null,
				end: body.end ?? null,
				startedAt: new Date().toISOString(),
			}), "utf8");
		} catch { /* 元数据写入失败不影响评测 */ }

		const child = spawn(layout.pythonExe, args, {
			cwd: layout.livebenchDir,
			env,
			windowsHide: true,
		});
		// 降低评测进程优先级：评测不应与 DSH/浏览器争抢 CPU
		try {
			if (child.pid) {
				spawn("powershell", [
					"-NoProfile", "-Command",
					`(Get-Process -Id ${child.pid}).PriorityClass = 'BelowNormal'`,
				], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
			}
		} catch { /* 优先级设置失败不影响评测 */ }

		const record = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			proc: child,
			displayName,
			body,
			autoRetries,
			exitCode: null,
			startedAt: new Date().toISOString(),
			command: [layout.pythonExe, ...args].join(" "),
			log: [`$ ${[...args].join(" ")}`],
		};
		runs.set(record.id, record);
		// keep history bounded: drop oldest finished runs beyond 20 entries
		if (runs.size > 20) {
			for (const [id, r] of runs) {
				if (r.exitCode !== null && runs.size > 20) runs.delete(id);
			}
		}

		child.stdout.on("data", (chunk) => appendLog(record, chunk));
		child.stderr.on("data", (chunk) => appendLog(record, chunk));
		child.on("error", (error) => {
			appendLog(record, `[spawn error] ${error.message}`);
			record.exitCode = -1;
		});
		child.on("close", (code) => {
			record.exitCode = code === null ? -1 : code;
			record.log.push(`[exit ${record.exitCode}]`);
			// 自动补跑：正常结束但存在 $ERROR$ 答案时，用 --resume --retry-failures
			// 只重跑失败题（最多 2 轮）。统计改为异步流式（同步版曾阻塞事件循环，
			// 且函数缺失会在 close 回调抛未捕获异常 → DSH 假死断连）。
			if (record.exitCode === 0 && record.autoRetries < 3 && record.body) {
				(async () => {
					try {
						const errors = await countErrorAnswersAsync(layout.dataDir, record.displayName, record.body);
						if (errors > 0) {
							record.log.push(`[自动补跑] 检测到 ${errors} 条失败答案，自动重试（第 ${record.autoRetries + 1}/3 轮）`);
							const retryBody = { ...record.body, resume: true, retryFailures: true };
							setTimeout(() => {
								startRun(retryBody, record.autoRetries + 1).catch((e) => {
									appendLog(record, `[自动补跑启动失败] ${e.message}`);
								});
							}, [15000, 60000, 180000][Math.min(record.autoRetries, 2)]);
						}
					} catch (e) {
						record.log.push(`[自动补跑检查失败] ${e.message}`);
					}
				})();
			}
		});

		return { status: 200, payload: { ok: true, runId: record.id, displayName, command: record.command } };
	};

	const appendLog = (record, chunk) => {
		for (const line of String(chunk).split(/\r?\n/)) {
			if (line.length === 0) continue;
			record.log.push(line);
		}
		if (record.log.length > LOG_MAX_LINES) {
			record.log.splice(0, record.log.length - LOG_MAX_LINES);
		}
	};

	/**
	 * Mount the routes.
	 * @param ctx - plugin context carrying the webServer service.
	 */
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/config`,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const layout = livebenchLayout();
			let providers = [];
			try {
				providers = readProviders(resolveProfileDir(ctx));
			} catch (error) {
				providers = [];
				appendLog({ log: [] }, `[config] settings.yaml unreadable: ${error.message}`);
			}
			sendJson(res, 200, {
				ok: true,
				available: layout.available,
				root: layout.root,
				releases: RELEASES,
				tasks: scanCategoryTasks(layout.dataDir),
				providers: providers.map(({ id, name: pname, models, api, baseURL }) => ({
					id,
					name: pname,
					routable: ["openai-completions", "openai-responses", "openai_responses", "anthropic-messages"].includes(api)
						&& typeof baseURL === "string" && baseURL.length > 0,
					baseURL: baseURL ?? null,
					models,
				})),
			});
		},
	}), `${name}: config route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/start`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			if (!originAllowed(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden origin" });
				return;
			}
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				sendJson(res, 400, { ok: false, error: "invalid request body" });
				return;
			}
			const runningCount = [...runs.values()].filter((r) => r.exitCode === null).length;
			if (runningCount >= MAX_CONCURRENT_RUNS) {
				sendJson(res, 409, { ok: false, error: `已有 ${runningCount} 个评测在并发运行（上限 ${MAX_CONCURRENT_RUNS}）` });
				return;
			}
			const result = await startRun(body);
			sendJson(res, result.status, result.payload);
		},
	}), `${name}: start route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/status`,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const list = [...runs.values()].reverse().map((r) => ({
				runId: r.id,
				displayName: r.displayName,
				running: r.exitCode === null,
				exitCode: r.exitCode,
				startedAt: r.startedAt,
				log: r.log.slice(-80).join("\n"),
			}));
			sendJson(res, 200, { ok: true, running: list.some((r) => r.running), runs: list });
		},
	}), `${name}: status route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/stop`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			if (!originAllowed(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden origin" });
				return;
			}
			const running = [...runs.values()].filter((r) => r.exitCode === null);
			if (running.length === 0) {
				sendJson(res, 200, { ok: true, stopped: false });
				return;
			}
			for (const record of running) {
				try {
					if (process.platform === "win32") {
						// proc.kill() only terminates run_livebench.py itself; its child
						// (cmd → gen_api_answer.py → …) would survive. taskkill /T /F
						// takes down the whole tree.
						spawn("taskkill", ["/PID", String(record.proc.pid), "/T", "/F"], { windowsHide: true });
					} else {
						record.proc.kill();
					}
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error.message ?? error) });
					return;
				}
			}
			sendJson(res, 200, { ok: true, stopped: running.length });
		},
	}), `${name}: stop route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/clear`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			if (!originAllowed(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden origin" });
				return;
			}
			let removed = 0;
			for (const [id, r] of [...runs]) {
				if (r.exitCode !== null) { runs.delete(id); removed += 1; }
			}
			sendJson(res, 200, { ok: true, removed });
		},
	}), `${name}: clear route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/results`,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const layout = livebenchLayout();
			const { rows, taskTotals } = await computeResults(layout.dataDir);
			sendJson(res, 200, { ok: true, rows, taskTotals });
		},
	}), `${name}: results route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/home`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			if (!originAllowed(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden origin" });
				return;
			}
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				sendJson(res, 400, { ok: false, error: "invalid request body" });
				return;
			}
			const path = typeof body.path === "string" ? body.path.trim() : "";
			if (path.length === 0 || path.length > 260 || /[<>:"|?*\0]/.test(path.replace(/^[A-Za-z]:/, ""))) {
				sendJson(res, 400, { ok: false, error: "invalid path" });
				return;
			}
			if (!existsSync(join(path, "livebench", "run_livebench.py"))) {
				sendJson(res, 400, { ok: false, error: `该目录下没有 livebench\\run_livebench.py：${path}` });
				return;
			}
			try {
				writeFileSync(CONFIG_FILE, JSON.stringify({ livebenchHome: path }, null, 2), "utf8");
			} catch (error) {
				sendJson(res, 500, { ok: false, error: `cannot save config: ${error.message}` });
				return;
			}
			const layout = livebenchLayout();
			sendJson(res, 200, { ok: true, root: layout.root, available: layout.available });
		},
	}), `${name}: home route`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API}/delete`,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			if (!originAllowed(req)) {
				sendJson(res, 403, { ok: false, error: "forbidden origin" });
				return;
			}
			let body;
			try {
				body = JSON.parse(await readBody(req));
			} catch {
				sendJson(res, 400, { ok: false, error: "invalid request body" });
				return;
			}
			const rows = Array.isArray(body.rows) ? body.rows.slice(0, 200) : [];
			const layout = livebenchLayout();
			const tasks = scanCategoryTasks(layout.dataDir);
			// 正在跑的模型不删：文件还被评测进程持有，删了会损坏本次结果
			const activeModels = new Set();
			for (const r of runs.values()) if (r.exitCode === null) activeModels.add(r.displayName);
			let removed = 0;
			let skipped = 0;
			for (const row of rows) {
				if (!row || typeof row !== "object") continue;
				const model = typeof row.model === "string" ? row.model : "";
				const category = typeof row.category === "string" ? row.category : "";
				const task = typeof row.task === "string" ? row.task : "";
				// path-safety: membership in the scanned task list + charset guards
				if (!/^[A-Za-z0-9._@-]{1,160}$/.test(model)) continue;
				if (!/^[A-Za-z0-9_]{1,80}$/.test(category) || !/^[A-Za-z0-9_]{1,80}$/.test(task)) continue;
				if (!(tasks[category] && tasks[category][task])) continue;
				if (activeModels.has(model)) { skipped += 1; continue; }
				const taskDir = join(layout.dataDir, category, task);
				removed += filterJsonlByModel(join(taskDir, "model_answer", `${model}.jsonl`), "model_id", model);
				removed += filterJsonlByModel(join(taskDir, "model_judgment", "ground_truth_judgment.jsonl"), "model", model);
			}
			resultsCache = { at: 0, data: null };
			sendJson(res, 200, { ok: true, removed, skipped });
		},
	}), `${name}: delete route`);
}

export { name, inject, apply, writeGeneratedModelConfig, readProviders, validateBenchName };
