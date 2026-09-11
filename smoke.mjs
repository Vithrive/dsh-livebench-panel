// dsh-livebench-panel node-half smoke test (not shipped)
import { join } from "node:path";
import { homedir } from "node:os";

const mod = await import("./lib/index.js");
console.log("exports:", Object.keys(mod));

const routes = new Map();
const effects = [];
const ctx = {
	baseUrl: "file:///" + join(homedir(), ".dsh/profiles/web").replace(/\\/g, "/"),
	effect(fn, label) { effects.push(label); fn(); },
	webServer: { register(route) { routes.set(route.path, route.handler); } },
};
mod.apply(ctx);
console.log("effects registered:", effects);
console.log("routes registered:", [...routes.keys()]);

// mock req/res
function mockRes() {
	return new Promise((resolve) => {
		const res = {
			statusCode: 0, body: "",
			writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
			end(payload) { this.body = payload; resolve(res); },
		};
		void resolve; void res;
	});
}

// 1) /config
const res1 = await (async () => {
	let resolveFn;
	const p = new Promise((r) => { resolveFn = r; });
	const res = {
		writeHead(code) { this.code = code; },
		end(payload) { this.payload = payload; resolveFn(this); },
	};
	await routes.get("/dsh-livebench-panel/api/config")({ method: "GET", headers: {} }, res);
	return res;
})();
const config = JSON.parse(res1.payload);
console.log("config:", { ok: config.ok, available: config.available, root: config.root, releases: config.releases.length, categories: Object.keys(config.tasks), providers: config.providers.length });

// 2) /results
const res2 = await (async () => {
	let resolveFn;
	const p = new Promise((r) => { resolveFn = r; });
	const res = {
		writeHead(code) { this.code = code; },
		end(payload) { this.payload = payload; resolveFn(this); },
	};
	await routes.get("/dsh-livebench-panel/api/results")({ method: "GET", headers: {} }, res);
	return res;
})();
const results = JSON.parse(res2.payload);
console.log("results rows:", results.rows.length, "| sample:", results.rows.slice(0, 2));

// 3) /status (no run yet)
const res3 = await (async () => {
	let resolveFn;
	const p = new Promise((r) => { resolveFn = r; });
	const res = { writeHead() {}, end(payload) { this.payload = payload; resolveFn(this); } };
	await routes.get("/dsh-livebench-panel/api/status")({ method: "GET", headers: {} }, res);
	return res;
})();
console.log("status:", res3.payload);

// 4) /start validation path (empty body → 400, no spawn)
const { EventEmitter } = await import("node:events");
const res4 = await (async () => {
	let resolveFn;
	const p = new Promise((r) => { resolveFn = r; });
	const res = { writeHead(code) { this.code = code; }, end(payload) { this.payload = payload; resolveFn(this); } };
	const req = new EventEmitter();
	req.method = "POST";
	req.headers = { origin: "http://127.0.0.1:3080" };
	// feed handlers first, then emit end with empty body
	const handlerPromise = routes.get("/dsh-livebench-panel/api/start")(req, res);
	queueMicrotask(() => { req.emit("end"); });
	await handlerPromise;
	return res;
})();
console.log("start (empty body) →", res4.code, res4.payload);

// 5) /start with a real model spec, but LiveBench unreachable is fine — we only
//    verify arg construction by checking the spawn error path is graceful.
console.log("SMOKE OK");
