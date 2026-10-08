# Open-source STT research for Voice Code (Korean-first) — task #1153

- Date: 2026-09-11 · Session: `st1153-dustcraw` (researcher) · Branch: `docs/1153-stt-research`
- Base: `9b688ef` · `main` at start: `d584034`
- Scope: **STT only** (TTS belongs to the complementary worker). Research/report only — no model
  download, package install, benchmark run or app launch. App integration owner: #1152. The Voice
  Code usage context (phone remote task intake, short spoken progress, questions, loop
  start/stop/resume) is treated as a starting point, not a verified runtime fact.
- Retrieval: **every source in §9 was retrieved on 2026-09-11.** Hugging Face (HF) revision SHAs are
  recorded so that numbers can be re-checked against the same card revision.
- Evidence rule: every accuracy/speed number is **author-reported** unless marked otherwise. No
  independent Korean benchmark was found in official sources. Numbers that differ in dataset,
  metric, normalisation or hardware are **not ranked** against each other.
- Labels: "open weights" = downloadable weights under the stated licence; "permissive" refers to the
  licence text only. No candidate was verified to publish its full training data, so none is called
  "fully open-source" here.

## 1. Decision summary (conditional — no absolute "best")

| Role | Conditional pick | Adopt only if | Evidence for | Main unknowns |
|---|---|---|---|---|
| Korean **server** STT (primary) | **Qwen3-ASR-1.7B** (Apache-2.0) on vLLM streaming; **Qwen3-ASR-0.6B** as the cheaper tier | a GPU host for vLLM is available and it passes the §6 matrix | Korean is listed at model level; the only candidate with author-reported Korean results on three public sets (CER 5.88 CV / 8.61 MLC-SLM / 2.57 FLEURS); one model for offline + streaming; `context` text input in the official package; automatic LID | Korean streaming accuracy (not reported), Korean–English code-switching, command/filename accuracy, GPU model behind speed claims |
| Low-delay **server streaming** alternative | **Voxtral-Mini-4B-Realtime-2602** (Apache-2.0) | fixed-delay native streaming partials matter more than Korean accuracy; ≥16 GB GPU | native streaming with 80 ms–2.4 s configurable delay; Korean is in its 13 languages | Korean is its 2nd-highest-error language at 480 ms in its own FLEURS table (15.74 % WER); no context biasing in the open weights; no code-switch data |
| **Phone / offline fallback** | **sherpa-onnx** runtime (Apache-2.0) with **SenseVoice-Small int8** for VAD-segmented short commands; **streaming Zipformer-Korean** only if on-device partials are required *and* its licence is cleared; **Qwen3-ASR-0.6B int8** as an on-device upgrade if the ~937 MB package fits | device test on the target Android SoC passes §6 | Korean at model level for all three; sherpa-onnx ships Android APIs; Qwen3-ASR-0.6B int8 Android demo APKs were published 2026-08-10 | SenseVoice Korean accuracy (no number found); Zipformer-ko weight licence undeclared and KsponSpeech terms unverified; on-device latency unmeasured |

- **Baseline, not a pick:** Whisper large-v3-turbo via faster-whisper / whisper.cpp — keep it in the
  matrix as the reference point; no native streaming; its card documents hallucination.
- **Evaluate, but don't adopt yet:** Cohere Transcribe (offline only, no automatic LID, card says code-switching is
  "inconsistent", gated download) and Fun-ASR-MLT-Nano (card: "MLT per-language results will be
  added when a reproducible evaluation is published").

## 2. Candidates — identity, availability, size, runtime

| # | Exact artifact (HF rev at retrieval) | Availability | Params (source) | Korean at model level | Mode | Runtimes (verified) |
|---|---|---|---|---|---|---|
| 1 | `Qwen/Qwen3-ASR-1.7B` (`7278e1e70f`), `Qwen/Qwen3-ASR-0.6B` (`5eb144179a`); timestamps via `Qwen/Qwen3-ForcedAligner-0.6B` | HF repos created 2026-01-28; GitHub release note 2026-01-29; paper arXiv 2601.21337 v1 2026-01-29 / v2 2026-01-30; native Transformers support note 2026-06-26 | HF safetensors total 2,349,217,408 BF16 ("1.7B" = Qwen3-1.7B LLM + projector + AuT encoder per paper); 938,008,576 BF16 ("0.6B") | README model table lists "Korean (ko)" for both ASR models; aligner also lists Korean; paper Table A.2 has `ko` rows | offline + streaming in one model; streaming is vLLM-only, no batch, no timestamps; max 1200 s per request (paper Table 1) | `qwen-asr` package (Transformers / vLLM backends); streaming web demo `qwen-asr-demo-streaming`; sherpa-onnx offline `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25` (~937 MB: 42 MB frontend + 721 MB decoder + 174 MB encoder) since v1.12.34 (2026-03-26) |
| 2 | `mistralai/Voxtral-Mini-4B-Realtime-2602` (`2769294da9`) | HF repo created 2026-01-21; Mistral announcement 2026-02-04; paper arXiv 2602.11298 v1 2026-02-11 … v3 2026-04-06 | safetensors 4,429,679,360 BF16; card: ≈3.4B LM + ≈970M audio encoder | 13-language list includes Korean; FLEURS table has a Korean column | native streaming; delay 80 ms–1.2 s in 80 ms steps, plus 2.4 s; card recommends 480 ms; one text token = 80 ms | vLLM (recommended; `transcription_delay_ms`), Transformers (card recommends v5), ExecuTorch (card: "untested"); "single GPU with >= 16GB memory" (BF16) |
| 3 | `openai/whisper-large-v3` (`06f233fe06`), `openai/whisper-large-v3-turbo` (`41f01f3fe8`) | HF created 2023-11-07 / 2024-10-01 | 1,543,490,560 / 808,878,080 F16; turbo cuts decoder layers from 32 to 4 | `"ko": "korean"` in `whisper/tokenizer.py` `LANGUAGES` | offline, 30 s windows (chunked long-form in Transformers); no native streaming | faster-whisper v1.2.1 (2025-10-31; CTranslate2; Silero VAD filter; `hotwords`, `initial_prompt` parameters); whisper.cpp v1.9.4 (2026-09-11; Android/iOS examples; Silero VAD; Vulkan / Core ML; `whisper-stream` samples audio every 0.5 s and is described as a naive example) |
| 4 | `CohereLabs/cohere-transcribe-03-2026` (`b1eacc2686`) | HF repo created 2026-03-24; released 2026-03-26; card modified 2026-06-10 | safetensors 2,065,804,048 BF16; Fast-Conformer encoder + lightweight Transformer decoder | card `language` metadata includes `ko`; blog: "trained on 14 languages … Japanese and Korean" | offline only; language must be specified (no automatic LID); no timestamps or diarization | Transformers and vLLM (per card); sherpa-onnx C++/Python/Kotlin/Java/Swift/… since v1.12.35 (2026-04-03) |
| 5a | `FunAudioLLM/SenseVoiceSmall` (`3847d57b6b`) | open-sourced 2024-07 (HF created 2024-07-03, modified 2026-06-20) | not stated on card ("similar number of parameters to the Whisper-Small model") | card: Mandarin, Cantonese, English, Japanese, Korean | offline, non-autoregressive; streaming only via a third-party attention-truncation fork (README) | FunASR, ONNX / libtorch export; sherpa-onnx `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` (int8 228 MB / fp32 894 MB) and `…-int8-2025-09-09` (226 MB, Cantonese fine-tune, no punctuation) |
| 5b | `FunAudioLLM/Fun-ASR-MLT-Nano-2512` (`2c088f5351`) | HF created 2025-12-15, modified 2026-08-05 | 800M (card; no safetensors metadata) | card: 31 languages including Korean | offline; the Fun-ASR family documents a vLLM streaming SDK (`FunASRNanoStreamingVLLM`) and a WebSocket service — streaming for the MLT checkpoint specifically is not separately confirmed | FunASR 1.4.15, vLLM, llama.cpp/GGUF runtime v0.2.6 (repo README); the sherpa-onnx Fun-ASR packages found are for base Fun-ASR-Nano (zh/en/ja), not MLT |
| 6 | `sherpa-onnx-streaming-zipformer-korean-2024-06-16` (icefall KsponSpeech recipe) | HF repo created 2024-06-16; icefall result dated 2024-06-12 | 79,022,891 (icefall `RESULTS.md`) | trained on KsponSpeech (Korean) | true streaming transducer (results at 320 / 640 ms chunks) | sherpa-onnx (Android, iOS, HarmonyOS, Raspberry Pi, …); encoder int8 121 MB (fp32 279 MB), decoder int8 2.7 MB, joiner int8 2.5 MB; docs report RTF 0.1 (int8) with hardware not stated |

## 3. Licence separation

| Candidate | Code licence | Weight licence (label) | Dataset / access restrictions | Commercial-use uncertainty |
|---|---|---|---|---|
| Qwen3-ASR | Apache-2.0 (repo; SPDX headers) | Apache-2.0 on HF card — open weights, permissive | training data not enumerated → unknown | low on licence text |
| Voxtral RT | Apache-2.0 | Apache-2.0 (announcement + HF) — open weights, permissive | not stated → unknown | low on licence text |
| Whisper | MIT (GitHub: "Whisper's code and model weights are released under the MIT License") | MIT per GitHub, **but** HF `whisper-large-v3` metadata says `apache-2.0` (turbo: `mit`) — a labelling inconsistency; both permissive | large-v3: "1 million hours of weakly labeled audio and 4 million hours of pseudo-labeled audio", not enumerated | low; record the label inconsistency |
| Cohere Transcribe | not inspected (no separate code repo reviewed) | Apache-2.0 per HF metadata; **gated** (`gated: auto`, "agree to share your contact information") | not stated | low on licence text; every deployer/CI must pass the click-through gate |
| SenseVoice-Small | MIT (SenseVoice repo) | **FunASR Model Open Source License Agreement v1.1** — custom, not OSI; requires attribution and keeping the model name; maintainer clarification (SenseVoice issue #334, linked from README) states commercial use of the official weights is permitted | not stated | medium: custom licence; the clarification covers the official weights only, so third-party conversions (e.g. sherpa-onnx ONNX) must be checked separately |
| Fun-ASR-MLT-Nano | Apache-2.0 | Apache-2.0 (HF card) — open weights, permissive | "hundreds of thousands of hours", not enumerated | low on licence text |
| Zipformer-ko | sherpa-onnx Apache-2.0; icefall recipe licence not checked | **undeclared** — the HF repo has no licence field | KsponSpeech (AI Hub): the page states "※ 내국인만 데이터 신청이 가능합니다." (only domestic nationals may apply); usage terms are not visible without login | **high**: weight licence undeclared and dataset terms unverified |

## 4. Korean evidence (author-reported — do not rank across rows)

| Candidate | Source (author) | Dataset | Metric | Setting | Korean value |
|---|---|---|---|---|---|
| Qwen3-ASR-1.7B | Qwen3-ASR Technical Report, Table A.2 (Qwen team) | Common Voice / MLC-SLM / FLEURS (ko) | CER (paper: "We use CER for character-based languages (e.g., … Korean)") | offline | 5.88 / 8.61 / 2.57 |
| Qwen3-ASR-0.6B | same | same | CER | offline | 8.48 / 10.31 / 3.72 |
| Qwen3-ASR (streaming) | same, Table 8 | LibriSpeech, FLEURS-en, FLEURS-zh only | WER/CER | 2 s chunk, 5-token fallback, last 4 chunks unfixed | **Korean streaming not reported.** On those sets the 1.7B average goes from 2.69 offline to 3.33 streaming |
| Voxtral RT | HF card FLEURS table (Mistral) | FLEURS (ko) | labelled WER | delay 160 / 240 / 480 / 960 / 2400 ms | 19.81 / 17.56 / 15.74 / 14.90 / 14.30 % |
| *(reference)* Voxtral Mini Transcribe 2.0 — **API-only, not open weights** | same | FLEURS (ko) | WER | offline | 12.29 % |
| Zipformer-ko | icefall `egs/ksponspeech/ASR/RESULTS.md` (k2-fsa) | KsponSpeech eval_clean / eval_other | CER | streaming, 320 ms chunk, modified beam search | 10.13 / 10.88 % |
| | | | | streaming, 640 ms chunk, modified beam search | 9.91 / 10.72 % |
| Cohere Transcribe | HF card and blog (Cohere) | average of FLEURS, CV 17.0, MLS, Wenet "where relevant"; CER for ko | CER | offline | **figure only — value not extracted → unknown** |
| SenseVoice-Small | card / README | — | — | — | **no machine-readable Korean value found → unknown** |
| Fun-ASR-MLT-Nano | card | — | — | — | **card: per-language results not yet published → unknown** |
| Whisper large-v3 / turbo | GitHub README per-language chart | FLEURS | — | — | **image only — not extracted → unknown** |

Comparability notes:
- Qwen's Korean values are CER; Voxtral's Korean column is labelled WER. FLEURS-ko CER 2.57 and FLEURS-ko WER 15.74 % measure different things and must not be read as a ranking.
- KsponSpeech (spontaneous conversational Korean, in-domain for Zipformer-ko) and FLEURS (read speech) are different distributions.
- Qwen paper Table 5 gives multilingual macro-averages computed by the Qwen team, a competitor for the other entries. FLEURS: Whisper-large-v3 5.27, Fun-ASR-MLT-Nano 10.03, Qwen3-ASR-0.6B 7.57, Qwen3-ASR-1.7B 4.90. CommonVoice: 10.77 / 17.25 / 12.75 / 9.18. These are cross-language averages and a hint only; they are not Korean evidence and not independent.

Speed claims and their conditions (none is a phone-loop latency measurement):
- Qwen3-ASR-0.6B: average TTFT 92 ms (p95 105 ms) at concurrency 1; throughput 2,000 s of audio per second at concurrency 128. Conditions: vLLM v0.14.0, CUDA Graph, BF16, ~2-minute input, "a single typical computing resource" — **GPU model not stated**. This is offline/async serving, not streaming-partial latency.
- Voxtral RT: the delay is a model setting counted in 80 ms tokens, not a measured wall-clock latency. Neither the card nor the paper abstract gives latency hardware. The card claims "throughput exceeding 12.5 tokens/second" on unspecified "minimal hardware".
- SenseVoice-Small: "70ms to process 10 seconds of audio" with **hardware not stated**. sherpa-onnx docs give int8 RTF on RK3588: Cortex-A55 0.436 (1 thread) → 0.175 (4 threads); Cortex-A76 0.099 (1 thread) → 0.049 (4 threads).
- sherpa-onnx Qwen3-ASR-0.6B int8: RTF 0.103 (334 s English sample) and 0.077 (272 s Chinese sample); hardware and thread count not captured → treat as unknown.

## 5. Fit against Voice Code needs

| Need | Qwen3-ASR | Voxtral RT | Whisper + runtimes | Cohere | SenseVoice / Fun-MLT | Zipformer-ko (sherpa-onnx) |
|---|---|---|---|---|---|---|
| Korean at model level | yes | yes | yes | yes | yes / yes | yes (Korean-only) |
| Korean–English code-switching | unknown for ASR (the paper claims code-switch support only for the ForcedAligner) | unknown | unknown | card: "inconsistent performance on code-switched audio" | unknown | unknown (Korean-only training corpus) |
| Filenames / numbers / commands | unknown (no evaluation) | unknown | unknown | `punctuation=False` option; no ITN statement | ITN options (SenseVoice `use_itn`, Fun-ASR ITN); accuracy unknown | unknown |
| Silence / non-speech hallucination | SFT used "non-speech data" (paper); the sherpa-onnx port fixed silent-audio hallucination "when hotwords/language are set" (v1.13.7, PR #3907) | not stated | card documents hallucination and repetition, "worse on lower-resource … languages"; Silero VAD available in both runtimes | card: "eager to transcribe, even non-speech sounds" → prepend a VAD; sherpa-onnx fix in v1.13.8 (PR #3924) | sherpa-onnx fixed silent-audio hallucination for base FunASR-Nano (v1.13.8, PR #3921) | not stated |
| Vocabulary / context bias | `context` argument in `transcribe()` and `init_streaming_state()` (`qwen_asr/inference/qwen3_asr.py`); SFT used "context biasing data"; sherpa-onnx `hotwords` for Qwen3-ASR since v1.12.35 | open weights: none documented (the 100-term biasing is a feature of the API-only Transcribe V2) | `initial_prompt`, `hotwords` (faster-whisper) | none documented | Fun-ASR `hotwords`; SenseVoice none documented | sherpa-onnx transducer hotwords with `modified_beam_search`; docs cover bpe / cjkchar units only, so Korean tokenisation is unverified |
| Incremental partials / finals | `streaming_transcribe()` updates `state.text` per call; `finish_streaming_transcribe()` finalises; example uses a 2.0 s chunk, `unfixed_chunk_num=2`, `unfixed_token_num=5` (the paper's evaluation kept 4 chunks unfixed) | native streaming at a fixed delay | none native | none | none (VAD segments → finals only) | native streaming |
| Endpointing / VAD | none documented in `qwen-asr` → external VAD | not documented | runtime VAD (Silero) | external VAD required | FunASR `fsmn-vad`; sherpa-onnx VAD | sherpa-onnx VAD available; endpoint rules not verified in this pass |
| Cancellation | not documented — app level (#1152) | not documented | not documented | not documented | not documented | not documented |
| Phone feasibility | 0.6B int8 via sherpa-onnx, ~937 MB, offline only | ExecuTorch "untested"; the vLLM path needs a ≥16 GB GPU | whisper.cpp Android example | sherpa-onnx Kotlin/Java API (size not captured) | SenseVoice int8 228 MB with RK3588 RTF data | encoder int8 121 MB |

Silence evidence caveat: the sherpa-onnx fixes (v1.13.7 on 2026-09-01; v1.13.8 on 2026-09-10) are fixes to
sherpa-onnx's own ports. They do not describe upstream model behaviour in vLLM or Transformers, but they
do show that silence handling must be tested per runtime. The external VAD candidate verified here is
Silero VAD (MIT, repo last pushed 2026-08-24).

## 6. Proposed local evaluation matrix — NOT executed

Test sets, recorded locally by the team (synthetic prompts only, no personal transcripts):

| ID | Set | Examples / purpose |
|---|---|---|
| T1 | Short Korean commands (1–4 s) | "루프 시작", "루프 멈춰", "다시 시작해", "진행 상황 알려줘" |
| T2 | Korean–English code-switch with tech vocabulary | "PR 1152 리뷰해줘", "package.json 열어줘", "git rebase 해줘" |
| T3 | Filenames / numbers / paths | "docs/reports 2026-09-11 파일", "태스크 1153", "v1.13.8" |
| T4 | Headset conditions | Bluetooth HFP narrow- vs wide-band, wired headset; quiet / street / café noise |
| T5 | Non-speech | 30 s silence, breathing, keyboard, background TV → hallucination check |
| T6 | Public anchors | FLEURS-ko test subset (KsponSpeech eval only if its licence is cleared) to sanity-check against author numbers |

| Config | Description | Where |
|---|---|---|
| S1 | Qwen3-ASR-1.7B, vLLM streaming, 2.0 s chunk, `unfixed_chunk_num` 2 vs 4, ± `context` (command/file vocabulary), language auto vs `Korean` | server GPU |
| S2 | Qwen3-ASR-0.6B, same | server GPU |
| S3 | Voxtral RT, delay 480 ms and 960 ms | server GPU ≥16 GB |
| S4 | Whisper large-v3-turbo, faster-whisper + Silero VAD, ± `hotwords` (baseline) | server GPU/CPU |
| S5 | Cohere Transcribe, language `ko`, + VAD (offline second opinion) | server GPU |
| S6 | Fun-ASR-MLT-Nano, ± hotwords | server GPU |
| M1 | SenseVoice-Small int8, sherpa-onnx, VAD-segmented | Android device |
| M2 | Zipformer-ko streaming int8, sherpa-onnx, greedy vs modified beam, ± hotwords (only after licence clearance) | Android device |
| M3 | Qwen3-ASR-0.6B int8, sherpa-onnx, VAD-segmented, ± hotwords | Android device |

- Metrics:
  - Korean CER, with normalisation rules fixed up front
  - command-intent exact match (T1/T2) and entity exact match for filenames, numbers and paths (T2/T3)
  - non-speech false text in characters per minute (T5)
  - first-partial and final-after-endpoint latency, p50/p95
  - number of partial revisions, RTF, peak RAM/VRAM
  - battery and thermal on M-configs
- Hardware log, per run:
  - server: GPU model, precision, batch/concurrency, chunk/delay, runtime version
  - device: SoC, threads, int8/fp32, runtime version
- Decision rule (proposal): for the server, take the config with the lowest intent/entity error among those
  inside the latency budget #1152 sets. For mobile, screen on T5 false-text rate first, then intent
  accuracy. Thresholds are for the orchestrator / #1152 to set; none is proposed here as a measured fact.

## 7. Exclusions (verified reason)

| Model | Reason |
|---|---|
| NVIDIA `parakeet-tdt-0.6b-v3` (CC-BY-4.0, 2025-08-14) and `canary-1b-v2` | 25 European languages; Korean not listed (card list / HF `language` metadata) |
| Kyutai `stt-1b-en_fr`, `stt-2.6b-en` (weights CC-BY 4.0) | English/French and English only |
| Moonshine Korean Tiny (`moonshine-tiny-ko`, 26–27M) | non-streaming; the Moonshine LICENSE puts "Korean Base, Tiny" under the **non-commercial** Community License; docs: "Korean and Ukrainian have no streaming model yet"; keyterm biasing works on streaming architectures only (older Tiny/Base "raise an error"). Author-reported FLEURS CER 8.9 (card) — research reference only |
| Microsoft `VibeVoice-ASR` (MIT, 8,674,021,857 BF16, arXiv 2601.18184) | `ko` appears in card metadata and hotwords/code-switching are claimed, but it is a heavy offline 60-minute long-form model with no Korean number surfaced — a poor fit for a short-command phone loop (a possible later option for offline meeting transcription) |
| Meta Omnilingual ASR (Apache-2.0, 300M–7B) | `kor_Hang` is listed, but CTC/LLM suites accept only audio "shorter than 40 seconds", no streaming is documented, and no Korean CER was extracted |
| Fun-ASR-Nano-2512 (base) | Chinese / English / Japanese only; Korean needs the MLT checkpoint (5b) |
| Not investigated (budget) | Dolphin (DataoceanAI), OWSM, GLM-ASR-Nano-2512, community Korean Whisper fine-tunes; commercial APIs are out of scope |

## 8. Gaps and inaccessible sources (exact)

- `https://huggingface.co/CohereLabs/cohere-transcribe-03-2026/raw/main/README.md` returned "Access to
  model CohereLabs/cohere-transcribe-03-2026 is restricted. You must have access to it and be
  authenticated to access it." The rendered card page and the HF blog were used instead. The Korean
  per-language value exists only in a figure and was not extracted.
- AI Hub KsponSpeech (`https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=123`): only the
  domestic-applicant notice is visible; licence and usage terms need login/approval → unknown. A
  web-search summary attributing a "no commercial use" clause to KsponSpeech came from the licence of
  **KeSpeech**, a different dataset, and was **not used**.
- `https://moonshine-voice.readthedocs.io/en/latest/models.html` returned HTTP 404, and `/models/`
  rendered without its tables. The docs sources in the GitHub repo were used instead
  (`docs/models/available-models.md`, `docs/models/accuracy.md`, `LICENSE`).
- Voxtral Realtime paper: only the abstract page was reviewed, so latency hardware is not established.
- Whisper large-v3 Korean FLEURS value: an image in the GitHub README, not extracted.
- Open ASR Leaderboard multilingual track (blog 2025-11-21): the fetched text says "five languages"
  without naming them → Korean coverage unknown; not used.
- SenseVoice-Small parameter count is not stated on the card.
- Method note: one WebFetch summary misread Voxtral's Korean column (it returned the Japanese values).
  Corrected from the raw HF README table (lines 92–100). Qwen Table A.2, the icefall results, the
  Moonshine card/LICENSE and the sherpa-onnx release notes were likewise read from raw files, not
  summaries.

## 9. Source ledger (all retrieved 2026-09-11)

Qwen3-ASR
- https://github.com/QwenLM/Qwen3-ASR — README: languages, streaming limits, news dates
- https://github.com/QwenLM/Qwen3-ASR/blob/main/examples/example_qwen3_asr_vllm_streaming.py
- `qwen_asr/inference/qwen3_asr.py` in the same repo — the `context` argument
- https://huggingface.co/Qwen/Qwen3-ASR-1.7B · https://huggingface.co/Qwen/Qwen3-ASR-0.6B
- https://arxiv.org/abs/2601.21337 · https://arxiv.org/html/2601.21337v2 — Tables 1, 2, 5, 8, A.2 and the metric definition

Voxtral
- https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- https://mistral.ai/news/voxtral-transcribe-2/
- https://arxiv.org/abs/2602.11298

Whisper and runtimes
- https://huggingface.co/openai/whisper-large-v3 · https://huggingface.co/openai/whisper-large-v3-turbo
- https://github.com/openai/whisper — README licence section and `whisper/tokenizer.py`
- https://github.com/SYSTRAN/faster-whisper — README, `faster_whisper/transcribe.py`, release v1.2.1
- https://github.com/ggml-org/whisper.cpp — README, release v1.9.4
- https://github.com/snakers4/silero-vad — licence via the GitHub API

Cohere Transcribe
- https://huggingface.co/CohereLabs/cohere-transcribe-03-2026 — rendered card, gated
- https://huggingface.co/blog/CohereLabs/cohere-transcribe-03-2026-release

FunAudioLLM
- https://github.com/FunAudioLLM/SenseVoice · https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
- https://github.com/FunAudioLLM/Fun-ASR · https://huggingface.co/FunAudioLLM/Fun-ASR-MLT-Nano-2512

k2-fsa
- https://github.com/k2-fsa/sherpa-onnx — README; releases v1.12.16 → v1.13.8 via the GitHub API
- https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html
- https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html
- https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html
- https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
- https://github.com/k2-fsa/icefall/blob/master/egs/ksponspeech/ASR/RESULTS.md
- https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16 — HF API; no licence field
- https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=123

Moonshine
- https://github.com/moonshine-ai/moonshine — README, `LICENSE`, `docs/models/*.md`, release v0.1.5 (2026-08-24)
- https://huggingface.co/UsefulSensors/moonshine-tiny-ko (resolves to `moonshine-ai/moonshine-tiny-ko`, rev `80995f09a2`)

Exclusions and landscape
- https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 · https://huggingface.co/nvidia/canary-1b-v2 (HF API)
- https://github.com/kyutai-labs/delayed-streams-modeling
- https://huggingface.co/microsoft/VibeVoice-ASR
- https://github.com/facebookresearch/omnilingual-asr
- https://huggingface.co/blog/open-asr-leaderboard

## 10. Self-review

- Every number in §2–§5 traces to a §9 source. Accuracy numbers are author-reported. Speed numbers carry
  their stated conditions, and hardware is marked unknown wherever the source omits it.
- Korean support was checked at model/weight level: a model language table, card metadata, the
  tokenizer, or a Korean-trained checkpoint. Generic "multilingual" claims were not accepted.
- English-only or European-only leaders (Parakeet, Canary, Kyutai) are excluded, not assumed to cover Korean.
- No release after 2026-09-11 is referenced. The newest artifacts are whisper.cpp v1.9.4 (2026-09-11)
  and sherpa-onnx v1.13.8 (2026-09-10).
- Nothing was downloaded, installed, benchmarked or launched. Snyk: N/A (documentation only).
