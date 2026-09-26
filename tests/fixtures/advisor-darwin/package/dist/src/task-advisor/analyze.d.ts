import { type AnalysisInputV2, type ConfigV2, type ProposalV2 } from './contracts.js';
export declare function improvementKey(workspace: string, release: string, target: string): string;
/** Internal deterministic engine. Only cli.tick calls it after store.reserve has
 * committed; a structurally valid input alone is not authority to call it. */
export declare function analyzeReserved(input: AnalysisInputV2, config: ConfigV2, trigger: 'manual' | 'host', packageVersion: string, deadline: number, suppressed?: ReadonlySet<string>): ProposalV2[];
