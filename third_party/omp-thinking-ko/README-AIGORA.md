# omp-thinking-ko attribution and Aⁱgora adaptation

The private development repository vendored `thinking-ko.ts` from
[`hvvsdcm/omp-thinking-ko`](https://github.com/hvvsdcm/omp-thinking-ko), release
`v1.0.1`, under its MIT license. The upstream license is preserved in
`LICENSE`. This public directory retains that upstream notice and adaptation
record because the Korean disclosure wording and provider-visible trace handling
remain in the public UI. The standalone `thinking-ko.ts` host extension and its
translation prompts are not shipped here.

Aⁱgora changes only the translation tone and disclosure wording: informal
monologue is replaced with concise educational Korean. The upstream OMP host
integration remains in the private development record and is not loaded directly
by the Aⁱgora daemon because Aⁱgora does not run inside OMP. Runtime integration must
consume only thinking text that an agent provider explicitly exposes. Hidden
chain-of-thought is never reconstructed or presented as genuine model output.

Upstream commit at import: `9b293089cf98115a6c8f1b4b1d9a23e08732c38d`.

Public retained surfaces: `lib/public/aigora/i18n/ko/agoraRender.js` contains the
educational Korean observable-work and thinking disclosure text introduced with
the adaptation; `lib/public/modules/agora-model.js` enforces provider-visible
trace disclosure; `lib/public/modules/agora-render.js` renders that disclosure.
The deterministic timeline in `lib/orchestration/narration.js` uses observable
events and explicitly disclosed progress summaries, not the OMP translation
engine. No hidden thinking reconstruction is enabled by retaining these notices.
