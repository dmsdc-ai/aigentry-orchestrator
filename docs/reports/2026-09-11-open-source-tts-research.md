# Open-source TTS research — Korean-first remote voice intake (#1154)

- Date: 2026-09-11 · Session: tt1154-dustcraw (researcher) · Branch `docs/1154-tts-research` · base `9b688ef` · `main` at dispatch `d584034`
- Scope: TTS only (the STT category is owned by the complementary worker). Research/report only: no model download, install, benchmark, or app launch. App integration owner: #1152.
- Retrieval: every source below was retrieved **2026-09-11** through a summarizing web fetch (page extracts, not raw downloads). Numbers are quoted from those extracts; re-open the cited page before adoption.
- Product need (from the dispatch; not a verified runtime fact): Android/headset remote for aigentry — task intake, brief spoken progress, questions, loop start/stop/resume. Voice cloning is not a need; no cloned or unconsented voices.

## 1. Bottom line (conditional, not a ranking)

None of the Korean metrics found in the cited sources is comparable across candidates, so none is claimed "best". **No Korean naturalness (MOS/preference) result was found in the cited retrieved sources for any candidate** (a bounded search cannot prove none exists). Conditional shortlist:

1. **Server, Korean-first — Qwen3-TTS-12Hz CustomVoice (1.7B; 0.6B for lower cost), served through vLLM-Omni streaming.** Why: Apache-2.0 weights; Korean at model level plus a native Korean preset speaker (`Sohee`), so no cloning is needed; author-reported Korean WER; documented streaming serving (chunked PCM over HTTP, WebSocket). Conditions: CUDA GPU required; Korean naturalness and number/filename reading unmeasured; the published Korean numbers are for the *Base* (reference-prompted) models, not for `Sohee`. Qwen's README still says vLLM-Omni is offline-only, while the vLLM-Omni docs document online streaming — pin a version and verify.
2. **Server alternative — VoxCPM2 (2B)** when you want Apache-2.0 code *and* weights (stated "free for commercial use"), a default voice or Voice Design with no reference audio, and a documented `generate_streaming()`. Conditions: ~8 GB VRAM (RTX 4090 figure); no first-chunk latency found in the cited sources; its Korean numbers come from a self-compiled table.
3. **Lightweight offline — Supertonic 3 (~99M, ONNX) via sherpa-onnx (v1.13.2 adds Supertonic 3 and an Android demo).** Conditions:
   - The upstream repo was **archived 2026-09-09** ("Development and support have ended"). Weights are frozen, with no fixes or security patches.
   - The weights are OpenRAIL-M, i.e. open weights with use restrictions, not a permissive license. Restrictions include disclosing machine-generated content and a ban on impersonation.
   - The archived README documents no streaming API, so plan for app-side sentence chunking.

   Fallback: **MOSS-TTS-Nano-100M** (Apache-2.0 on GitHub, streaming claim, Android ONNX smoke example). Use it only if a *consented* reference voice is supplied, because clone mode is its documented main workflow.

Fun-CosyVoice3 and Chatterbox Multilingual V3 are credible but sit below these for this use. CosyVoice3 needs a Korean reference prompt for its zero-shot flow, and its authors note limited Korean data. For Chatterbox, the cited official sources document no streaming, and no Korean evaluation was found in them.

## 2. Candidate matrix

License labels: **permissive weights** = Apache-2.0/MIT weights; **use-restricted open weights** = OpenRAIL-M. The cited sources do not disclose training data for any candidate, so none is labeled "fully open source" in the data/training sense.

| Candidate | Exact release / availability | Params | Korean (model-level evidence) | Code / weights license; restrictions | Streaming (documented) | Runtime | Published speed — context, attribution |
|---|---|---|---|---|---|---|---|
| **Qwen3-TTS** (Alibaba Qwen) | `Qwen3-TTS-12Hz-{0.6B,1.7B}-{CustomVoice,Base}`, `1.7B-VoiceDesign`, tokenizer; released 2026-01-22 | 1.7B (HF lists "2B"); 0.6B (HF lists "0.9B") | `ko` in the 10-language list on each card; native Korean preset **Sohee** in the 0.6B and 1.7B CustomVoice cards | Apache-2.0 / Apache-2.0 (HF metadata) — permissive weights; 5M h training data undisclosed | Dual-track streaming architecture. Official `qwen-tts` examples are full-utterance only. vLLM-Omni: `POST /v1/audio/speech` with `stream=true` (PCM chunks); WebSocket `/v1/audio/speech/stream` buffers text until `input.done` (optional sentence split). HF speech-to-speech defaults to `--qwen3_tts_non_streaming_mode True` | CUDA GPU, bf16/fp16, FlashAttention 2 optional; no CPU/mobile guidance | Tech report: 101 ms first packet (97 ms LM + 4 ms decode), 12Hz-1.7B, c=1, internal vLLM V0 + torch.compile + CUDA Graph, **GPU unspecified** (author). vLLM blog: mean TTFP 70.61 ms at c=1 → 1127.93 ms at c=64, H20×2, voice clone, streaming; variant/precision unspecified (vLLM-Omni team) |
| **VoxCPM2** (OpenBMB) | README news "[2026.04]" | 2B | `ko` in the 30-language list | Apache-2.0 / Apache-2.0 ("free for commercial use") — permissive weights; data undisclosed | `generate_streaming()` chunk generator; chunk size and first-chunk latency not stated in the cited README/card; also in the vLLM-Omni model list | Python ≥3.10 (<3.13), PyTorch ≥2.5, CUDA ≥12, ~8 GB VRAM; 48 kHz output | RTF ~0.30 on RTX 4090 (PyTorch), ~0.13 with Nano-vLLM (author) |
| **Fun-CosyVoice3** (FunAudioLLM) | `Fun-CosyVoice3-0.5B-2512` (+ `_RL`), 2025-12 | 0.5B | `ko` in the 9-language list (README + HF card); the released card has no `ko` eval rows; paper rows in §3 | Apache-2.0 / Apache-2.0 (HF metadata) — permissive weights; 1M h data undisclosed | README: text-in + audio-out "bi-streaming", "latency as low as 150ms" (no hardware). Code: `class CosyVoice3(CosyVoice2)` inherits the `stream=` parameter; `example.py` CosyVoice3 calls use `stream=False`; generator text input is shown only on the CosyVoice2 path | vLLM, TensorRT-LLM/Triton, FastAPI/gRPC, Docker; GPU | 150 ms claim only (author, no hardware) |
| **Chatterbox Multilingual V3** (Resemble AI) | HF commits: "Add multilingual v3 T3 base weights" (Apr 22), "Add S3Gen v3 weights" + "Update model card for Multilingual V3 release" (Jun 10). The page shows no year; V2 is dated 2025-09-23 | 0.5B | `ko` in the 23-language list | MIT / MIT (HF metadata) — permissive weights; PerTh watermark on every output | None documented in the official repo | Python 3.11; CUDA/MPS/CPU; default voice when `audio_prompt_path` is omitted | None found in cited sources for Multilingual (the "sub-200ms" claim is for Turbo, English, commercial service) |
| **Supertonic 3** (Supertone) | README: 2026-04-29 (Supertone blog shows "May 28, 2026" — date mismatch). GitHub `supertone-inc/supertonic` redirects to `supertone-oss-archive/supertonic`, **archived 2026-09-09**. Weights at `Supertone/supertonic-3`, duplicated to `supertone-oss-archive/supertonic-3` | ~99M (ONNX assets) | `ko` in the 31-language list; Supertonic 2 (2026-01-06) covered en/ko/es/pt/fr | MIT / **OpenRAIL-M** (BigScience Open RAIL-M, 2022-08-18) — use-restricted open weights: commercial/SaaS and redistribution allowed; Attachment A bans impersonation/deepfakes without consent and requires disclosing machine-generated content; restrictions must pass downstream. Archive notice: "No updates, bug fixes, security patches, or support" | No streaming API documented in the archived README; plan whole-utterance synthesis with app-side sentence chunking | ONNX Runtime, CPU, no GPU; SDKs incl. Java/Flutter/Swift. sherpa-onnx v1.12.29 (Supertonic), v1.13.2 (Supertonic 3 models + Android demo) | Supertonic 2: RTF 0.015 on M4 Pro CPU (short text), 0.005 on RTX 4090 (author, via the sherpa conversion card). Supertonic 3 CPU chart: hardware labels not extractable |
| **MOSS-TTS-Nano-100M** (OpenMOSS/MOSI) | 2026-04-10; ONNX CPU 2026-04-17; mlx-audio 2026-05-06 | 0.1B | `ko` in the 20-language list (HF card + README) | Apache-2.0 `LICENSE` in GitHub; HF metadata says apache-2.0 but the **HF repo has no LICENSE file**, and the card says to treat it as unlicensed for redistribution until one is published; data undisclosed | "Streaming inference" claim; "streaming generation can run on a 4-core CPU" | CPU; ONNX export; Android ONNX Runtime *smoke* example (pre-tokenized demo prompts); 48 kHz stereo | No numbers found in cited sources ("runs smoothly on a single CPU core on a MacBook Air M4") |

## 3. Korean evidence by metric type (never pooled)

### 3.1 Intelligibility (WER/CER) — only author/vendor-reported numbers found

| Source (who ran it) | Test set | Metric | Korean values |
|---|---|---|---|
| Qwen3-TTS tech report, Table 6 (Qwen) | "TTS multilingual test set"; README attributes the row to the Base models | WER | 12Hz-0.6B **1.741**, 12Hz-1.7B **1.755**, 25Hz-0.6B 2.458, 25Hz-1.7B 2.695; MiniMax 1.747; ElevenLabs 1.865 |
| VoxCPM README (OpenBMB, compiled table) | Minimax-MLS-test | WER | Minimax 1.747; ElevenLabs 1.865; Qwen3-TTS 1.755; Fish Audio S2 1.180; VoxCPM2 **1.962** |
| Supertonic README (Supertone, vendor) | Minimax-MLS-test | CER (`korean*`) | VoxCPM2 4.70; OmniVoice 3.22; Qwen3-TTS 4.07; Supertonic 2 3.65; Supertonic 3 **3.26** |
| CosyVoice 3 paper v2, Table 5 (Alibaba) | CV3-Eval multilingual voice cloning | CER | CV3-0.5B 12.8; 0.5B+DiffRO 4.02; 1.5B 5.69; 1.5B+DiffRO 4.01. Authors: Korean CER "approximately 6%" in mono→polyglot transfer, "due to the limited volume and quality of available data" |
| Chatterbox ML V3, MOSS-TTS-Nano | — | — | none found in cited sources → unknown |

**Comparability warning.** The same system on the same named test set gets different numbers from different evaluators and metrics. Qwen3-TTS Korean is 1.755 "WER" in the Qwen and VoxCPM tables and 4.07 CER in Supertone's table.
- VoxCPM's Qwen, MiniMax, and ElevenLabs cells match the Qwen report exactly, which indicates copied numbers. The cited VoxCPM README names no ASR for this table.
- The cited Supertonic README names no ASR either.
- It is also unconfirmed whether the released CosyVoice `2512` checkpoint matches any of the paper's model rows.

Treat cross-table ordering as **not established**. Orderings within one table are single-party and unverified.

### 3.2 Speaker similarity (SIM) — cloning fidelity, not the product need
- Qwen3-TTS Table 6, Korean: 12Hz-0.6B 0.812, 12Hz-1.7B 0.799, MiniMax 0.776, ElevenLabs 0.700.
- VoxCPM table, Korean: MiniMax 77.6, ElevenLabs 70.0, Qwen3-TTS 79.9, Fish S2 81.7, VoxCPM2 83.3.

### 3.3 Naturalness (MOS / preference)
- Qwen3-TTS report (v1, as retrieved): no MOS or preference evaluation found.
- Chatterbox: "listeners preferred Chatterbox over ElevenLabs 63.75%" (Resemble page) gives no language, dataset, or raters. The Podonos evaluations in the README are for Turbo (English). Neither is Korean evidence.
- No Korean MOS was found in the cited retrieved sources for any candidate, so **Korean naturalness is unknown here**; a bounded search cannot prove that no such result exists.

### 3.4 Numbers, filenames, Korean-English mixed text
No Korean numeral or filename reading results were found in the cited sources for any candidate. What the cited sources do show:
- **Supertonic:** README normalization demos are English only (`$5.2M`, phone numbers, `2.3h at 30kph`).
- **CosyVoice:** pronunciation inpainting is documented for Chinese pinyin and English CMU phonemes only.
- **MOSS-TTS-Nano:** ships `text_normalization_pipeline.py`; behavior not described in the cited README.
- **MeloTTS Korean:** `normalize()` has no explicit numeral expansion (it uses g2pkk + jamo).

Status: **unknown** for all; proposed test in §6 (T3), not executed.

## 4. Streaming, first audio, interruption
- **Audio-out chunk streaming documented:** Qwen3-TTS (via vLLM-Omni), VoxCPM2 (`generate_streaming`), CosyVoice (`stream=`), MOSS-TTS-Nano (claim only).
- **Text-in streaming:** CosyVoice generator input (shown on the v2 path). The vLLM-Omni WebSocket buffers text until `input.done`, with optional sentence splitting, so it is sentence-level, not token-level.
- **No streaming found in cited sources:** Supertonic (archived README documents no streaming API) and Chatterbox (none in the official repo/card). For short progress phrases, sentence chunking may be enough — unmeasured.
- **Interruption/barge-in:** no cancellation semantics (server abort on client disconnect, on-device stop) were found in the cited sources for any candidate. This is an app-side requirement (#1152); measurement is proposed in §6 T6, not executed.
- **No phone/Android runtime number was found in the cited sources for any candidate, and none was measured locally.** Every latency found is author/vendor-reported on data-center GPUs (H20, unspecified), a desktop GPU (RTX 4090), or Apple desktop silicon (M4 Pro).

## 5. Exclusions (verified reason)

| Model | Reason |
|---|---|
| Fish Audio S2 Pro (HF card: "5 billion parameters (Slow AR: 4B, Fast AR: 400M)"; GitHub says 4B; paper 2026-03) | Korean "Tier 2", Korean WER 1.180 in the VoxCPM table, but the Fish Audio Research License says "Commercial use requires a separate license"; TTFA ~100 ms on a single H200 (author). Quality reference only |
| Coqui XTTS-v2 | `ko` listed, but the CPML "allows only non-commercial use of a machine learning model and its outputs" |
| OmniVoice (k2-fsa, 0.6B, 2026-03/04) | Korean in `languages.md` (8,609.28 h), but weights are CC-BY-NC "due to constraints from its training data (e.g., Emilia)" (code Apache-2.0) |
| KRAFTON Raon-Speech-9B (2026-04) | Korean+English speech LLM with TTS; CC BY-NC 4.0; 9B; TTFT 617 ms (RTX 6000 Pro) / 887 ms (L40S) (author) |
| Mistral Voxtral-4B-TTS-2603 | **Korean unsupported** (not in its 9-language list); CC BY-NC 4 |
| Breeze-TTS-2 (2026-08-25, 3B) | **Korean unsupported** (English + Chinese); BreezeBlue Research and Non-Commercial License |
| Kokoro-82M v1.0 | **Korean unsupported** (`VOICES.md`: 9 languages, no `ko`) |
| VibeVoice-Realtime-0.5B | Korean "experimental" only; Microsoft: "do not recommend using VibeVoice in commercial or real-world applications without further testing" |
| Step-Audio-EditX (3B) | Korean added Nov 2025, but the model is editing/cloning-focused; 12–16 GB GPU; "keep audio under 30 seconds"; no streaming found on the fetched card; weight license not confirmed on the fetched page |
| Chatterbox Turbo / Nano | English only |
| MeloTTS-Korean (MyShell) | MIT, native `KR`, "CPU real-time" claim, but last commit 2024-12-24 (unmaintained ~21 months) and no numeral expansion in `normalize()`. Legacy permissive fallback only |
| Piper `ko/ko_KR/kss` | A Korean voice directory was added ~2 months before retrieval (commit `f426ef3` "Add ko, he, mr voices"). Voice MODEL_CARD, dataset license, and quality **not verified** (bounded scope) → unknown; check the KSS dataset terms before any use. An earlier `voices.json` extract in this session wrongly implied no Korean; the directory listing corrected it |

## 6. Proposed local evaluation matrix (NOT executed)

**Systems:**
- Qwen3-TTS-12Hz-1.7B-CustomVoice (`Sohee`)
- Qwen3-TTS-12Hz-0.6B-CustomVoice (`Sohee`)
- VoxCPM2 (default voice)
- Supertonic 3 (preset voice, sherpa-onnx on the target phone)
- MOSS-TTS-Nano (consented reference voice; only after the HF license-file gate passes)
- Optional: Fun-CosyVoice3 with a consented Korean prompt

| ID | Test | Input set (small) | Metric | Method / controls |
|---|---|---|---|---|
| T1 | Korean naturalness | 20 short Korean progress/question sentences (5–30 syllables) | MOS 1–5 + pairwise preference | ≥5 native Korean raters, blind, randomized, loudness-matched |
| T2 | ko-en technical intelligibility | 30 mixed sentences, e.g. "PR 1154를 main에 머지했습니다", "pytest 3개 실패", "vLLM 서버 재시작" | CER from one fixed Korean ASR + human tagging of mangled terms | Same ASR model/version for every system |
| T3 | Numbers / filenames / symbols | 30 items: `v2.3.1`, `src/app/main.py`, `2026-09-11`, `#1154`, `3.5초`, `API_KEY`, `90%`, `10:30` | % read correctly against a written expected-reading sheet | 2 annotators; record whether app-side pre-normalization is required |
| T4 | First audio | T1 + T2 sentences | TTFA p50/p95, warm and cold, c=1 and c=4 | Declare GPU/precision/engine version (server); phone SoC/threads/int8 (offline) |
| T5 | Streaming reality | 3 multi-sentence replies | First audio before full text arrives? Chunk cadence | Log chunk timestamps; genuine stream vs sentence chunking |
| T6 | Interruption | Stop command mid-utterance | stop→silence ms; generation actually cancelled (GPU/CPU freed) | Client disconnect and explicit abort both tried |
| T7 | Robustness | 100 prompts | Skip / repeat / hallucination rate | ASR alignment + human spot check |
| T8 | Footprint | — | Model size, peak RAM/VRAM, 10-minute phone battery drain | Same device for all offline systems |

Decision rule: compare only within the same hardware, engine, and ASR; never across the published tables in §3.

## 7. Gaps and source-access notes (unknown ≠ bad)
- **Extraction method:** all pages were read through a summarizing web fetch, so figures are extract quotes. Re-verify at adoption.
- **Qwen3-TTS:** the GPU behind the 101 ms figure is unspecified. The README's vLLM-Omni "offline only" statement conflicts with the vLLM-Omni docs; the docs are later.
- **vLLM blog sweep:** model variant, precision, and text length unspecified.
- **CosyVoice3:** the mapping from paper models to the released checkpoint is not stated in the cited README/card/paper, and none of them gives streaming hardware.
- **Supertonic:**
  - The HF card lacks the per-language table (the GitHub README was used instead).
  - The CPU/GPU chart hardware labels could not be extracted.
  - Release dates disagree: README 2026-04-29 vs blog "May 28, 2026".
  - Repo archived 2026-09-09.
- **sherpa-onnx:**
  - The v1.13.2 page shows "13 May" with no year.
  - The Supertonic 3 conversion's language coverage was not separately verified.
  - The pretrained-models index page did not list Supertonic (doc lag vs the CHANGELOG).
- **Chatterbox ML V3:** the HF commit list prints no year.
- **MOSS-TTS-Nano:** no RTF/TTFA numbers found in cited sources. Built-in voices are unclear: the README mentions them, but vLLM-Omni requires `ref_audio` on every request.
- **Training data:** provenance is not disclosed in the cited sources for any shortlisted model, so commercial distribution still needs a legal review even with Apache/MIT weights.
- **Not found in cited sources for any candidate:** Korean MOS, phone runtime, and interruption behavior. None of these was measured locally (research-only scope).

## 8. Sources (all retrieved 2026-09-11)

**Qwen3-TTS**
- https://github.com/QwenLM/Qwen3-TTS
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
- Tech report: https://arxiv.org/abs/2601.15621 (HTML v1)
- vLLM-Omni TTS online serving: https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/text_to_speech/
- vLLM blog (2026-06-23): https://vllm.ai/blog/2026-06-23-vllm-omni-tts
- https://github.com/huggingface/speech-to-speech

**VoxCPM2**
- https://github.com/OpenBMB/VoxCPM (plus raw README)
- https://huggingface.co/openbmb/VoxCPM2

**CosyVoice**
- https://github.com/FunAudioLLM/CosyVoice
- https://raw.githubusercontent.com/FunAudioLLM/CosyVoice/main/example.py
- https://raw.githubusercontent.com/FunAudioLLM/CosyVoice/main/cosyvoice/cli/cosyvoice.py
- https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
- Paper v2: https://arxiv.org/abs/2505.17589 (HTML v2)

**Chatterbox**
- https://github.com/resemble-ai/chatterbox (plus raw README)
- https://huggingface.co/ResembleAI/chatterbox
- https://huggingface.co/ResembleAI/chatterbox/commits/main
- https://www.resemble.ai/learn/models/chatterbox-multilingual

**Supertonic**
- https://github.com/supertone-oss-archive/supertonic (redirected from `supertone-inc/supertonic`)
- https://huggingface.co/Supertone/supertonic-3
- https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE
- https://huggingface.co/supertone-oss-archive/supertonic-3
- https://www.supertone.ai/en/work/faster-and-more-accurate-across-31-languages----introducing-supertonic-3

**sherpa-onnx**
- https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md
- https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.2
- https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-tts-int8-2026-03-06
- https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/index.html

**MOSS-TTS-Nano**
- https://github.com/OpenMOSS/MOSS-TTS-Nano
- https://raw.githubusercontent.com/OpenMOSS/MOSS-TTS-Nano/main/LICENSE
- https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M (plus `/tree/main`)

**Exclusions**
- Fish Audio S2 Pro: https://github.com/fishaudio/fish-speech, https://huggingface.co/fishaudio/s2-pro
- XTTS-v2: https://huggingface.co/coqui/XTTS-v2, https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt
- OmniVoice: https://huggingface.co/k2-fsa/OmniVoice, https://github.com/k2-fsa/OmniVoice, https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md
- Raon-Speech-9B: https://huggingface.co/KRAFTON/Raon-Speech-9B
- Voxtral TTS: https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- Breeze-TTS-2: https://huggingface.co/BreezeBlue/Breeze-TTS-2
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M, https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
- VibeVoice-Realtime-0.5B: https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B
- Step-Audio-EditX: https://huggingface.co/stepfun-ai/Step-Audio-EditX
- MeloTTS: https://github.com/myshell-ai/MeloTTS, https://github.com/myshell-ai/MeloTTS/commits/main, https://huggingface.co/myshell-ai/MeloTTS-Korean, https://raw.githubusercontent.com/myshell-ai/MeloTTS/main/melo/text/korean.py
- Piper voices: https://huggingface.co/rhasspy/piper-voices/tree/main, https://huggingface.co/rhasspy/piper-voices/tree/main/ko/ko_KR

Discovery-only (not used as evidence): web search result pages for "open-source TTS Korean 2026", which led to Voxtral TTS, Raon, Breeze-TTS-2, OmniVoice, and MOSS-TTS-Nano.
