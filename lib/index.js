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
/** One evaluation at a time per model, but several models may run together. */
const MAX_CONCURRENT_RUNS = 9;

/**
 * 「Baseline」题库：记录某个**参考模型**在各任务上的实测对错，用来给别的模型一把同样的尺子。
 *
 * 结构是三层可选：参考模型（baseline）→ 任务（task）→ 对/错（passed / failed）。
 * 作为"探针"用时通常只跑 failed —— 参考模型做不出来的题，才对更强的模型有分辨力；
 * passed 一并留存，便于反向验证（例如确认某模型确实强于参考模型）。
 * 目前只有 olympiad 做过全量实测，后续任务按同样方式补进 tasks 即可。
 *
 * 实现要点：题目 id 取自 LiveBench 的 question.jsonl。面板用 `--question-id` 直接指定，
 * 因此不要求这些题在题库里连续；`--question-begin/--question-end` 仍然会作用在
 * **id 过滤之后**的列表上，所以「题目序号范围」对 baseline 一样有效。
 */
const BASELINE_SETS = {
	glm53flash: {
		id: "glm53flash",
		label: "Baseline(glm-5.3-flash@max)",
		referenceModel: "zai-coding-cn__glm-5.3-flash@max",
	// 参考模型在每个任务上的实测结果：passed = 判分 >= 0.5 的题，failed = 判分 0 的题。
	// 作为"探针"用时通常只跑 failed —— 参考模型做不出来的题，才对更强的模型有分辨力；
	// passed 也一并留存，便于反向验证（例如确认某模型确实强于参考模型）。
	// 新增任务时只在这里加一项：id 取自 LiveBench question.jsonl 的 question_id，
	// 面板用 --question-id 直接指定，所以题目在题库里是否连续都无所谓。
	tasks: [
		{
			task: "live_bench/math/olympiad",
			category: "math",
			taskName: "olympiad",
			release: "2024-11-25",
			// 2026-09-12 实测：glm-5.3-flash@max 跑满该任务全量 36 题（并发 4），
			// 通过 28、失败 8；失败的 8 题全部属于"公式还原"题型。
			passed: [
				"ef6c6830ebf0e71d74e7ceb45a242f2b87228933eebfe47db8d798d5738cdaeb", "6e12ab2219a4051c396de5afc4228be52c2d8617c7f5621be8c364f50016c80d",
				"c03217423ccb2181ef9e3106b4c116aaf1bcdbd45b3a97e04110665690177eca", "698d9bd9ad134096358dad82317dae610d9f265255aeee52c644871b83eb7a85",
				"56155e5b8c1dc430cc262691aea0a75d71f7dee78b6e15304607caf0b56ecfbd", "3f55db366e970e1965bbba20e9958a4c0ea52e4224d11d875d390983485dd32b",
				"3649fb05ed87c2f3ed8a933e7c8f032b54a5d6f0d23504cdd578541dd60c0f08", "e5b72d9cdb39c6e5f8798a557f119fff35d98fd165f55659e71bf6ac38b5f178",
				"bc3551b5f643d8920f428909104fe2640a50f6b8a17fff6196aa78f25df28bb6", "2dd75e080f3e276f3dcf304d970e6a03973ddf777537422c9aba59559ddc9594",
				"558c3c463860fcaa2b08edd9d5f0f11071944bf7d9229574862a92e6d91f1a21", "e81b96eed50d6b9b43f041d6a36ad0d9a4d00038c42c47a16efd4465d79d08a4",
				"2191e02b65ac78dd0d28bc13f41786d2596dbaa560ad9d0658a27ae2814faef3", "fc903ff1f1f66a6096c9dea58c278b48f54c80a606b65f82af1730559d73755f",
				"e56e4d8ed64cb6d0e43ce3c8edda0a77d769b4bda5230c1aba57442e27214694", "749116060528890530a40d111c5506f4cdec004a7c52a87ef0a4a01206c187ec",
				"6d9bd0806e27f34ff88209075cad638ca0ed6662f499c74bdd3a256d3511b9fe", "9a199388f2e2bd43deac789cd248363bdcb32611480ac27cf62420b4c351759e",
				"a908da1d873928f9f872dddd33c29620dfa0a54646b79bfde672bd15e6986ec9", "2c17f46f8323e8e692a1827bb18c9a9a43fcff9860b72372cb9551b7cdd532f5",
				"d805a5c9f398cf5126ee84e6899cc9a3d34444a7e2337d15cdf9cc2a949649ba", "f4fdca7e355eaf9362449ebf7df78a366e239091bdb4c4a34b9dfcf9882f23de",
				"aba8388e52d25b4006e78d4010c26cf8848c3e3145b0c050b9d55c8aff211fe8", "95b0921a4de64f6e510ac36b5426ecea550c4d3a6033dfbd0d93dd2213fea714",
				"6df4693c156b7581ffb9a1267a84c055bc9edd8170681b9021bb837f1e9d1167", "1f6132e867a52e5c7b084011484f7fcfec9195f407c9bfb06a3f13f5b709d333",
				"c6675bf6647188f84ee445590a494a8d516635bad77ace98ec61d28746839a8d", "2c5982946e20e2a85531ac00121697b263591e055ac19586db59a890fdaf98b1",
			],
			failed: [
				"0d3a48049dc5da31531654f59e7866832579f812b892610bd1b178fc4d010d0c", "5b9c56e9392dd999162474f10addf1a3a72f1d8b1c8bafc999ccec6f22194c18",
				"11f95734f602e7d1481f9887ca7fc8bed83258e22fd5c443449ac159a4732115", "2a82215ea19fcbded36fa95df35b6e7c5f6ed28b0b5f6c3460b4223f1904a536",
				"527d5f9f9cf27824b84109a495eeced7c7c097fb324b872212f6813a660e5ee4", "f22ff1f6c067d0e085eb79fe5c2e35df01f9edb2bcc73e59e1e15eefd32b8f07",
				"6dfb6aade6429e2cca0718a497a442299a57199dfd547813471f4cf30ed6c7c7", "0499deda2f068008d488551abf96b4b758c6ed6b79cd2ec6a204d1250b140421",
			],
		},
	],	},
};
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
 *
 * 除了 id/name/api/baseURL，还要带上两个**渠道约束**，面板必须遵守：
 *   - `models[].maxTokens`：该模型单次输出上限（如 claude-fable-5-1 = 64000）；
 *     面板的 max-tokens 默认 32000，不夹住就可能超过渠道上限（bearlab 这类渠道上限就是 32000）；
 *   - `streamIdleTimeoutMs`：harness 自己给这个渠道设的"流多久没数据就掐断"
 *     （如 code-claude = 120000）；面板把它透给 LiveBench 的静默看门狗，
 *     这样"能长思考的渠道"和"确实会挂住的渠道"用的是各自合适的阈值。
 * @returns {Array<{id: string, name: string, api: string|null, baseURL: string|null, keyEnv: string|null, streamIdleTimeoutMs: number|null, models: Array<{id: string, name: string, efforts: string[], maxTokens: number|null}>}>}
 */
function readProviders(profileDir) {
	// profileDir = ~/.dsh/profiles/web  →  settings.yaml = ~/.dsh/settings.yaml
	const settingsPath = join(profileDir.replace(/[\\/]+$/, ""), "..", "..", "settings.yaml");
	const settings = existsSync(settingsPath) ? loadYaml(profileDir).parse(readFileSync(settingsPath, "utf8")) ?? {} : {};
	const providers = providerCapsFromSettings(settings);

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
 * settings.yaml（已解析）→ 面板用的 provider/模型清单。纯函数，便于回归测试。
 *
 * 除了 id/name/api/baseURL，还要带上两个**渠道约束**，面板必须遵守：
 *   - `models[].maxTokens`：该模型单次输出上限（如 claude-fable-5-1 = 64000）；
 *     面板的 max-tokens 默认 32000，不夹住就可能超过渠道上限（bearlab 这类渠道上限就是 32000）；
 *   - `streamIdleTimeoutMs`：harness 自己给这个渠道设的"流多久没数据就掐断"
 *     （如 code-claude = 120000）；面板把它透给 LiveBench 的静默看门狗，
 *     这样"能长思考的渠道"和"确实会挂住的渠道"各自用合适的阈值。
 * @param {object} settings 解析后的 settings.yaml
 */
function providerCapsFromSettings(settings) {
	const positiveNumber = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
	const providers = [];
	const piAi = settings?.["llm-pi-ai"]?.providers ?? {};
	for (const [id, cfg] of Object.entries(piAi)) {
		providers.push({
			id,
			name: typeof cfg?.displayName === "string" && cfg.displayName.length > 0 ? cfg.displayName : id,
			api: typeof cfg?.api === "string" ? cfg.api : null,
			baseURL: typeof cfg?.baseURL === "string" ? cfg.baseURL : null,
			keyEnv: typeof cfg?.apiKeyEnv === "string" ? cfg.apiKeyEnv : null,
			streamIdleTimeoutMs: positiveNumber(cfg?.streamIdleTimeoutMs),
			// 会话窗口（pi-ai）发输出上限时用的字段名 —— 面板要让 LiveBench 用同一个
			maxTokensField: maxTokensFieldFor({ id, baseURL: cfg?.baseURL, compat: cfg?.compat }),
			models: Array.isArray(cfg?.models)
				? cfg.models
					.filter((m) => m && typeof m.id === "string" && m.id.trim().length > 0)
					.map((m) => ({
						id: m.id.trim(),
						name: String(m.name ?? m.id).trim(),
						efforts: effortsOfModel(m),
						maxTokens: positiveNumber(m?.maxTokens),
					}))
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
			.map((m) => ({
				id: m.id.trim(),
				name: String(m.name ?? m.id).trim(),
				efforts: [...DEEPSEEK_EFFORTS],
				maxTokens: positiveNumber(m?.maxTokens),
			}))
		: DEFAULT_DEEPSEEK_MODELS.map((m) => ({ ...m, efforts: [...DEEPSEEK_EFFORTS], maxTokens: null }));
	providers.push({
		id: "deepseek-official",
		name: "DeepSeek 官方",
		api: "openai-completions",
		baseURL: typeof dsCfg.baseURL === "string" && dsCfg.baseURL.length > 0 ? dsCfg.baseURL : "https://api.deepseek.com",
		keyEnv: typeof dsCfg.apiKeyEnv === "string" && dsCfg.apiKeyEnv.length > 0 ? dsCfg.apiKeyEnv : "DEEPSEEK_API_KEY",
		streamIdleTimeoutMs: positiveNumber(dsCfg?.streamIdleTimeoutMs),
		// DeepSeek 官方在 pi-ai 的 detectCompat 里属于 useMaxTokens → max_tokens
		maxTokensField: "max_tokens",
		models: dsModels,
	});
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

/**
 * 缓存版的 scanCategoryTasks：/config 每次都要它，/results 也要用它算"某 release 下的
 * 有效题数"。question.jsonl 是静态文件，扫描结果缓存 60s 足够。
 */
let taskScanCache = { at: 0, data: null };
function scanCategoryTasksCached(dataDir) {
	const now = Date.now();
	if (taskScanCache.data !== null && now - taskScanCache.at < 60000) return taskScanCache.data;
	const data = scanCategoryTasks(dataDir);
	taskScanCache = { at: now, data };
	return data;
}

/**
 * 某个任务在指定 release 下的**有效题数**。
 * LiveBench 的 --question-begin/--question-end 作用在 release 过滤后的列表上，
 * 所以边界裁剪必须用这个数，而不是 question.jsonl 的原始行数。
 * @returns {number|null} null 表示没有该任务的数据（调用方回退到原始题数）。
 */
function releaseQuestionCount(tasks, category, task, release) {
	const meta = (tasks[category] ?? {})[task];
	if (!meta || !Array.isArray(meta.buckets) || typeof release !== "string" || release.length === 0) return null;
	let n = 0;
	for (const b of meta.buckets) {
		const releasedOk = b.r !== "" && b.r <= release;
		const notRemoved = b.rm === "" || b.rm > release;
		if (releasedOk && notRemoved) n += b.n;
	}
	return n;
}

/**
 * Python `list[begin:end]` 的长度，含越界裁剪。
 * 面板的「止」是闭区间，所以 end 先 +1 再按切片语义算：
 *   len = min(total, end+1) - min(total, begin)
 * 只写 min(total, end-begin+1) 会在 begin 也越界时算多
 * （8 题填 6-9，实际跑 2 题却算成 4 题）。
 */
function clampedRangeLength(total, begin, end) {
	if (!Number.isFinite(total) || total <= 0) return null;
	const b = Math.max(0, Math.min(total, Number(begin)));
	const e = Math.max(0, Math.min(total, Number(end) + 1));
	return Math.max(0, e - b);
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
 * 这个 模型/provider 是不是 Anthropic(Claude) 系？—— 决定要不要走 anthropic-messages 协议。
 * 名字里带 claude / anthropic 就算（provider id 或 model id 任一命中）。
 */
function isAnthropicModel(providerId, modelId) {
	return /claude|anthropic/i.test(String(modelId ?? "")) || /claude|anthropic/i.test(String(providerId ?? ""));
}

/**
 * anthropic SDK 会在 baseURL 后面自己拼 `/v1/messages`，所以 ANTHROPIC_BASE_URL
 * 必须是**站点根**：把用户可能写的 `/v1`、`/v1/messages`、结尾斜杠都剥掉。
 * 踩过的坑：settings.yaml 里 openai 兼容渠道习惯写成 `https://host/v1`，
 * 直接拿它当 ANTHROPIC_BASE_URL 会 POST 到 `https://host/v1/v1/messages` → 404。
 */
function anthropicBaseUrl(baseURL) {
	return String(baseURL ?? "")
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/v1\/messages$/i, "")
		.replace(/\/v1$/i, "")
		.replace(/\/+$/, "");
}

/**
 * 请求形状的"思考预算"档位（对齐 pi-ai）：
 *   - 有预算 → thinking enabled + budget_tokens
 *   - effort 明确是 off → thinking disabled
 *   - 其它（没选强度）→ 不写，交给上游默认
 */
function thinkingModeForEffort(effort) {
	const budget = thinkingBudgetForEffort(effort);
	if (budget !== null) return { type: "enabled", budget_tokens: budget };
	if (effort === "off") return { type: "disabled" };
	return null;
}

/**
 * LiveBench 发"单次输出上限"时该用哪个字段？
 *
 * 会话窗口（harness）走 pi-ai，会按渠道自动挑字段：大部分中转（aiportx、code28 等）
 * 用 `max_completion_tokens`；deepseek / moonshot / z.ai / together / nvidia /
 * ant-ling / chutes / Cloudflare 网关用 `max_tokens`
 * （对应 pi-ai `openai-completions.js` 的 `detectCompat().maxTokensField`）。
 * 而 LiveBench 的 `chat_completion_openai` 只看模型名里有没有 "gpt"：非 gpt 模型一律发
 * `max_tokens`。**实测 aiportx-claude 因此慢 5 倍以上**：同一道 olympiad、同一
 * `reasoning_effort=max`，发 `max_completion_tokens=64000` 用 224s 跑完（最大空档 106s）；
 * 发 `max_tokens=64000` 要 1232s，中途 449s 一个 chunk 都没有 —— 面板里就是"卡死"。
 * 所以面板在生成的模型配置里显式写死用哪个字段，LiveBench 看到就不再自己猜。
 * @param {{id?: string, baseURL?: string|null, compat?: object}} provider
 * @returns {"max_tokens"|"max_completion_tokens"}
 */
function maxTokensFieldFor(provider) {
	const explicit = provider?.compat?.maxTokensField;
	if (explicit === "max_tokens" || explicit === "max_completion_tokens") return explicit;
	const id = String(provider?.id ?? "");
	const url = String(provider?.baseURL ?? "").toLowerCase();
	const useMaxTokens = url.includes("chutes.ai")
		|| id === "deepseek" || url.includes("deepseek.com")
		|| id === "moonshotai" || id === "moonshotai-cn" || url.includes("api.moonshot.")
		|| id === "cloudflare-ai-gateway" || url.includes("gateway.ai.cloudflare.com")
		|| id === "together" || url.includes("api.together.ai") || url.includes("api.together.xyz")
		|| id === "nvidia" || url.includes("integrate.api.nvidia.com")
		|| id === "ant-ling" || url.includes("api.ant-ling.com")
		|| id === "zai" || id === "zai-coding-cn" || url.includes("api.z.ai") || url.includes("open.bigmodel.cn");
	return useMaxTokens ? "max_tokens" : "max_completion_tokens";
}

/**
 * 会话窗口（pi-ai 的 anthropic-messages 通道）给每个推理档位的 thinking 预算：
 * minimal 1024 / low 2048 / medium 8192 / high 16384，`xhigh` 与 `max` 都按 `high` 处理
 * （对应 `simple-options.js` 的 `DEFAULT_THINKING_BUDGETS` + `clampReasoning`）。
 *
 * **这个预算必须转发**：会话窗口在 anthropic 通道上固定发
 * `thinking: {type: enabled, budget_tokens: N}`（并且因为开了 thinking，
 * 就**完全不发 temperature**）。LiveBench 的 `chat_completion_anthropic` 不会自己发
 * `thinking`，于是上游走"自适应思考"：一道 olympiad 能安静地想十几分钟、
 * 中途一个 chunk 都没有（面板里表现为卡死 + 一堆 RemoteProtocolError）。
 * 面板把同一份预算写进生成的模型配置，让两边请求形状一致。
 */
const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384, max: 16384 };
function thinkingBudgetForEffort(effort) {
	return Number.isFinite(THINKING_BUDGETS[effort]) ? THINKING_BUDGETS[effort] : null;
}

/**
 * Write a single-entry model config into LiveBench's model_configs directory so
 * `get_model_config(displayName)` resolves it (instead of the bare custom-model
 * fallback) and the api_kwargs — e.g. `reasoning_effort` — reach the API call.
 * The file is regenerated on every start; secrets never go in here.
 * @returns {string|null} error message, or null on success.
 */
function writeGeneratedModelConfig(layout, YAML, { displayName, modelId, reasoningEffort, protocol, maxTokens = null, maxTokensField = null, thinkingBudget = null, thinkingDisabled = false }) {
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
	// 输出上限的字段名：写进 api_kwargs 后，LiveBench 的
	// `if 'max_tokens' not in api_kwargs and 'max_completion_tokens' not in api_kwargs`
	// 分支会被跳过，于是"用哪个字段"完全由面板决定（见 maxTokensFieldFor）。
	const limitLine = protocol === "openai" && maxTokensField === "max_completion_tokens"
		&& Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
		? `    max_completion_tokens: ${Number(maxTokens)}`
		: null;
	if (protocol === "anthropic") {
		// Route through LiveBench's native anthropic client; the endpoint is
		// pointed at the provider proxy via ANTHROPIC_BASE_URL (spawn env).
		lines.push(`  anthropic: ${modelId}`, "default_provider: anthropic");
		// 会话窗口在这个通道上固定带 thinking（并因此不带 temperature），面板照抄，
		// 否则上游会走"自适应思考"，一题能安静地想十几分钟（见 thinkingBudgetForEffort）。
		if (Number.isFinite(Number(thinkingBudget)) && Number(thinkingBudget) > 0) {
			lines.push(
				"api_kwargs:",
				"  default:",
				"    thinking:",
				"      type: enabled",
				`      budget_tokens: ${Number(thinkingBudget)}`,
				// thinking 与 temperature 互斥：显式置 None → LiveBench 映射成 NOT_GIVEN 而不发送
				"    temperature: null",
			);
		} else if (thinkingDisabled) {
			// 用户把强度选成 off：会话窗口发的是 {type: disabled}，不带 thinking 反而会让
			// 上游走默认（实测默认是"开思考"）。
			lines.push(
				"api_kwargs:",
				"  default:",
				"    thinking:",
				"      type: disabled",
				"    temperature: null",
			);
		}
	} else if (protocol === "openai_responses") {
		// OpenAI Responses API proxy: provider name matches
		// get_api_function('openai_responses') → chat_completion_openai_responses,
		// which converts reasoning_effort to reasoning:{effort} itself.
		lines.push(`  openai_responses: ${modelId}`);
		if (reasoningEffort || limitLine !== null) {
			lines.push("api_kwargs:", "  default:");
			if (reasoningEffort) lines.push(`    reasoning_effort: ${reasoningEffort}`);
			if (limitLine !== null) lines.push(limitLine);
		}
	} else {
		lines.push(`  local: ${modelId}`);
		if (reasoningEffort || limitLine !== null) {
			lines.push("api_kwargs:", "  default:");
			if (reasoningEffort) lines.push(`    reasoning_effort: ${reasoningEffort}`);
			if (limitLine !== null) lines.push(limitLine);
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

/** 从答案行里抽 answer_id（同样只做正则，不 JSON.parse）。 */
const ANSWER_ID_RE = /"answer_id"\s*:\s*"([A-Za-z0-9_.:-]{6,80})"/;

/** 一行答案归并后的状态：这一题最终算不算"做出来了"。 */
function newAnswerScan() {
	return { byQid: new Map(), anon: 0 };
}

/**
 * 把一行答案并进扫描状态（同一 question_id 后写的覆盖先写的）。
 *
 * 为什么必须按 question_id 归并：断点补跑（--resume --retry-failures）重跑出来的
 * 答案会**追加**到同一个文件里，旧行不会被删（LiveBench 自己靠 reorg_answer_file
 * 取每个 question_id 的最后一行）。不归并就会把同一题算两次：作答数虚高、
 * $ERROR$ 虚高，括号里的「没做出来 / 选择题数」跟着一起错。
 */
function scanAnswerLine(scan, line) {
	if (line.trim().length === 0) return;
	const idMatch = line.match(QUESTION_ID_RE);
	// 没有 question_id 的行（理论上不该有）用序号占位，避免互相覆盖
	const qid = idMatch !== null ? idMatch[1] : `\u0000#${scan.anon++}`;
	const aMatch = line.match(ANSWER_ID_RE);
	const isError = line.includes('"$ERROR$"');
	scan.byQid.set(qid, {
		isError,
		isEmpty: !isError && isEmptyAnswerLine(line),
		// 每次生成都会换一个 answer_id（gen_api_answer: shortuuid.uuid()），
		// 判分侧靠它区分"这条判分属于哪一次答案"，见 scoreJudgments。
		answerId: aMatch !== null ? aMatch[1] : null,
	});
}

/**
 * 收尾统计：作答数 / API 失败数 / 空答案数 / 有有效答案的题号。
 * @param {{byQid: Map<string,{isError:boolean,isEmpty:boolean,answerId:string|null}>}} scan
 */
function answerScanStats(scan) {
	const okIds = new Set();
	let errors = 0;
	let empty = 0;
	for (const [qid, rec] of scan.byQid) {
		if (rec.isError) errors += 1;
		else if (rec.isEmpty) empty += 1;
		else okIds.add(qid);
	}
	return { answered: scan.byQid.size, errors, empty, okIds, byQid: scan.byQid };
}

/** 答案文件全文 → 统计（scanAnswerLine + answerScanStats 的便捷封装）。 */
function reduceAnswerLines(text) {
	const scan = newAnswerScan();
	for (const line of text.split("\n")) scanAnswerLine(scan, line);
	return answerScanStats(scan);
}

/**
 * 判分归并：**只保留属于本次答案的那一条判分**。
 *
 * 补跑会换新 answer_id，而旧答案（例如 $ERROR$ 那一版）的 0 分判分仍留在
 * ground_truth_judgment.jsonl 里。老实现把所有判分行直接求和，于是
 * "补跑后每题都做对"也会被旧 0 分拉低（8 题里 4 题满分 + 4 条旧 0 分 → 50%）。
 *
 * 规则：
 *   - 答案文件里这一题是 $ERROR$ / 空答案 → 判分一律不计（没做出来，不进分母）；
 *   - 判分 answer_id 与当前答案一致 → 计入；
 *   - 判分/答案缺 answer_id（老数据）→ 无法区分，沿用旧行为计入；
 *   - 只剩旧答案的判分 → 丢弃（宁可少一题，也不把旧判分算进新成绩）；
 *   - 答案文件里根本没有这一题（只有判分）→ 沿用旧行为计入。
 *
 * @param {Array<{questionId:string|null,answerId:string|null,score:number,tstamp:number}>} judgments
 * @param {Map<string,{isError:boolean,isEmpty:boolean,answerId:string|null}>} byQid
 * @returns {{judged:number, sum:number, time:number}}
 */
function scoreJudgments(judgments, byQid) {
	const byQuestion = new Map();
	const orphans = [];
	for (const j of judgments) {
		if (j.questionId === null) {
			orphans.push(j);
			continue;
		}
		const list = byQuestion.get(j.questionId);
		if (list === undefined) byQuestion.set(j.questionId, [j]);
		else list.push(j);
	}
	let sum = 0;
	let judged = 0;
	let time = 0;
	const accept = (j) => {
		sum += j.score;
		judged += 1;
		if (Number.isFinite(j.tstamp) && j.tstamp > time) time = j.tstamp;
	};
	for (const [qid, list] of byQuestion) {
		const ans = byQid.get(qid);
		if (ans !== undefined && (ans.isError || ans.isEmpty)) continue;
		if (ans === undefined || ans.answerId === null) {
			accept(list[list.length - 1]);
			continue;
		}
		let picked = null;
		for (let i = list.length - 1; i >= 0; i -= 1) {
			if (list[i].answerId === ans.answerId) { picked = list[i]; break; }
		}
		if (picked === null) {
			for (let i = list.length - 1; i >= 0; i -= 1) {
				if (list[i].answerId === null) { picked = list[i]; break; }
			}
		}
		if (picked !== null) accept(picked);
	}
	for (const j of orphans) accept(j);
	return { judged, sum, time };
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

/**
 * 答案行是否"没产出内容"。
 *
 * 两类：
 *   1. `eval_status: token_exhaustion` —— 推理模型把 max_tokens 全烧在思考上，正文为空；
 *   2. `turns` / `choices` 是空串或空数组 —— 上游 200 但没给内容。
 *
 * 这两种都不是"做错了"，而是**没做出来**，不该进正确率的分母（用户口径：
 * 做对的题 / 做出来的题）。它们也不是 $ERROR$（那是 API 失败），所以单列一类。
 *
 * 用正则直接扫原始行，避免为了判定空答案去 JSON.parse 上百万字节的答案文件。
 */
const EMPTY_ANSWER_RE = /"eval_status"\s*:\s*"token_exhaustion"|"turns"\s*:\s*\[\s*(?:""\s*)?\]|"choices"\s*:\s*\[\s*""\s*\]/;
function isEmptyAnswerLine(line) {
	return EMPTY_ANSWER_RE.test(line);
}

/** 从答案行里抽 question_id（只做正则，不 JSON.parse）。 */
const QUESTION_ID_RE = /"question_id"\s*:\s*"([A-Za-z0-9_.:-]{8,120})"/;

/**
 * 「题目序号范围」的边界是否真的设了。
 *
 * 注意：面板表单里没填时提交的是**空字符串**，不是 null。旧代码只判 `!== null/undefined`，
 * 于是 `""` 被当成"设了范围"，`Number("") === 0` → 范围变成 0..0，只检查第 0 题。
 */
function isRangeBoundSet(value) {
	return value !== null && value !== undefined && String(value).trim().length > 0;
}

/** 把范围边界规范成 number 或 null（空串一律当没设）。 */
function normalizeRangeBound(value) {
	return isRangeBoundSet(value) ? Number(value) : null;
}

/**
 * 取某次运行的 baseline 有序 id 列表。
 * 新元数据直接读 baselineIds；老元数据（加字段之前启动的运行）从
 * baseline / baselineTask / baselinePicks 反查 BASELINE_SETS 还原。
 * @returns {string[]|null}
 */
function baselineIdsFor(meta) {
	if (!meta) return null;
	if (Array.isArray(meta.baselineIds) && meta.baselineIds.length > 0) return meta.baselineIds;
	const set = typeof meta.baseline === "string" ? BASELINE_SETS[meta.baseline] : null;
	const taskDef = set && typeof meta.baselineTask === "string"
		? (set.tasks ?? []).find((t) => t.task === meta.baselineTask) ?? null
		: null;
	if (!taskDef || !Array.isArray(meta.baselinePicks) || meta.baselinePicks.length === 0) return null;
	const merged = [];
	for (const pick of meta.baselinePicks) {
		if (pick !== "passed" && pick !== "failed") continue;
		for (const qid of taskDef[pick]) if (!merged.includes(qid)) merged.push(qid);
	}
	return merged.length > 0 ? merged : null;
}

/**
 * Baseline 评测里"没做出来的题号"。
 *
 * 「没做出来」= 压根没跑 + 跑了但空答案（思考吃满 max-tokens）+ 跑了但 API 失败，
 * 因为它们都该从正确率分母里排除，也都是用户想补跑的题。
 *
 * 编号是 **该题库内的 0 起下标**，与「题目序号范围」的编号一致，可以直接复制去重跑。
 * 范围先按题库实际题数裁剪 —— 「0-1000」这种越界输入不会把编号算歪（基准永远是实际题数）。
 *
 * @param {object|undefined} meta 运行元数据（baselineIds，或可由 baseline 反查）
 * @param {Set<string>} okIds 答案文件里有**有效答案**的 question_id
 * @returns {number[]|null} 不是 baseline 运行时返回 null
 */
function missingBaselineIndexes(meta, okIds) {
	const ids = baselineIdsFor(meta);
	if (ids === null) return null;
	const hasBegin = isRangeBoundSet(meta.begin);
	const hasEnd = isRangeBoundSet(meta.end);
	const from = hasBegin ? Math.max(0, Math.min(ids.length, Number(meta.begin))) : 0;
	const to = hasEnd ? Math.max(0, Math.min(ids.length, Number(meta.end) + 1)) : ids.length;
	const out = [];
	for (let i = from; i < Math.max(from, to); i += 1) {
		if (!okIds.has(ids[i])) out.push(i);
	}
	return out;
}

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
	const judged = new Map(); // `${model}\u0000${task}` -> {model, category, task, items: []}
	const totals = new Map(); // task -> question count
	const answers = new Map(); // `${model}\u0000${task}` -> 答案扫描状态（按 question_id 归并）
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
				// 逐行归并（不 JSON.parse 大答案行）：同一题保留最后一行，
				// 也就是补跑后的新答案 —— 与 LiveBench reorg_answer_file 的口径一致。
				const scan = answers.get(key) ?? newAnswerScan();
				for (const line of text.split("\n")) scanAnswerLine(scan, line);
				// 空文件（尚未产出答案，或成绩已被删除只留下 0 字节壳）不计入结果：
				// 否则删掉的记录会在下一次扫描时凭“文件名仍在”重新冒出来。
				if (scan.byQid.size > 0) answers.set(key, scan);
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
					const entry = judged.get(key) ?? { model, category, task, items: [] };
					entry.items.push({
						questionId: typeof row.question_id === "string" ? row.question_id : null,
						answerId: typeof row.answer_id === "string" ? row.answer_id : null,
						score,
						tstamp: Number(row.tstamp),
					});
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
		const scan = answers.get(key) ?? null;
		const [model, task] = key.split("\u0000");
		const category = entry?.category ?? catByTask.get(task) ?? "";
		const total = totals.get(task) ?? 0;
		// 答案先归并到「每题一条最新记录」，再用它给判分定性：
		// 「做出来」的题 = 有有效答案的题；思考吃满 max_tokens（正文为空）、
		// API 失败都不是"做错了"，不能进正确率分母，也不能被旧判分拉低。
		const stat = scan === null ? { answered: 0, errors: 0, empty: 0, okIds: new Set(), byQid: new Map() } : answerScanStats(scan);
		const { judged: judgedCount, sum, time: judgedTime } = scoreJudgments(entry?.items ?? [], stat.byQid);
		const empty = stat.empty;
		const notProduced = stat.errors + empty;
		const done = Math.max(0, stat.answered - notProduced);
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
				// 「可选题目总数」的基准，按优先级取：
				//   baseline 子集大小 > 该任务在本次 release 下的有效题数 > question.jsonl 原始行数。
				// 基准取错会把越界的范围当成有效选择（题库只有 8 题而用户填 0-8 时算出 9 题），
				// 于是 notDone 永远多 1，全做对也显示 (-1/8)。
				const byRelease = releaseQuestionCount(scanCategoryTasksCached(dataDir), category, task, meta.release);
				const baselineTotal = Number.isFinite(Number(meta.baselineSize)) && Number(meta.baselineSize) > 0
					? Number(meta.baselineSize)
					: null;
				const scopeTotal = baselineTotal ?? byRelease ?? total;
				const hasRange = isRangeBoundSet(meta.begin) && isRangeBoundSet(meta.end);
				if (hasRange) {
					const len = clampedRangeLength(scopeTotal, Number(meta.begin), Number(meta.end));
					if (len !== null) configured = len;
				} else if (baselineTotal !== null) {
					// baseline 且没设范围 = 整个题库，所以"选择题数"恒等于题库大小，
					// 而不是当前已答题数（否则跑到一半会显示"选择 6 题"）
					configured = baselineTotal;
				}
			}
		}
		// 实际尝试数比设定还多（断点重跑等）时，以实际为准
		if (configured < stat.answered) configured = stat.answered;
		const notDone = Math.max(0, configured - done);
		// 正确率 = 做对的题 / **做出来的题**（API 失败、思考吃满 token 没产出答案的都不进分母）。
		// judgedCount 已经只统计"属于本次答案"的判分，所以这里不再减 notProduced：
		// 那些题的判分（如果有）在 scoreJudgments 里就已经被剔除了。
		const score = judgedCount > 0 ? (sum / judgedCount) * 100 : null;
		// Baseline 评测：算出**具体哪几个题号没做出来**（题号 = 该题库内的 0 起下标，
		// 与「题目序号范围」的编号一致，方便直接复制去重跑）。
		const missingIndexes = missingBaselineIndexes(meta, stat.okIds);
		return {
			model,
			category,
			task,
			score,
			judged: judgedCount,
			total,
			time: judgedTime > 0 ? judgedTime : null,
			answered: stat.answered,
			errors: stat.errors,
			empty,
			notProduced,
			done,
			configured,
			notDone,
			// baseline 专有：没做出来的题号（0 起，相对该题库）
			missingIndexes,
			// 本次运行的开始时间（ISO）；旧数据没有元数据时为 null，前端退回解析 displayName 里的运行戳
			runStartedAt: meta !== undefined && typeof meta.startedAt === "string" ? meta.startedAt : null,
			// 非 null 表示这一行跑的是 Baseline 题库子集，不是该任务全量
			baselineLabel: meta !== undefined && typeof meta.baselineLabel === "string" ? meta.baselineLabel : null,
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
 * 异步统计某模型在指定 bench 范围内"最终仍是 $ERROR$"的题数（用于自动补跑判断）。
 *
 * benchPaths 必须是**服务端解析后的** bench 列表（`live_bench/<cat>[/<task>]`）。
 * 早期版本直接读 body.benchNames，而 Baseline 评测根本不送这个字段（它送的是
 * baseline/baselineTask/baselinePicks），于是 baseline 跑完全军覆没也不会自动补跑 ——
 * 这正是 kimi-k3 那次 8 题全 502、面板只留一行 `—`、没有任何重试的原因。
 *
 * 按 question_id 归并后统计（同一题补跑成功过就不再算失败），流式读取不阻塞事件循环。
 * @returns {Promise<{errors:number, failedIds:string[]}>}
 */
async function countErrorAnswersAsync(dataDir, displayName, benchPaths) {
	if (!/^[A-Za-z0-9._@-]{1,160}$/.test(displayName)) return { errors: 0, failedIds: [] };
	const benches = Array.isArray(benchPaths) ? benchPaths : [];
	const scan = newAnswerScan();
	for (const bn of benches) {
		const parts = String(bn).split("/").filter((s) => s.length > 0); // live_bench/<cat>[/<task>]
		if (parts.length < 2) continue;
		const category = parts[1];
		const tasks = parts.length >= 3 ? [parts[2]] : readDirSafe(join(dataDir, category));
		for (const task of tasks) {
			if (!/^[A-Za-z0-9_]{1,80}$/.test(task)) continue;
			const file = join(dataDir, category, task, "model_answer", displayName + ".jsonl");
			await streamJsonl(file, (line) => scanAnswerLine(scan, line));
		}
	}
	const failedIds = [];
	for (const [qid, rec] of scan.byQid) if (rec.isError) failedIds.push(qid);
	return { errors: failedIds.length, failedIds };
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

/**
 * LiveBench 的分类列表（权威来源是 LiveBench 自己的 `LIVE_BENCH_CATEGORIES`）。
 *
 * 面板要判断"本次要跑的题目数据集是否都已缓存"，而 `--bench-name live_bench`
 * （全部分类）的路径里没有分类段 —— 不补上分类列表就会误判成"没缓存"，
 * 于是每个分类都要走一遍 huggingface.co 的 HEAD 超时重试（WinError 10060 刷屏）。
 * 所以直接从 LiveBench 源码里读那份列表，读不到再用兜底常量。
 * @param {string} root LiveBench 根目录
 * @returns {string[]} 分类名（如 coding / math / reasoning …）
 */
const LIVEBENCH_CATEGORIES_FALLBACK = ["coding", "data_analysis", "instruction_following", "math", "reasoning", "language"];
function livebenchCategories(root) {
	try {
		const text = readFileSync(join(root, "livebench", "common.py"), "utf8");
		const block = text.match(/LIVE_BENCH_CATEGORIES\s*=\s*\[([^\]]*)\]/);
		if (block !== null) {
			const names = [...block[1].matchAll(/"([A-Za-z0-9_]{1,40})"/g)].map((m) => m[1]);
			if (names.length > 0) return names;
		}
	} catch { /* 源码读不到（改过结构/权限）时用兜底列表 */ }
	return LIVEBENCH_CATEGORIES_FALLBACK;
}

/**
 * 一次运行需要哪些题目数据集（= 分类）？
 *
 * bench 路径带分类（`live_bench/<分类>[/<任务>]`）就用它；
 * 只给 `live_bench`（全跑）时就是**全部分类** —— 这里漏掉分类是实测踩过的坑：
 * 答案为空的集合 → 判成"没缓存" → 每个分类白刷 5 轮 HF 超时重试。
 * @param {string[]} benchPaths 服务端解析后的 bench 列表
 * @param {string[]} categories LiveBench 全部分类
 * @returns {Set<string>}
 */
function hfCategoriesFor(benchPaths, categories) {
	const out = new Set();
	for (const bn of benchPaths) {
		const parts = String(bn).split("/").filter((s) => s.length > 0);
		if (parts.length >= 2 && /^[A-Za-z0-9_]{1,80}$/.test(parts[1])) out.add(parts[1]);
		else for (const cat of categories) out.add(cat);
	}
	return out;
}

function apply(ctx) {
	/** All runs: runId -> record. Several evaluations may run concurrently. */
	const runs = new Map();

	/**
	 * 启动一次评测。
	 * @param {object} body 面板送来的请求体
	 * @param {number} autoRetries 已经自动补跑过几轮
	 * @param {string|null} displayNameOverride 自动补跑时复用首次运行的 display-name：
	 *   answers 文件同名 → `--resume --retry-failures` 只重跑失败题（其它题的答案与判分都留着），
	 *   成绩表里也仍然只有一行，而不是每次补跑多冒出一行。
	 */
	const startRun = async (body, autoRetries = 0, displayNameOverride = null) => {
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
		let release = typeof body.release === "string" ? body.release : "2024-11-25";
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
		// Baseline 题库则完全绕开分类/任务选择（"不选 = 全部分类"不适用），
		// 锁定到它自己的任务 + 一组 question id。
		const baselineKey = typeof body.baseline === "string" && body.baseline.length > 0 ? body.baseline : null;
		const baseline = baselineKey !== null ? (BASELINE_SETS[baselineKey] ?? null) : null;
		if (baselineKey !== null && baseline === null) {
			return { status: 400, payload: { ok: false, error: `unknown baseline: ${baselineKey}` } };
		}
		let benchNames = null;
		// Baseline 是三层选择：参考模型 + 任务 + 对/错。服务端负责把选择解析成 question id 列表，
		// 客户端只送选择，不送 id —— 免得界面与题库数据脱节。
		let baselinePick = null;
		if (baseline !== null) {
			const taskKey = typeof body.baselineTask === "string" ? body.baselineTask : "";
			const picks = Array.isArray(body.baselinePicks)
				? body.baselinePicks.filter((p) => p === "passed" || p === "failed")
				: [];
			const baselineTask = baseline.tasks.find((t) => t.task === taskKey) ?? null;
			if (baselineTask === null) {
				return { status: 400, payload: { ok: false, error: `baseline ${baselineKey}: 未选择任务（或任务不存在）：${taskKey}` } };
			}
			if (picks.length === 0) {
				return { status: 400, payload: { ok: false, error: `baseline ${baselineKey}/${taskKey}: 请至少选择「做对」或「做错」之一` } };
			}
			const ids = [];
			const seen = new Set();
			for (const pick of picks) {
				for (const qid of baselineTask[pick]) {
					if (!seen.has(qid)) { seen.add(qid); ids.push(qid); }
				}
			}
			if (ids.length === 0) {
				return { status: 400, payload: { ok: false, error: `baseline ${baselineKey}/${taskKey}: 所选分组没有题目` } };
			}
			// baseline 的 question id 属于特定 release，跟着用户选别的 release 会一题都匹配不到
			release = baselineTask.release;
			benchNames = [baselineTask.task];
			baselinePick = { label: baseline.label, task: baselineTask.task, picks, ids };
		} else if (Array.isArray(body.benchNames) && body.benchNames.length > 0) {
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
		const displayName = typeof displayNameOverride === "string" && displayNameOverride.length > 0
			? displayNameOverride
			: displayModelName(providerId || "direct", modelId) + (hasEffortSuffix ? "@" + effort : "") + "__" + runStamp;
		let writeError = null;		// Anthropic-protocol proxies cannot go through --api-base (that path
		// speaks OpenAI Chat Completions). Instead the generated model config
		// selects LiveBench's native anthropic client and the spawn env points
		// the SDK at the proxy (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY).
		//
		// 规则（用户要求 + 实测）：**只要是 Anthropic/Claude 系模型，一律走 anthropic-messages**，
		// 不再看 settings.yaml 里写的是 openai-completions 还是 anthropic-messages ——
		// 会话窗口对这类模型用的就是 /v1/messages，两边协议一致才谈得上"形状一致"。
		// baseURL 会被规范化（剥掉 /v1、/v1/messages），因为 anthropic SDK 自己拼 /v1/messages。
		const anthropicRouteBase = provider?.baseURL ? anthropicBaseUrl(provider.baseURL) : "";
		const isAnthropicRoute = anthropicRouteBase.length > 0
			&& (provider.api === "anthropic-messages" || isAnthropicModel(providerId, modelId));
		// OpenAI Responses-API proxies (api: openai-responses) select LiveBench's
		// openai_responses client; --api-base + LIVEBENCH_API_KEY route them the
		// usual way, and reasoning_effort converts to reasoning:{effort} inside.
		const isOpenAIResponsesRoute = provider
			&& (provider.api === "openai-responses" || provider.api === "openai_responses")
			&& provider.baseURL;
		// 每次都写自己的模型配置，并且 --model 永远用 display-name。
		// 不能图省事把裸模型名交给 LiveBench：它会用 get_model_config(裸名) 去撞它自带的
		// 模型库（例如 "kimi-k3" 命中 moonshotai.yml），命中后就改用那份配置的
		// provider / api_kwargs / max_tokens —— 实测会把 temperature 悄悄变成 1.0、
		// max_tokens 变成 131072，等于用户选的 provider 被换掉。写了自己的配置，
		// 解析结果就是确定的 {local: <modelId>} + --api-base。
		// max-tokens：面板默认 32000（LiveBench 自带默认只有 4096，推理模型会思考吃满、
		// 正文为空 → 记「没做出来」；32k 是够用与耗时之间的折中，难题可手动调到 65536）。
		// 另外不能超过 harness 给这个模型声明的上限（settings.yaml 的 models[].maxTokens，
		// 例如 claude-fable-5-1 = 64000、bearlab-claude = 32000）。
		const requestedMaxTokens = asInt(body.maxTokens, 256, 200000, 32000);
		const modelMaxTokens = modelMeta !== null && Number(modelMeta.maxTokens) > 0 ? Number(modelMeta.maxTokens) : null;
		const maxTokens = modelMaxTokens !== null ? Math.min(requestedMaxTokens, modelMaxTokens) : requestedMaxTokens;
		writeError = writeGeneratedModelConfig(layout, loadYaml(profileDir), {
			displayName,
			modelId,
			reasoningEffort: isAnthropicRoute ? null : effort,
			protocol: isAnthropicRoute ? "anthropic" : isOpenAIResponsesRoute ? "openai_responses" : "openai",
			// 输出上限与字段名：让 LiveBench 用**会话窗口同样的字段**发出去
			// （aiportx 这类中转要 max_completion_tokens；发 max_tokens 会慢数倍甚至卡死）
			maxTokens,
			// provider 上已经算好（providerCapsFromSettings 里调 maxTokensFieldFor，
			// 会尊重 settings.yaml 显式声明的 compat.maxTokensField）
			maxTokensField: provider !== null ? provider.maxTokensField : null,
			// anthropic 通道：把会话窗口那份 thinking 预算一起发出去（见 thinkingBudgetForEffort）
			thinkingBudget: isAnthropicRoute ? thinkingBudgetForEffort(effort) : null,
			thinkingDisabled: isAnthropicRoute && effort === "off",
		});
		if (writeError) return { status: 500, payload: { ok: false, error: writeError } };

		const benchParts = ["live_bench", ...(category ? [category] : []), ...(task ? [task] : [])];
		// 服务端最终使用的 bench 列表：自动补跑扫描（找 $ERROR$）和 HF 缓存判断都用它，
		// 不能用 body.benchNames —— baseline 评测不送这个字段。
		const benchPaths = benchNames !== null ? benchNames : [benchParts.join("/")];
		const args = [
			"run_livebench.py",
			"--model", displayName,
			"--model-display-name", displayName,
			"--bench-name",
			...benchPaths,
			"--livebench-release-option", release,
			// 上限放到 200k：推理模型在难题上会把 max_tokens 全烧在思考里，正文为空
			// （eval_status=token_exhaustion），此时"做不出来"其实是预算不够而不是能力不够。
			// 旧上限 32768 在 olympiad 这类题上会直接把参考模型卡死。
			"--max-tokens", String(maxTokens),
			"--parallel-requests", String(asInt(body.parallel, 1, 8, 1)),
			// 流式：中转网关（Cloudflare 等）对非流式请求有 ~100s 超时（524），
			// 高推理强度模型思考数分钟必然超时。流式保持字节流动可规避。
			"--stream",
			"--mode", "single",
		];
		// Baseline：直接点名 question id。--question-id 是 nargs="+"，后面跟一串 id；
		// 它和后面的 --question-begin/--question-end 叠加时，范围作用在**id 过滤后**的
		// 列表上（gen_api_answer: load_questions(..., question_id) 之后才做 [begin:end]），
		// 所以「题目序号范围」对 baseline 题库同样有效。
		if (baselinePick !== null) {
			args.push("--question-id", ...baselinePick.ids);
		}
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

		// HuggingFace 只用来取题目数据集。国内网络下 huggingface.co 常常连不通：
		// 每次评测都要先 HEAD 请求超时重试 5 轮（1+2+4+8+8s 退避 + 每次约 21s 的连接超时，
		// 实测刷一屏 WinError 10060），再回落到本地缓存。
		// 本次要跑的分类**都已在缓存里**时直接离线启动：题目一样，省掉整段等待。
		// 缺任何一个分类的缓存就不设离线 —— 保留联网下载能力，避免"新 release
		// 的题目还没下过"这种正常场景被离线模式直接判死。
		//
		// 注意 `--bench-name live_bench`（全部分类）时 bench 路径里没有分类段，
		// 必须自己补上分类列表，否则会被误判成"没缓存"→ 6 个分类各刷一遍超时重试
		// （实测：跑到第 3 个分类已经白等 10 分钟，用户看到的"总是报错"就是这个）。
		const hfCategories = hfCategoriesFor(benchPaths, livebenchCategories(layout.root));
		const hfMissing = [...hfCategories].filter((cat) => !existsSync(join(layout.root, ".hf_cache", "datasets", `livebench___${cat}`)));
		const hfCached = hfCategories.size > 0 && hfMissing.length === 0;
		// harness 给这个渠道声明的"流多久没数据就掐断"（毫秒）→ 秒
		const providerIdleSeconds = Number.isFinite(Number(provider?.streamIdleTimeoutMs)) && Number(provider.streamIdleTimeoutMs) > 0
			? Math.max(30, Math.round(Number(provider.streamIdleTimeoutMs) / 1000))
			: null;

		const env = {
			...process.env,
			HF_HOME: join(layout.root, ".hf_cache"),
			HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
			// 真要联网时也别卡太久：把 etag/下载超时压低，失败得快一点。
			HF_HUB_ETAG_TIMEOUT: "5",
			HF_HUB_DOWNLOAD_TIMEOUT: "30",
			...(hfCached ? { HF_HUB_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" } : {}),
			// 静默看门狗阈值：优先用 harness 给这个渠道声明的 streamIdleTimeoutMs
			// （code-claude = 120000 → 120s），没声明就不设，由 LiveBench 用自己的
			// 保守默认（600s）。**不能一律压到 120s** —— Claude 这类模型答一道
			// olympiad 本来就要 2~5 分钟、输出 1~2 万 token，阈值太小会把正常长思考
			// 当成"挂住"反复掐断（实测：一题被掐 5 次、每次 120s，最后记 $ERROR$）。
			...(providerIdleSeconds !== null ? { LIVEBENCH_STREAM_IDLE_TIMEOUT: String(providerIdleSeconds) } : {}),
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
		// 丢掉从 dsh web 进程继承来的虚拟环境标记。
		//
		// run_livebench.py 会读 VIRTUAL_ENV 并执行 `source <VIRTUAL_ENV>/bin/activate`：
		// 那是 Unix 路径 + Unix 语法，Windows 上必然失败；更糟的是它接着用写死的 ':'
		// 去拼 PATH，把上面刚前置好的 venv Scripts 条目粘成无效路径，于是后面裸调的
		// `python` 回退到系统/conda 解释器，报 `No module named 'shortuuid'`。
		//
		// 本机常见触发场景：dsh web 是从一个 conda 已激活的终端启动的（例如
		// VIRTUAL_ENV=D:\...\Anaconda3\envs\mineru）。面板自己已经把正确的 venv 放在
		// PATH 最前，不需要任何 activate，所以这里直接删掉这两个标记。
		delete env.VIRTUAL_ENV;
		delete env.CONDA_PREFIX;
		delete env.CONDA_DEFAULT_ENV;
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
			if (isAnthropicRoute) {
				// The generated model config selects the native anthropic client;
				// the Anthropic SDK picks endpoint+key up from these env vars and
				// appends /v1/messages itself —— 所以这里给的是**站点根**，
				// 不再给 --api-base（那条路只讲 OpenAI Chat Completions）。
				if (key) env.ANTHROPIC_API_KEY = key;
				env.ANTHROPIC_BASE_URL = anthropicRouteBase;
			} else if (provider.api === "openai-completions" || provider.api === "openai-responses" || provider.api === "openai_responses") {
				// openai-responses 与 openai-completions 一样走 --api-base + LIVEBENCH_API_KEY
				// （Responses 客户端同样从 api_dict 读 base_url/api_key）。
				args.push("--api-base", provider.baseURL);
				if (key) env.LIVEBENCH_API_KEY = key;
			} else if (provider.api === "anthropic-messages") {
				if (key) env.ANTHROPIC_API_KEY = key;
				env.ANTHROPIC_BASE_URL = anthropicRouteBase;
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
				// 空串要存成 null：否则读取端会把「没填」当成"范围 0..0"
				begin: normalizeRangeBound(body.begin),
				end: normalizeRangeBound(body.end),
				// 算"本次设定题数"要用 release 过滤后的有效题数来裁剪边界，所以必须记下来
				release,
				// baseline 评测标出来：成绩表里同一列会混着"全量"和"题库子集"两种分数，
				// 不标注就没法解读。
				baseline: baselinePick !== null ? baselineKey : null,
				baselineLabel: baselinePick !== null
					? `${baselinePick.label} · ${baselinePick.task.split("/").slice(-1)[0]} · ${baselinePick.picks.map((p) => (p === "passed" ? "做对" : "做错")).join("+")}`
					: null,
				baselineTask: baselinePick !== null ? baselinePick.task : null,
				baselinePicks: baselinePick !== null ? baselinePick.picks : null,
				baselineSize: baselinePick !== null ? baselinePick.ids.length : null,
				// 实际使用的有序 id 列表：/results 靠它算出"少做了哪几题"
				baselineIds: baselinePick !== null ? baselinePick.ids : null,
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
			// 服务端解析后的 bench 列表：自动补跑扫描要用（baseline 评测没有 body.benchNames）
			benchPaths,
			autoRetries,
			exitCode: null,
			startedAt: new Date().toISOString(),
			command: [layout.pythonExe, ...args].join(" "),
			log: [
				`$ ${[...args].join(" ")}`,
				...(modelMaxTokens !== null && requestedMaxTokens > modelMaxTokens
					? [`[cap] 面板请求的 max-tokens ${requestedMaxTokens} 超过该模型在 settings.yaml 里声明的上限 ${modelMaxTokens}，本次按 ${modelMaxTokens} 发送`]
					: []),
				...(hfCached
					? [`[hf] 题目数据集已在本地缓存（${[...hfCategories].join(", ")}），本次离线读取，跳过 huggingface.co 联网检查`]
					: hfMissing.length > 0
						? [`[hf] 以下分类的数据集还没有本地缓存：${hfMissing.join(", ")} —— 本次会联网向 huggingface.co 取；连不通时会先超时重试 5 轮再失败`]
						: []),
				// 路由与请求形状：出问题时这段是唯一能自证"面板到底发了什么"的地方
				...(isAnthropicRoute
					? [`[route] Anthropic 系模型 → anthropic-messages（POST ${anthropicRouteBase}/v1/messages）；`
						+ `max_tokens=${maxTokens}；thinking=${JSON.stringify(thinkingModeForEffort(effort) ?? "不写（交给上游默认）")}`]
					: [`[route] ${provider !== null ? provider.api ?? "未知协议" : "直连"} → ${args.includes("--api-base") ? `--api-base ${provider?.baseURL}` : "内置默认端点"}；`
						+ `max_tokens=${maxTokens}（字段 ${provider?.maxTokensField ?? "默认"}）`]),
			],
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
			// 自动补跑：正常结束但仍有 $ERROR$ 答案时，用 --resume --retry-failures
			// 只重跑失败题（最多 3 轮）。统计改为异步流式（同步版曾阻塞事件循环，
			// 且函数缺失会在 close 回调抛未捕获异常 → DSH 假死断连）。
			// 复用同一个 display-name：答案写回同一个文件，只补失败的题；
			// 换了名字就会整套重跑一遍，还在成绩表里多出一行。
			if (record.exitCode === 0 && record.autoRetries < 3 && record.body) {
				(async () => {
					try {
						const { errors, failedIds } = await countErrorAnswersAsync(layout.dataDir, record.displayName, record.benchPaths ?? []);
						if (errors > 0) {
							record.log.push(`[自动补跑] 检测到 ${errors} 题 API 失败（$ERROR$），`
								+ `第 ${record.autoRetries + 1}/3 轮：只重跑这几题，其余答案与判分保留`);
							const retryBody = { ...record.body, resume: true, retryFailures: true };
							setTimeout(() => {
								startRun(retryBody, record.autoRetries + 1, record.displayName).catch((e) => {
									appendLog(record, `[自动补跑启动失败] ${e.message}`);
								});
							}, [15000, 60000, 180000][Math.min(record.autoRetries, 2)]);
						} else {
							record.log.push(`[自动补跑] 检查通过：${(record.benchPaths ?? []).join(", ")} 没有 $ERROR$ 答案`);
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
				tasks: scanCategoryTasksCached(layout.dataDir),
				// Baseline 题库：参考模型在各任务上的实测对错，供"探针"式快速评测选用
				baselines: Object.values(BASELINE_SETS).map((b) => ({
					id: b.id,
					label: b.label,
					referenceModel: b.referenceModel,
					tasks: b.tasks.map((t) => ({
						task: t.task,
						category: t.category,
						taskName: t.taskName,
						release: t.release,
						total: t.passed.length + t.failed.length,
						passedCount: t.passed.length,
						failedCount: t.failed.length,
					})),
				})),
				providers: providers.map(({ id, name: pname, models, api, baseURL, streamIdleTimeoutMs, maxTokensField }) => ({
					id,
					name: pname,
					routable: ["openai-completions", "openai-responses", "openai_responses", "anthropic-messages"].includes(api)
						&& typeof baseURL === "string" && baseURL.length > 0,
					baseURL: baseURL ?? null,
					// harness 给这个渠道设的流空闲阈值（毫秒）；面板会透给 LiveBench 的静默看门狗
					streamIdleTimeoutMs: streamIdleTimeoutMs ?? null,
					// 会话窗口（pi-ai）发输出上限用的字段名；面板让 LiveBench 也用同一个
					maxTokensField: maxTokensField ?? null,
					// models 里带 maxTokens（该模型单次输出上限），面板用它夹 --max-tokens
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

export { name, inject, apply, writeGeneratedModelConfig, readProviders, providerCapsFromSettings, maxTokensFieldFor, thinkingBudgetForEffort, thinkingModeForEffort, isAnthropicModel, anthropicBaseUrl, validateBenchName, clampedRangeLength, releaseQuestionCount, isEmptyAnswerLine, missingBaselineIndexes, baselineIdsFor, reduceAnswerLines, scoreJudgments, countErrorAnswersAsync, livebenchCategories, hfCategoriesFor };
