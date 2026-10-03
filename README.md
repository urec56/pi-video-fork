# pi-video-fork

Read local videos with pi's built-in `read` tool. Fork of the [apetersson/pi-video](https://github.com/apetersson/pi-video) core, stripped for a known-good OpenAI-compatible endpoint: no ffmpeg, no capability discovery, no `input_video` format.

The built-in `read` tool is overridden: non-video paths keep the stock behavior, video paths attach the raw file as a native `video_url` (base64 data URI) to the next model request. The model keeps its default "call read" instinct — there is no new tool to learn.

## Install

```bash
pi install git:github.com/urec56/pi-video-fork
```

Then `/reload` in a running session.

## Usage

Just ask the model: "read /path/to/video.mp4" or send the path — it calls `read`, and the video is attached to the next request as native video input.

Commands:
- `/video` — list videos attached in this conversation

## How it works

Video bytes never enter the session:

1. `read(video)` stores `{path, size, sha256}` in the tool result `details`.
2. The `context` event tags a **clone** of that tool result with a temporary marker `[pi-video-ref:<key>]` — the session JSONL stays clean.
3. `before_provider_request` appends a synthetic user message with the `video_url` data URI after each marker-bearing tool-result group, and strips the markers from the payload.

The file is re-validated by SHA256 at send time; a changed or missing file yields an explicit "video omitted" note instead of stale bytes. A deterministic `input` hook also nudges the model to `read` a video before describing it when the user message mentions a video file.

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `PI_OPENAI_VIDEO_MAX_MB` | `64` | per-file size cap for video reads |

Recognized extensions: mp4, m4v, mov, webm, mkv, avi (MIME guessed from extension, `video/mp4` fallback).

## Limitations

- Every video read in the current branch is re-attached (as a data URI) on each request until the branch changes — traffic grows with the videos.
- Only OpenAI chat-completions payloads are rewritten (detected via `messages` + `role: "tool"`); other API families get the omission note instead.
- Video decoding is done by the endpoint; unsupported codecs come back as provider errors.
- No audio: the extension supplies visual content only.

## Credit

Core architecture (read override, `details` refs, context markers, payload rewrite, SHA256 re-validation, omission semantics) from [apetersson/pi-video](https://github.com/apetersson/pi-video) (MIT).

## License

[MIT](./LICENSE)
