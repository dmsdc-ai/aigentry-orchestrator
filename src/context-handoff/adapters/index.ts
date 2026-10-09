// #1201 — the adapter registry (SPEC §3.1). A frozen literal: the four transcript adapters with
// their measurement status (PHASE0 P0-1..P0-4: all four measured), and the detect-only stores
// that can only raise the §3.3.3 staleness warning (agy: protobuf, not parsed).
import type { DetectOnlyStore, TranscriptAdapter } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { agyDetector, geminiAdapter } from "./gemini.js";
import { grokAdapter } from "./grok.js";

export const ADAPTERS: readonly TranscriptAdapter[] = Object.freeze([claudeAdapter, codexAdapter, geminiAdapter, grokAdapter]);

export const DETECT_ONLY: readonly DetectOnlyStore[] = Object.freeze([agyDetector]);
