/**
 * pi-video-fork — read local videos with the built-in `read` tool.
 *
 * Fork of the apetersson/pi-video core, stripped for a known-good
 * OpenAI-compatible endpoint: no ffmpeg normalization, no capability
 * discovery, no input_video format. The built-in read tool is overridden:
 * non-video paths keep the stock behavior; video paths attach the raw file
 * as a native video_url (base64 data URI) to the next model request.
 *
 * Video bytes never enter the session:
 *   1. read(video) stores {path, size, sha256} in the tool result `details`.
 *   2. The `context` event tags a clone of that tool result with a
 *      temporary marker [pi-video-ref:<key>] (the session stays clean).
 *   3. `before_provider_request` appends a synthetic user message with the
 *      video_url data URI after each marker-bearing tool-result group.
 *
 * The file is re-validated by SHA256 at send time; a changed or missing
 * file yields an explicit omission note instead of stale bytes.
 *
 * Env: PI_OPENAI_VIDEO_MAX_MB — per-file cap in MiB (default 64)
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = Math.max(1, Number(process.env.PI_OPENAI_VIDEO_MAX_MB ?? 64)) * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
};

const isVideo = (p: string) => MIME_BY_EXT[extname(p).toLowerCase()] !== undefined;
const mimeOf = (p: string) => MIME_BY_EXT[extname(p).toLowerCase()] ?? "video/mp4";
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const MARKER_RE = /\[pi-video-ref:([a-f0-9]{64})\]/g;
const VIDEO_MENTION_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi)\b/i;

function fmtSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
	return `${bytes} B`;
}

function expandPath(p: string, cwd: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return isAbsolute(p) ? p : resolve(cwd, p);
}

interface VideoRef {
	version: 1;
	path: string;
	size: number;
	sha256: string;
}

/** Walk all string values of a payload and apply a transform. */
function mapText(value: any, transform: (s: string) => string): any {
	if (typeof value === "string") return transform(value);
	if (Array.isArray(value)) {
		const mapped = value.map((item) => mapText(item, transform));
		return mapped.some((item, index) => item !== value[index]) ? mapped : value;
	}
	if (value && typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) return value;
		const entries = Object.entries(value).map(([key, item]) => [key, mapText(item, transform)]);
		return entries.some(([key, item]) => item !== value[key]) ? Object.fromEntries(entries) : value;
	}
	return value;
}

const cleanMarkers = (payload: any) => mapText(payload, (text) => text.replace(MARKER_RE, ""));

function referenceForTool(message: any, refs: Map<string, VideoRef>): VideoRef | undefined {
	const content = message?.content;
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((b: any) => b && b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
			: "";
	for (const m of text.matchAll(MARKER_RE)) {
		const ref = refs.get(m[1]);
		if (ref) return ref;
	}
	return undefined;
}

async function loadVideo(ref: VideoRef): Promise<Buffer> {
	const st = await stat(ref.path);
	if (st.size !== ref.size) throw new Error("video changed since read; read it again");
	const bytes = await readFile(ref.path);
	if (sha256(bytes) !== ref.sha256) throw new Error("video changed since read; read it again");
	return bytes;
}

/** Insert video_url parts after each marker-bearing tool-result group. */
async function rewrite(payload: any, refs: Map<string, VideoRef>): Promise<any> {
	if (!Array.isArray(payload?.messages)) return cleanMarkers(payload);
	const messages: any[] = [];
	for (let i = 0; i < payload.messages.length; i++) {
		const m = payload.messages[i];
		messages.push(m);
		if (m.role !== "tool") continue;
		const group = [m];
		while (payload.messages[i + 1]?.role === "tool") {
			group.push(payload.messages[++i]);
			messages.push(payload.messages[i]);
		}
		const content: any[] = [];
		const seen = new Set<string>();
		for (const t of group) {
			const ref = referenceForTool(t, refs);
			if (!ref || seen.has(ref.sha256)) continue;
			seen.add(ref.sha256);
			const bytes = await loadVideo(ref);
			const mime = mimeOf(ref.path);
			content.push({ type: "text", text: `Video read from ${ref.path} (${fmtSize(bytes.length)}, ${mime}).` });
			content.push({ type: "video_url", video_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
		}
		if (content.length) messages.push({ role: "user", content });
	}
	return cleanMarkers({ ...payload, messages });
}

export default function (pi: ExtensionAPI) {
	const base = createReadToolDefinition(process.cwd());
	let refs = new Map<string, VideoRef>();

	// Override the built-in read: stock behavior for non-videos, video
	// pipeline for video files. The model keeps its default "call read"
	// instinct — no new tool to learn.
	pi.registerTool({
		...base,
		description:
			base.description +
			" Also reads local video files (mp4, m4v, mov, webm, mkv, avi): the video is attached to the next model request as native video input. This is the only way to view video files.",
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			"Use read on video files too (mp4, mov, webm, mkv, avi) — it attaches the video to the conversation; never extract frames with bash for that.",
			"Never describe or analyze a video you have not read. If the user sends a new video path, always read it first — even if it looks similar to a previously read video.",
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const p = params as { path: string; offset?: number; limit?: number };
			const cwd = ctx?.cwd ?? process.cwd();
			if (!isVideo(p.path)) {
				return createReadToolDefinition(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
			}
			if (p.offset !== undefined || p.limit !== undefined) {
				throw new Error("Line offset/limit do not apply to video files.");
			}
			const abs = expandPath(p.path, cwd);
			const st = await stat(abs);
			if (!st.isFile()) throw new Error(`not a file: ${abs}`);
			if (st.size > MAX_BYTES) {
				throw new Error(`video too large: ${fmtSize(st.size)} (cap ${fmtSize(MAX_BYTES)}, raise with PI_OPENAI_VIDEO_MAX_MB)`);
			}
			const bytes = await readFile(abs, { signal });
			const ref: VideoRef = { version: 1, path: abs, size: bytes.length, sha256: sha256(bytes) };
			return {
				content: [{
					type: "text" as const,
					text: `Read video ${abs} (${fmtSize(bytes.length)}, ${mimeOf(abs)}). Native video will be attached to the next model request.`,
				}],
				details: { piVideo: ref },
			};
		},
	});

	// Tag a clone of the context with temporary markers; the session itself
	// never stores markers or bytes.
	pi.on("context", (event) => {
		const next = new Map<string, VideoRef>();
		const tagged = event.messages.map((message: any) => {
			const ref = message.details?.piVideo;
			if (message.role !== "toolResult" || message.toolName !== "read" || message.isError || ref?.version !== 1) return message;
			const key = sha256(Buffer.from(JSON.stringify([message.toolCallId, ref.path, ref.sha256])));
			next.set(key, ref);
			return { ...message, content: [...(message.content ?? []), { type: "text", text: `[pi-video-ref:${key}]` }] };
		});
		refs = next;
		return { messages: tagged };
	});

	pi.on("before_provider_request", async (event) => {
		if (!refs.size) return cleanMarkers(event.payload);
		try {
			return await rewrite(event.payload, refs);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return mapText(event.payload, (text: string) => {
				for (const m of text.matchAll(MARKER_RE)) {
					if (refs.has(m[1])) return `Previously read video omitted: ${reason}. Read the file again.`;
				}
				return text.replace(MARKER_RE, "");
			});
		}
	});

	// Deterministic nudge: user mentions a video file -> instruct to read it
	// before answering (without this the model sometimes describes a new
	// video "from pattern" instead of reading it).
	pi.on("input", (event) => {
		if (typeof event.text === "string" && VIDEO_MENTION_RE.test(event.text)) {
			return {
				action: "transform",
				text: event.text +
					"\n\n[pi-video-fork] The user message references a video file. " +
					"Call read with the exact path from the user's message before describing or analyzing it. " +
					"Never describe a video you have not read.",
			};
		}
	});

	pi.registerCommand("video", {
		description: "pi-video-fork: list videos attached in this conversation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (refs.size === 0) {
				ctx.ui.notify("pi-video-fork: no videos read in this conversation", "info");
				return;
			}
			for (const v of refs.values()) ctx.ui.notify(`${v.path} (${fmtSize(v.size)})`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		refs.clear();
	});
}
