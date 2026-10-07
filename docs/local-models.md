# Local models alongside APIs

Aigora is a client of model servers. It does not ship Ollama, model weights, a Whisper HTTP server, or an NPU/OpenVINO server. You can run local chat and speech services alongside API agents; choosing local chat does not silently replace file tools, speech or routing.

## Feature choices

| Feature | API option | Local option and limits |
| --- | --- | --- |
| Conversation / drafting | Claude or Codex API agents; remote OpenAI-compatible chat | Ollama, llama.cpp, LM Studio, vLLM or an external OpenVINO HTTP server via `providers.local`; primary adapter sends text, no tool loop |
| Coding and filesystem tools | Claude/Codex agents with API leases and configured containment | A `models.code` choice is still chat-only on the primary adapter; a separately configured compatible endpoint worker may perform file work if explicitly enabled and its protocol supports it |
| Research / result verification | API agent steps or compatible remote verifiers | Extra-endpoint models, `researchModel`, `verifiers`, `verifyMode: single` or `cross`; available model/protocol matters |
| Session titles | Session agent's API model | `providers.local.titleModel`, optionally `endpoint-id/model-id` |
| Audio speech to text | OpenAI-compatible `/audio/transcriptions`, e.g. OpenAI `whisper-1` with its own key | Separately hosted Whisper-compatible multipart service; installing Whisper CLI alone does not create an HTTP endpoint |
| Video/lecture transcription | Same speech API after local audio extraction | Same local Whisper service; ffmpeg/ffprobe and resource limiter run on the Aigora host |
| Video emphasis refinement | AI agents can interpret the transcript afterwards; remote refinement is disabled in the video pipeline | Loopback `/chat/completions` at the transcription base URL, e.g. Qwen3; otherwise heuristic scores remain |
| Video/frame understanding | A supported API agent can use supplied frame/transcript context | Frame selection/thumbnails are local; primary local text chat is not a vision tool. External vision integration must support the required image contract |
| Clef/JEV routing | Cloudflare Workers AI / TypeSafe System One | Compatible `/v1/systemone` decision service; arbitrary Qwen3 chat completions do not implement this automatically |
| Office editing | No model required; agents can generate files | Separate ONLYOFFICE Document Server, same for API and local chat deployments |

## Ollama and Qwen3

Install Ollama separately using its official instructions, then run:

```sh
ollama serve
# In another terminal:
ollama pull qwen3:8b
```

Ollama exposes an [OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility). Merge this into `console/daemon.json` under your state home:

```json
{
  "providers": {
    "local": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:11434/v1",
      "server": "ollama",
      "apiKey": "",
      "models": { "chat": "qwen3:8b", "code": "qwen3:8b", "manual": [] },
      "contextTokens": 4096,
      "maxTokens": 1024,
      "thinking": false,
      "idleTimeoutMs": 120000
    }
  }
}
```

Use the administrator's Routing/local-model settings to probe and select installed models. `local-model/overrides.json` overlays daemon config when changed in the UI. Model names must match the server's `/models` response/allowlist. Cold starts and insufficient RAM can cause idle/timeouts; choose a model size your machine can support. Qwen3 variants/weights have their own licenses; check the specific model card, not just the runtime license.

## Extra compatible endpoints

`providers.local.endpoints` accepts up to eight entries with `id`, `label`, `baseUrl`, optional `apiKey`, `server`, aliases and capability flags. Models are selected as `id/model`; discovery must have listed that model. Example:

```json
{
  "id": "secondary",
  "label": "Secondary model server",
  "baseUrl": "http://127.0.0.1:8001/v1",
  "apiKey": "",
  "server": "vllm",
  "aliases": ["second"],
  "pickable": true,
  "privateAllowed": true,
  "canWork": false
}
```

A remote compatible API uses the same fields with an HTTPS URL and a provider key. `canWork` is a capability declaration, not a proof of containment or tool support. Room endpoint workers are off unless `roomExecution.endpoints: true`; keep chat-only endpoints at `canWork: false`. `researchModel`, `titleModel` and `verifiers` are fields of `providers.local`, not fields of an endpoint.

## External NPU/OpenVINO service

No optional server script is included in this repository. Install a suitable runtime/server separately in a generic directory such as `./model-server`, keep weights in `./models`, and follow that project's hardware/driver/model conversion instructions. Point an endpoint at its HTTP `/v1` URL only if it implements `/models` and streaming `/chat/completions`. An NPU model file or OpenVINO installation alone is insufficient. Aigora does not promise NPU acceleration or automatic CPU/NPU fallback.

[OpenVINO](https://github.com/openvinotoolkit/openvino) is Apache-2.0; any selected server, adapter and weights have separate terms. Keep its listener private and protect access when binding beyond loopback.

## Speech and video

For an external Whisper-compatible HTTP service listening on port 8000, merge:

```json
{
  "transcription": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8000/v1",
    "apiKey": "",
    "model": "whisper-1",
    "language": "en",
    "maxBytes": 104857600,
    "videoEnabled": true,
    "videoLlm": false,
    "videoLlmModel": "qwen3:8b",
    "videoTopK": 12,
    "videoMaxMinutes": 180,
    "videoVisual": false
  }
}
```

Use the model ID accepted by your speech server. It must accept multipart `file`, `model`, `response_format=verbose_json` and optional `language`, and return JSON with `text` and preferably timestamped `segments`. [Whisper](https://github.com/openai/whisper) is MIT-licensed; server wrappers have their own licenses. There is no mandated wrapper in this tree.

For the API alternative, change `baseUrl` to `https://api.openai.com/v1`, set `apiKey` to that service's key, and use `whisper-1`; see [API setup](setup-api.md). Speech credentials are separate from agent keys.

Video processing uses the host's `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` plus working resource limits (`systemd-run` or `prlimit`). Enable `videoLlm` only if the **same loopback base URL** also serves the chosen Qwen3 chat model; separate Ollama/speech ports are not automatically connected. The source default `videoLlmModel` is `qwen3-8b-npu`, a configurable ID, not a bundled model. Remote URLs skip LLM refinement. `videoVisual: true` enables experimental pen/laser scoring; frames are samples and can miss important content.

Check transcription accuracy against the recording. Obtain appropriate consent before processing meetings or teaching materials; transcripts, speakers and emphasis scores can be wrong. The chosen endpoint receives the audio. See [Privacy](../PRIVACY.md).
