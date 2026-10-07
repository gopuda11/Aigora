# Fork provenance

Aigora is maintained by **Aigora contributors** and published at [Aigora contributors/Aigora](https://github.com/Aigora contributors/Aigora).

The inherited code began as a fork of [Clagentic Console](https://github.com/clagentic/clagentic-console), itself based on [Clay](https://github.com/chadbyte/clay). Both are MIT-licensed. The recorded fork base is `349dbc27114a5f733ac140ac3ccac0b14805b555`.

The complete MIT notice in [LICENSE](LICENSE), including the Clay and Clagentic Console copyright lines, must remain with substantial copies. Those upstream legal attribution names are not Aigora's maintainer identity. Aigora's own copyright is attributed only to Aigora contributors.

The public repository starts with a fresh history produced by `scripts/export-public.sh` because upstream history contained sensitive upstream material that must not be redistributed. Inherited commit authorship is not carried into that history; attribution remains here, in LICENSE and in [CREDITS.md](CREDITS.md). The separate private repository and deployment do not adopt this public branch's architecture.

The public tree contains API-key/local-model implementations and no private extension implementation. The generic trusted-extension hook has no bundled extensions. Dependencies installed by npm, browser libraries/fonts, external services and models retain separate terms listed in [CREDITS.md](CREDITS.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Aigora is an independent project, not an official product of upstream maintainers or AI providers.


The Korean observable-work/thinking presentation retains adapted disclosure wording and provider-visible trace handling associated with [hvvsdcm/omp-thinking-ko](https://github.com/hvvsdcm/omp-thinking-ko), MIT, v1.0.1, upstream commit `9b293089cf98115a6c8f1b4b1d9a23e08732c38d`. Its [LICENSE](third_party/omp-thinking-ko/LICENSE) and [adaptation record](third_party/omp-thinking-ko/README-AIGORA.md) remain with this public tree; the standalone OMP host runtime is not bundled.

[Nhahan/WebGPT](https://github.com/Nhahan/WebGPT) was an earlier external runtime integration, removed in 0.1.0; no source was ever copied. WWG and mixdog were evaluated, with no ported code found in this public tree. Development tools and scanner engines are credited separately in [CREDITS.md](CREDITS.md).

The unlicensed [clay-chrome](https://github.com/chadbyte/clay-chrome) browser extension is neither bundled nor downloaded. Subscription/consumer-login provider code was excluded after reviewing provider terms; “Claude Code” branding is not used in product UI. Assets with unknown provenance are identified in CREDITS; the pre-publication gate checks secrets, licenses, privacy and terms before publishing.
