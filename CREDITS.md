# Credits and provenance

Maintainer: **Aigora contributors**.

## 1. Code in this product (license notice required)

### Forked code and retained adaptations

| Project | Relationship | License / evidence |
| --- | --- | --- |
| [Clagentic Console](https://github.com/clagentic/clagentic-console) | Direct fork; upstream base recorded in FORK_NOTICE | MIT; upstream copyright and full text retained in [LICENSE](LICENSE) |
| [Clay](https://github.com/chadbyte/clay) | Inherited through the direct fork | MIT; Clay copyright retained in LICENSE |
| [marked](https://github.com/markedjs/marked) 14.1.4 | Vendored browser parser, `lib/public/marked.min.js` | MIT; copyright header retained, full notice in THIRD-PARTY-NOTICES |
| [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko) v1.0.1 | Vendored and adapted in the private development repository for Korean observable-work/thinking presentation; adapted disclosure wording and provider-visible trace handling remain in this public tree | MIT; upstream commit `9b293089cf98115a6c8f1b4b1d9a23e08732c38d`; [upstream LICENSE](third_party/omp-thinking-ko/LICENSE) and [adaptation record](third_party/omp-thinking-ko/README-AIGORA.md) retained |

The public UI retains the adaptation's Korean educational-work disclosure and provider-visible trace boundary (`lib/public/aigora/i18n/ko/agoraRender.js`, `lib/public/modules/agora-model.js` and `agora-render.js`). The standalone OMP host extension and its model translation prompts are not shipped or executed by this build. The retained wording still requires attribution; removal of the host source did not remove the entire adaptation. See [FORK_NOTICE.md](FORK_NOTICE.md) for fresh-history attribution.

### npm dependencies

The complete production/transitive list, platform packages, copyright notices and collected license texts are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated from the lockfile and installed package notices. Direct dependencies in this tree:

| Dependency | License |
| --- | --- |
| `@anthropic-ai/claude-agent-sdk` | Anthropic commercial/proprietary terms; installed by npm, not Aigora MIT |
| `@anthropic-ai/sdk` | MIT |
| `@lydell/node-pty` | MIT |
| `@openai/codex` | Apache-2.0 |
| `nodemailer` | MIT-0 |
| `qrcode-terminal` | Apache-2.0 plus embedded QR generator MIT notice |
| `web-push` | MPL-2.0 |
| `ws` | MIT |

Installing a runtime does not grant rights to provider service access or model weights. Preserve dependency NOTICE files when redistributing packages; do not copy `node_modules` into this repository.

### Browser libraries, icons and fonts

| Resource | License |
| --- | --- |
| DOMPurify | Apache-2.0 OR MPL-2.0 |
| highlight.js | BSD-3-Clause |
| Lucide icons | ISC |
| Twemoji JavaScript / graphics | MIT / CC-BY-4.0; graphics attribution to Twitter and contributors |
| twemoji-colr-font | MIT code / CC-BY-4.0 graphics |
| Mermaid | MIT |
| qrcode-generator | MIT |
| xterm.js and fit/web-links/WebGL addons | MIT |
| material-file-icons / material-icon-theme folder icons | MIT |
| Pretendard, DM Sans, DM Mono, Nunito, IBM Plex Sans KR, Gowun Batang | SIL OFL 1.1 |
| Roboto Mono | Apache-2.0 (recorded upstream font notice) |

Versions, source URLs and loaded CDN paths are listed in THIRD-PARTY-NOTICES. These browser downloads are not vendored npm dependencies. See [Twemoji source/attribution](https://github.com/twitter/twemoji) and [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).

The thirteen shipped file icons and avatars are original neutral artwork by Aigora contributors (MIT), reproducible from `scripts/generate-neutral-icons.py`; see [per-file provenance and hashes](docs/asset-provenance.md). Prior raster artwork was replaced because its input provenance could not be established. Hand-written decorative SVGs and named-theme palette data still require separate provenance review; the repository license alone does not establish third-party asset permissions.

The console references named palettes (Ayu, Catppuccin, Dracula, Everforest, GitHub, Gruvbox, Monokai, Nord, One Dark/Light, Rosé Pine, Solarized, Tokyo Night). These names identify presets; source notices for the particular JSON palette values are missing. Aigora's MIT license does not establish those upstream projects' asset provenance.

## 2. Projects referenced or evaluated (no code copied)

| Project | Purpose / public-build status | License / evidence |
| --- | --- | --- |
| [Nhahan/WebGPT](https://github.com/Nhahan/WebGPT) | Earlier external runtime integration, removed in 0.1.0; no source was ever copied; not used in the public build | MIT; [upstream LICENSE](https://github.com/Nhahan/WebGPT/blob/main/LICENSE); historical credit restored from the private development record |
| [bangak684/WWG](https://github.com/bangak684/WWG) | Evaluated as a replacement for the earlier browser runtime; no code copied and not used in the public build | MIT; [upstream LICENSE listing](https://github.com/bangak684/WWG) |
| [tribgames/mixdog](https://github.com/tribgames/mixdog) | Owner considered forking features on 2026-10-02; history and distinctive-identifier checks found no ported code in the public tree | Apache-2.0; [upstream package metadata](https://github.com/tribgames/mixdog/blob/main/package.json) |

### Optional external tools and referenced services

| Project/service | Role | License / terms |
| --- | --- | --- |
| [bubblewrap](https://github.com/containers/bubblewrap) | Containment executable | LGPL-2.0-or-later; external executable |
| [systemd](https://github.com/systemd/systemd) | Resource scopes | Predominantly LGPL-2.1-or-later; component-specific terms apply |
| [Python](https://www.python.org/) | Sandbox/helper runtime | PSF license terms |
| [FFmpeg](https://ffmpeg.org/legal.html) / ffprobe | Video decoding/extraction | LGPL-2.1-or-later base; GPL/nonfree build options change redistribution terms |
| [util-linux](https://github.com/util-linux/util-linux) | `prlimit` fallback | Component-specific GPL/LGPL/BSD terms; verify installed executable |
| [ONLYOFFICE DocumentServer](https://github.com/ONLYOFFICE/DocumentServer) | External Office co-editing | AGPL-3.0 community source, separate commercial editions/terms |
| [Ollama](https://github.com/ollama/ollama) | External compatible model server | MIT runtime; model weights separate |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | Compatible server option | MIT; weights separate |
| [vLLM](https://github.com/vllm-project/vllm) | Compatible server option | Apache-2.0; weights separate |
| [LM Studio](https://lmstudio.ai/) | Compatible server option | Product-specific proprietary terms; not bundled |
| [OpenVINO](https://github.com/openvinotoolkit/openvino) | External NPU/runtime option | Apache-2.0; no server is shipped here |
| [Qwen3](https://github.com/QwenLM/Qwen3) | Example model family | Check exact model/weight card; family membership alone does not establish the chosen weights' license |
| [Whisper](https://github.com/openai/whisper) | External speech model option | MIT; HTTP wrapper separately licensed |
| [mkcert](https://github.com/FiloSottile/mkcert) | Optional local TLS | BSD-3-Clause |
| [Docker/Moby](https://github.com/moby/moby) | Optional Office container runtime | Apache-2.0 engine; Desktop is separately licensed |
| [Git](https://git-scm.com/) | Project/worktree/skill operations | GPL-2.0 |
| Caddy / nginx | Suggested external TLS proxies | Apache-2.0 / BSD-2-Clause respectively; not bundled |
| Anthropic / OpenAI APIs | Agent execution, optional speech | Provider service terms, billed separately |
| Cloudflare Workers AI / TypeSafe System One (JEV) | Optional routing | Provider service terms; no hosted-service source copied |

External tools and service examples are not forked code or bundled model servers. Provider names are used to identify integrations; trademark rights are separate from software licenses. Unknown asset provenance is listed explicitly in section 1; verification limits belong in the release record.

## 3. Development tools and practices (not shipped)

These tools supported development and release review. Their source, skill packages and scanner engines are not bundled by this public export. Upstream license links were checked for this attribution review; they do not establish the license of an unrecorded historical installation. A tool credit does not assert that its scanner ran in this checkout.

| Tool / project | Purpose | License / evidence |
| --- | --- | --- |
| [Claude Code (Anthropic)](https://github.com/anthropics/claude-code) | Planning, integration and development verification | Anthropic commercial terms; [upstream license statement](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) |
| [OpenAI Codex](https://github.com/openai/codex) | Bounded implementation and review in worktrees | Apache-2.0 CLI; [upstream LICENSE](https://github.com/openai/codex/blob/main/LICENSE); hosted services have separate terms |
| [Google Antigravity (Gemini)](https://antigravity.google/) | Independent static review during development | license not verified; provider product/service terms apply |
| [GitHub Copilot](https://github.com/features/copilot) | Independent coding and static-review assistance | license not verified; provider product/service terms apply |
| [JinHo-von-Choi/iron-laws](https://github.com/JinHo-von-Choi/iron-laws) | Static “iron laws” rule set used in development CI and release checks; review references and suppression IDs remain, but no upstream rule files, checker code or configuration is shipped | MIT; [upstream LICENSE](https://github.com/JinHo-von-Choi/iron-laws/blob/main/LICENSE); the public CI workflow does not invoke the checker |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | Coding guidelines for restrained changes, explicit assumptions and verification | MIT stated in [upstream README](https://github.com/multica-ai/andrej-karpathy-skills#license) |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | UI/UX design guidance and review skills | MIT; [upstream LICENSE](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/LICENSE) |
| [ryanthedev/design-for-ai](https://github.com/ryanthedev/design-for-ai) | Visual design guidance for typography, color and composition | MIT stated in [upstream README](https://github.com/ryanthedev/design-for-ai#license) |
| [chrismccoy/claude-design-styles](https://github.com/chrismccoy/claude-design-styles) | Design style references for UI work | license not verified; no license declaration found in the checked upstream page |
| [obra/superpowers](https://github.com/obra/superpowers) | Planning, debugging, test-first work and verification skills | MIT; [upstream LICENSE](https://github.com/obra/superpowers/blob/main/LICENSE) |
| [Serena (oraios/serena)](https://github.com/oraios/serena) | Code navigation and semantic inspection during development; local project metadata excluded from export | Current upstream application GPL-3.0-or-later, SolidLSP MIT; [licensing overview](https://github.com/oraios/serena/blob/main/LICENSE); historical installation license not verified |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Release-gate secret scanning | MIT; [upstream LICENSE](https://github.com/gitleaks/gitleaks/blob/master/LICENSE) |
| [semgrep](https://github.com/semgrep/semgrep) | Release-gate static security scanning | LGPL-2.1 core; [upstream LICENSE](https://github.com/semgrep/semgrep/blob/develop/LICENSE); rule packs and commercial components have separate terms |
| [osv-scanner](https://github.com/google/osv-scanner) | Release-gate dependency vulnerability scanning | Apache-2.0; [upstream LICENSE](https://github.com/google/osv-scanner/blob/main/LICENSE) |
| [ScanCode Toolkit](https://github.com/aboutcode-org/scancode-toolkit) | Release-gate license and provenance scanning | Apache-2.0 software / CC-BY-4.0 data; [upstream NOTICE](https://github.com/aboutcode-org/scancode-toolkit/blob/develop/NOTICE); embedded components retain separate licenses |

## 4. License and terms compliance measures

- Upstream MIT notices for Clay and Clagentic Console remain in [LICENSE](LICENSE); the retained Korean presentation adaptation carries its upstream MIT notice in `third_party/omp-thinking-ko/`.
- The unlicensed upstream browser extension [clay-chrome](https://github.com/chadbyte/clay-chrome) is neither bundled nor downloaded by Aigora.
- The public repository is published with fresh history because upstream history contained sensitive upstream material that must not be redistributed. Attribution remains in these notices.
- Subscription/consumer-login provider code was excluded after reviewing provider terms; “Claude Code” branding is not used in product UI. Its name here identifies a development tool.
- File icons and avatars have reproducible original-art provenance in `docs/asset-provenance.md`. Decorative inline SVGs and named-theme palette values still need the separate review described in section 1.
- A pre-publication gate for secrets, licenses, privacy and terms is run before publishing. The working-tree export runs the public-safety scan; that scan alone does not certify license, asset or provider-term compliance.
