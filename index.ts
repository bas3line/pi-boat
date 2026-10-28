/**
 * Boat sandbox: `pi --boat` runs every tool call inside a boat.dev sandbox.
 *
 * The agent, your models and your keys stay on this machine. bash, read,
 * write, edit, ls, grep and find run in the sandbox over SSH (one multiplexed
 * connection, so a call costs a round trip, not a handshake).
 *
 *   pi --boat                     new sandbox, or reattach this session's
 *   pi --boat --boat-type large   small | default | large | xlarge
 *
 * On launch a git project is copied in with `boat push` (tracked and unignored
 * files, no .git) and committed in the sandbox as `boat-base`; outside a repo
 * nothing is copied. `/boat-pull` applies everything changed since then to your
 * local copy as a patch. Quitting with unpulled changes leaves the sandbox on;
 * otherwise it is stopped (deleted without a session file). Resuming the
 * session resumes and reattaches it.
 *
 * Boat's auto-stop is not an idle timer and SSH does not push it back, so tool
 * calls extend it (at most every EXTEND_EVERY_MS). If pi dies, the sandbox
 * stops TTL_SECONDS after the last tool call.
 */

import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BashOperations,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	LsOperations,
	ReadOperations,
	ToolDefinition,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const SESSION_ENTRY = "boat-session";
const KEY = path.join(os.homedir(), ".ssh", "ascii_box_ed25519");
const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "boat");
const REMOTE_HOME = "/home/user";
const TTL_SECONDS = 3600;
const EXTEND_EVERY_MS = 10 * 60_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const STOPPED_STATES = ["archived", "archiving"];
const DEAD_STATES = ["error", "cancelled"];

interface Endpoint {
	host: string;
	port: number;
}

interface Active {
	id: string;
	cwd: string;
	endpoint: Endpoint;
}

interface EntryData {
	id: string;
	cwd: string;
}

interface SshResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

interface SshOptions {
	stdin?: Buffer | string;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function realpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

// --- boat CLI ---

function boat(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("boat", ["--no-update", ...args], { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (d) => out.push(d));
		child.stderr.on("data", (d) => err.push(d));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out).toString());
			else {
				const msg = Buffer.concat(err).toString().trim() || Buffer.concat(out).toString().trim();
				reject(new Error(`boat ${args[0]}: ${msg || `exit ${code}`}`));
			}
		});
	});
}

/** The last JSON object of a (possibly JSONL) `--json` reply. */
function lastJson(text: string): any {
	const lines = text.trim().split("\n").filter(Boolean);
	return JSON.parse(lines[lines.length - 1]);
}

async function boatInfo(id: string): Promise<any> {
	const reply = lastJson(await boat(["info", id, "--json"]));
	return reply.sandbox ?? reply;
}

/** Print mode has no UI, so notifications would vanish; send them to stderr there. */
function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(`[boat] ${message}`);
}

/** Create a sandbox and wait for it to be ready. Returns its id. */
async function boatNew(type: string | undefined): Promise<string> {
	const args = ["new", "--json"];
	if (type) args.push("--type", type);
	let id: string | undefined;
	try {
		const out = await boat(args);
		for (const line of out.split("\n")) {
			if (!line.trim()) continue;
			const ev = JSON.parse(line);
			id ??= ev.id;
			if (ev.event === "ready") return ev.id;
		}
		throw new Error("boat new ended before the sandbox was ready");
	} catch (err) {
		if (id) await boat(["delete", id, "--yes"]).catch(() => undefined);
		throw err;
	}
}

/** Prefer the IPv4 forward: the sandbox's own address is often IPv6-only. */
function endpointOf(info: any): Endpoint {
	if (typeof info.sshEndpoint === "string" && info.sshEndpoint.includes(":")) {
		const i = info.sshEndpoint.lastIndexOf(":");
		return { host: info.sshEndpoint.slice(0, i), port: Number(info.sshEndpoint.slice(i + 1)) };
	}
	if (typeof info.ip === "string" && info.ip) return { host: info.ip, port: 22 };
	throw new Error(`sandbox ${info.id} has no SSH address (state: ${info.state})`);
}

// --- SSH ---

function sshArgs(a: Active): string[] {
	return [
		"-i", KEY,
		"-p", String(a.endpoint.port),
		"-o", "BatchMode=yes",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=15",
		"-o", "ServerAliveInterval=30",
		// Trust on first use, per sandbox: forwarded ports are reused across sandboxes.
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", `UserKnownHostsFile=${path.join(STATE_DIR, `known_hosts-${a.id}`)}`,
		"-o", "ControlMaster=auto",
		"-o", "ControlPath=/tmp/pi-boat-%C",
		"-o", "ControlPersist=600",
		`user@${a.endpoint.host}`,
	];
}

function ssh(a: Active, command: string, opts: SshOptions = {}): Promise<SshResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...sshArgs(a), command], {
			stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		let stderr = "";
		let timedOut = false;
		const timer = opts.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, opts.timeout * 1000)
			: undefined;
		const onAbort = () => child.kill();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout!.on("data", (d: Buffer) => (opts.onData ? opts.onData(d) : out.push(d)));
		child.stderr!.on("data", (d: Buffer) => {
			opts.onData?.(d);
			if (stderr.length < 8192) stderr += d.toString();
		});
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (opts.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
			else resolve({ code, stdout: Buffer.concat(out), stderr });
		});
		if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
	});
}

/** ssh exits 255 for its own failures; only those mean nothing ran remotely. */
function isConnectionFailure(r: SshResult): boolean {
	return (
		r.code === 255 &&
		r.stdout.length === 0 &&
		/^(ssh:|Connection |kex_exchange|mux_client|ControlSocket|Host key verification|Permission denied)/m.test(r.stderr)
	);
}

function closeMaster(a: Active): void {
	spawn("ssh", [...sshArgs(a).slice(0, -1), "-O", "exit", `user@${a.endpoint.host}`], { stdio: "ignore" }).on(
		"error",
		() => undefined,
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("boat", { description: "Run tools inside a boat.dev sandbox", type: "boolean" });
	pi.registerFlag("boat-type", { description: "Boat machine size: small, default, large, xlarge", type: "string" });

	const localCwd = process.cwd();
	let active: Active | null = null;
	let recovering: Promise<boolean> | null = null;
	let lastExtend = 0;

	function requireActive(): Active {
		if (active) return active;
		throw new Error("Boat sandbox is unavailable — nothing was run on your host. Restart pi.");
	}

	/** Push auto-stop back while the session is in use. Fire and forget. */
	function touch(): void {
		if (!active || Date.now() - lastExtend < EXTEND_EVERY_MS) return;
		lastExtend = Date.now();
		void boat(["extend", active.id, "--ttl", String(TTL_SECONDS)]).catch(() => {
			lastExtend = 0;
		});
	}

	/**
	 * Resume the sandbox if it stopped, and pick up its (possibly new) address.
	 * True when something changed, i.e. a retry can reach a different machine.
	 */
	function recover(): Promise<boolean> {
		recovering ??= (async () => {
			const a = requireActive();
			let info = await boatInfo(a.id);
			let changed = false;
			if (STOPPED_STATES.includes(info.state)) {
				await boat(["resume", a.id, "--json"]);
				info = await boatInfo(a.id);
				changed = true;
				lastExtend = Date.now();
			}
			const next = endpointOf(info);
			if (next.host !== a.endpoint.host || next.port !== a.endpoint.port) changed = true;
			a.endpoint = next;
			return changed;
		})().finally(() => {
			recovering = null;
		});
		return recovering;
	}

	async function remote(command: string, opts: SshOptions = {}): Promise<SshResult> {
		const r = await ssh(requireActive(), command, opts);
		if (!isConnectionFailure(r)) return r;
		// Unchanged sandbox: the 255 may be the command's own (e.g. an ssh it ran), so don't run it twice.
		if (!(await recover())) return r;
		return ssh(requireActive(), command, opts);
	}

	async function run(command: string, opts: SshOptions = {}): Promise<Buffer> {
		const r = await remote(command, opts);
		if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
		return r.stdout;
	}

	async function test(expr: string): Promise<boolean> {
		return (await remote(`test ${expr}`)).code === 0;
	}

	// --- operations backing pi's built-in tools ---

	const readOps: ReadOperations = {
		readFile: (p) => run(`cat -- ${q(p)}`),
		access: async (p) => {
			if (!(await test(`-r ${q(p)}`))) throw new Error(`ENOENT: no such file or not readable: ${p}`);
		},
		detectImageMimeType: async (p) => {
			try {
				const m = (await run(`file --mime-type -b -- ${q(p)}`)).toString().trim();
				return IMAGE_TYPES.includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};

	const writeOps: WriteOperations = {
		writeFile: async (p, content) => {
			await run(`cat > ${q(p)}`, { stdin: content });
		},
		mkdir: async (dir) => {
			await run(`mkdir -p -- ${q(dir)}`);
		},
	};

	const editOps: EditOperations = {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: async (p) => {
			if (!(await test(`-r ${q(p)} -a -w ${q(p)}`))) throw new Error(`EACCES: not readable and writable: ${p}`);
		},
	};

	const lsOps: LsOperations = {
		exists: (p) => test(`-e ${q(p)}`),
		stat: async (p) => {
			const kind = (await run(`if [ -d ${q(p)} ]; then echo d; elif [ -e ${q(p)} ]; then echo f; else exit 1; fi`))
				.toString()
				.trim();
			return { isDirectory: () => kind === "d" };
		},
		readdir: async (p) =>
			(await run(`find ${q(p)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`)).toString().split("\0").filter(Boolean),
	};

	const bashOps: BashOperations = {
		// The local env pi passes (PATH etc.) means nothing on the sandbox, so it is not forwarded.
		// Killing ssh on abort or timeout closes the channel; a process that ignores SIGHUP keeps running.
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const r = await remote(`cd ${q(cwd)} && exec bash -lc ${q(command)}`, { onData, signal, timeout });
			return { exitCode: r.code };
		},
	};

	// --- tools ---

	const localTools = {
		bash: createBashToolDefinition(localCwd),
		read: createReadToolDefinition(localCwd),
		write: createWriteToolDefinition(localCwd),
		edit: createEditToolDefinition(localCwd),
		ls: createLsToolDefinition(localCwd),
		find: createFindToolDefinition(localCwd),
		grep: createGrepToolDefinition(localCwd),
	};

	/** With --boat a tool never falls back to the host; without it the extension is inert. */
	function sandboxFor(): Active | null {
		if (active) return active;
		if (pi.getFlag("boat") === true) requireActive();
		return null;
	}

	function sandboxTool<T extends ToolDefinition<any, any, any>>(local: T, makeRemote: (cwd: string) => T): T {
		return {
			...local,
			execute(toolCallId, params, signal, onUpdate, ctx) {
				const a = sandboxFor();
				if (!a) return local.execute(toolCallId, params, signal, onUpdate, ctx);
				touch();
				// Tools resolve paths against ctx.cwd, which is the host directory.
				const sandboxCtx: typeof ctx = Object.create(ctx, { cwd: { value: a.cwd } });
				return makeRemote(a.cwd).execute(toolCallId, params, signal, onUpdate, sandboxCtx);
			},
		};
	}

	// pi's find and grep always spawn fd/ripgrep locally, so these run rg in the sandbox instead.
	function searchResult(stdout: Buffer, stderr: string, limit: number, empty: string, noun: string) {
		const lines = stdout.toString().split("\n").filter(Boolean);
		let text = lines.join("\n") || stderr.trim() || empty;
		if (lines.length >= limit) text += `\n\n[Showing first ${limit} ${noun}. Use limit to see more.]`;
		return { content: [{ type: "text" as const, text }], details: undefined };
	}

	function intParam(value: unknown, fallback: number): number {
		const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
		return Math.max(1, n);
	}

	const findTool: typeof localTools.find = {
		...localTools.find,
		async execute(id, params, signal, onUpdate, ctx) {
			const a = sandboxFor();
			if (!a) return localTools.find.execute(id, params, signal, onUpdate, ctx);
			touch();
			const limit = intParam(params.limit, 1000);
			const r = await remote(
				`cd ${q(a.cwd)} && rg --files --hidden --glob '!.git' --glob ${q(params.pattern)} -- ${q(params.path ?? ".")} | sort | head -n ${limit}`,
				{ signal },
			);
			return searchResult(r.stdout, r.stderr, limit, "No files found matching pattern", "results");
		},
	};

	const grepTool: typeof localTools.grep = {
		...localTools.grep,
		async execute(id, params, signal, onUpdate, ctx) {
			const a = sandboxFor();
			if (!a) return localTools.grep.execute(id, params, signal, onUpdate, ctx);
			touch();
			const limit = intParam(params.limit, 100);
			const rg = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden", "--glob", q("!.git")];
			if (params.ignoreCase) rg.push("--ignore-case");
			if (params.literal) rg.push("--fixed-strings");
			if (typeof params.context === "number" && params.context > 0) rg.push("--context", String(Math.floor(params.context)));
			if (params.glob) rg.push("--glob", q(params.glob));
			rg.push("--", q(params.pattern), q(params.path ?? "."));
			const r = await remote(`cd ${q(a.cwd)} && ${rg.join(" ")} | head -n ${limit}`, { signal });
			return searchResult(r.stdout, r.stderr, limit, "No matches found", "matches");
		},
	};

	const sandboxTools: ToolDefinition<any, any, any>[] = [
		sandboxTool(localTools.bash, (cwd) => createBashToolDefinition(cwd, { operations: bashOps })),
		sandboxTool(localTools.read, (cwd) => createReadToolDefinition(cwd, { operations: readOps })),
		sandboxTool(localTools.write, (cwd) => createWriteToolDefinition(cwd, { operations: writeOps })),
		sandboxTool(localTools.edit, (cwd) => createEditToolDefinition(cwd, { operations: editOps })),
		sandboxTool(localTools.ls, (cwd) => createLsToolDefinition(cwd, { operations: lsOps })),
		findTool,
		grepTool,
	];
	const toolNames = sandboxTools.map((t) => t.name);
	let toolsOwned = false;

	/**
	 * Registered only with --boat, after load: pi refuses to start when two extensions register
	 * the same tool at load time, and @daytona/pi registers these unconditionally. After load
	 * the first extension in load order wins, so check that it is this one.
	 */
	function claimTools(ctx: ExtensionContext): void {
		if (!toolsOwned) for (const tool of sandboxTools) pi.registerTool(tool);
		const self = realpath(fileURLToPath(import.meta.url));
		const owners = new Set(
			pi
				.getAllTools()
				.filter((t) => toolNames.includes(t.name) && realpath(t.sourceInfo.path) !== self)
				.map((t) => t.sourceInfo.path),
		);
		toolsOwned = owners.size === 0;
		if (!toolsOwned) {
			say(
				ctx,
				`Boat: ${[...owners].join(", ")} loads first and owns pi's tools, so tool calls are blocked. ` +
					`List pi-boat before it under "packages" in ~/.pi/agent/settings.json.`,
				"error",
			);
		}
	}

	// Never let --boat fall through to a tool that runs on the host.
	pi.on("tool_call", (event) => {
		if (pi.getFlag("boat") !== true || toolsOwned || !toolNames.includes(event.toolName)) return;
		return { block: true, reason: "Boat sandbox tools are not active — nothing was run on your host. Restart pi." };
	});

	pi.on("user_bash", () => {
		// pi passes the host directory for `!` commands; run them in the sandbox's project instead.
		const a = active;
		if (a) return { operations: { exec: (command, _cwd, opts) => bashOps.exec(command, a.cwd, opts) } };
		if (pi.getFlag("boat") !== true) return;
		return {
			result: {
				output: "Boat sandbox is unavailable — the command was NOT run on your host. Restart pi.",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});

	// --- commands ---

	pi.registerCommand("boat", {
		description: "Show the active boat sandbox",
		handler: async (_args, ctx) => {
			if (!active) {
				say(ctx, "No boat sandbox is active. Launch pi with --boat.", "warning");
				return;
			}
			const lines = [`☁ ${active.id} · ${active.cwd}`];
			try {
				const info = await boatInfo(active.id);
				lines.push(`state: ${info.state} · ${info.type ?? ""} · auto-stop ${info.archiveAfter ?? "off"}`);
			} catch (err) {
				lines.push(`state: unknown (${errorMessage(err)})`);
			}
			lines.push(`shell: boat ssh -t ${active.id} -- bash -lc 'cd ${active.cwd} && exec bash'`);
			say(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerCommand("boat-pull", {
		description: "Apply the sandbox's changes to your local copy",
		handler: async (_args, ctx) => {
			if (!active) {
				say(ctx, "No boat sandbox is active. Launch pi with --boat.", "warning");
				return;
			}
			const cwd = q(active.cwd);
			try {
				const names = (await run(`cd ${cwd} && git add -A && git diff --cached --name-only boat-base`))
					.toString()
					.split("\n")
					.filter(Boolean);
				if (names.length === 0) {
					say(ctx, "Nothing to pull: the sandbox matches what you last pulled.", "info");
					return;
				}
				if (ctx.hasUI) {
					const shown = names.slice(0, 20).join("\n") + (names.length > 20 ? `\n… and ${names.length - 20} more` : "");
					const ok = await ctx.ui.confirm("Pull from sandbox", `Apply ${names.length} changed file(s) to ${localCwd}?\n\n${shown}`);
					if (!ok) return;
				}
				const patch = await run(`cd ${cwd} && git diff --cached --binary boat-base`);
				await applyLocally(patch);
				// Move the base so the next pull only brings what changed after this one.
				await run(
					`cd ${cwd} && git tag -f boat-base "$(git -c user.name=pi -c user.email=pi@boat ` +
						`commit-tree "$(git write-tree)" -p boat-base -m 'boat: pulled')" >/dev/null`,
				);
				say(ctx, `Pulled ${names.length} file(s) into ${localCwd}.`, "info");
			} catch (err) {
				say(ctx, `boat-pull: ${errorMessage(err)}`, "error");
			}
		},
	});

	/** `git apply` is atomic: on any conflict nothing is written. */
	async function applyLocally(patch: Buffer): Promise<void> {
		const top = await gitLocal(["rev-parse", "--show-toplevel"]).catch(() => null);
		const args = ["apply", "--whitespace=nowarn"];
		if (top) {
			const prefix = path.relative(top, localCwd);
			if (prefix) args.push(`--directory=${prefix.split(path.sep).join("/")}`);
		}
		await gitLocal([...args, "-"], top ?? localCwd, patch);
	}

	function gitLocal(args: string[], cwd = localCwd, stdin?: Buffer): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn("git", args, { cwd, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			child.stdout!.on("data", (d) => (out += d));
			child.stderr!.on("data", (d) => (err += d));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `git exit ${code}`))));
			if (stdin) child.stdin!.end(stdin);
		});
	}

	// --- lifecycle ---

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		ctx.ui.setStatus("boat", text === undefined ? undefined : ctx.ui.theme.fg("accent", text));
	}

	function latestEntry(ctx: ExtensionContext): EntryData | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === SESSION_ENTRY) return e.data as EntryData;
		}
		return undefined;
	}

	function record(ctx: ExtensionContext): void {
		if (active && ctx.sessionManager.getSessionFile() !== undefined) {
			pi.appendEntry<EntryData>(SESSION_ENTRY, { id: active.id, cwd: active.cwd });
		}
	}

	/** Make sure our key is authorized; `boat ssh` installs it if it is not. */
	async function authorize(a: Active): Promise<void> {
		if ((await ssh(a, "true")).code === 0) return;
		await boat(["ssh", a.id, "true"]);
		const r = await ssh(a, "true");
		if (r.code !== 0) throw new Error(`SSH to ${a.id} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
	}

	/** Reattach a recorded sandbox. Returns false only if boat no longer has it. */
	async function reattach(prev: EntryData, ctx: ExtensionContext): Promise<boolean> {
		let info: any;
		try {
			info = await boatInfo(prev.id);
		} catch (err) {
			if (/not.?found|404|no such/i.test(errorMessage(err))) return false;
			throw err;
		}
		if (DEAD_STATES.includes(info.state)) return false;
		if (STOPPED_STATES.includes(info.state)) {
			setStatus(ctx, `☁ boat · resuming ${prev.id}…`);
			await boat(["resume", prev.id, "--json"]);
			info = await boatInfo(prev.id);
		}
		const a: Active = { id: prev.id, cwd: prev.cwd, endpoint: endpointOf(info) };
		await authorize(a);
		active = a;
		return true;
	}

	async function create(ctx: ExtensionContext): Promise<void> {
		const type = pi.getFlag("boat-type");
		// Outside a git repo `boat push` sends every file (node_modules and all), so copy nothing.
		const inRepo = (await gitLocal(["rev-parse", "--is-inside-work-tree"]).catch(() => "")) === "true";
		const id = await boatNew(typeof type === "string" && type ? type : undefined);
		try {
			const cwd = inRepo ? path.posix.join(REMOTE_HOME, path.basename(localCwd)) : `${REMOTE_HOME}/workspace`;
			const a: Active = { id, cwd, endpoint: endpointOf(await boatInfo(id)) };
			await authorize(a);
			if (inRepo) {
				setStatus(ctx, `☁ boat · ${id} · copying ${path.basename(localCwd)}…`);
				await boat(["push", id, localCwd, "--to", cwd]);
			} else {
				await ssh(a, `mkdir -p ${q(cwd)}`);
				say(ctx, `${localCwd} is not a git repository, so nothing was copied. The agent starts in an empty ${cwd}.`, "warning");
			}
			const base = await ssh(
				a,
				`cd ${q(cwd)} && git init -q && git add -A && ` +
					`git -c user.name=pi -c user.email=pi@boat commit -q --allow-empty -m 'boat: base' && git tag boat-base`,
			);
			if (base.code !== 0) throw new Error(`git setup failed: ${base.stderr.trim()}`);
			active = a;
		} catch (err) {
			await boat(["delete", id, "--yes"]).catch(() => undefined);
			throw err;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("boat") !== true) return;
		claimTools(ctx);
		if (!toolsOwned) return;
		mkdirSync(STATE_DIR, { recursive: true });
		const prev = latestEntry(ctx);

		// /new and /fork keep working in the same sandbox.
		if (active && (!prev || prev.id === active.id)) {
			if (!prev) record(ctx);
			return;
		}
		// Resumed a session that has its own sandbox: let the current one stop.
		if (active) {
			const old = active;
			active = null;
			closeMaster(old);
			void boat(["stop", old.id]).catch(() => undefined);
		}

		const startedAt = Date.now();
		try {
			if (prev) {
				setStatus(ctx, `☁ boat · reattaching ${prev.id}…`);
				if (await reattach(prev, ctx)) {
					say(ctx, `Reattached boat sandbox ${prev.id}`, "info");
					setStatus(ctx, `☁ boat · ${prev.id} · ${prev.cwd}`);
					return;
				}
				say(ctx, `Boat sandbox ${prev.id} is gone; starting a new one.`, "warning");
			}
			setStatus(ctx, "☁ boat · starting sandbox…");
			await create(ctx);
			record(ctx);
			const a = requireActive();
			const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
			say(ctx, `Boat sandbox ready · ${a.id} · ${a.cwd} · ${secs}s`, "info");
			setStatus(ctx, `☁ boat · ${a.id} · ${a.cwd}`);
			void boat(["data-retention", "status", "--json"])
				.then((out) => {
					if (lastJson(out).enabled !== true) return;
					say(ctx, "This boat account deletes a sandbox when it stops: /boat-pull before it does.", "warning");
				})
				.catch(() => undefined);
		} catch (err) {
			active = null;
			setStatus(ctx, undefined);
			say(ctx, `Boat: could not start a sandbox — ${errorMessage(err)}`, "error");
		}
	});

	pi.on("agent_start", () => touch());

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		const where = `${active.cwd} (boat sandbox ${active.id})`;
		const systemPrompt =
			event.systemPrompt
				.replace(/Current working directory: .*/g, `Current working directory: ${where}`)
				.replace(/<cwd>\n.*\n<\/cwd>/g, `<cwd>\n${where}\n</cwd>`) +
			"\n\nYour tools run inside a boat.dev sandbox (Ubuntu 24.04, user `user`). The project was copied " +
			"from the user's machine without its git history. Leave your changes in the working tree: the " +
			"user brings them back with /boat-pull. Committing is fine; do not push.";
		return { systemPrompt };
	});

	/** Files changed in the sandbox since the last /boat-pull, or -1 if that can't be checked. */
	async function unpulledCount(a: Active): Promise<number> {
		const r = await ssh(a, `cd ${q(a.cwd)} && git add -A && git diff --cached --name-only boat-base | wc -l`).catch(() => null);
		const n = r?.code === 0 ? Number(r.stdout.toString().trim()) : NaN;
		return Number.isFinite(n) ? n : -1;
	}

	pi.on("session_shutdown", async (event, ctx) => {
		// new/resume/fork stay in this process (see session_start); reload re-instantiates and reattaches.
		if (!active || event.reason !== "quit") return;
		const a = active;
		active = null;
		setStatus(ctx, undefined);
		// On accounts with delete-on-stop, stopping erases the disk, so never stop with work in it.
		// The TUI is already gone here, so this goes straight to the terminal.
		const unpulled = await unpulledCount(a);
		if (unpulled !== 0) {
			const what = unpulled > 0 ? `${unpulled} changed file(s) you haven't pulled` : "changes that could not be checked";
			console.error(
				`[boat] ${a.id} has ${what}, so it was left on. It auto-stops within an hour.\n` +
					`[boat] To bring them back: pi --boat -c, then /boat-pull`,
			);
			return;
		}
		closeMaster(a);
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		await boat(persisted ? ["stop", a.id] : ["delete", a.id, "--yes"]).catch(() => undefined);
	});
}
