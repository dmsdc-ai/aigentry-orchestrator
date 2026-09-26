import { type CommandResult, type Workspace } from './store.js';
export interface HostFence {
    token: string;
    generation: number;
}
/** One owned child, capped combined output and total lifetime; await close after
 * killing only that child. No process scan, shell, provider or descendant work. */
export declare function boundedTick(workspace: Workspace, trigger: 'manual' | 'host', fence?: HostFence | null, releaseId?: string): Promise<{
    exit: number;
    result: CommandResult;
}>;
export declare function boundedMeasure(workspace: Workspace, limitsFile: string, releaseId?: string): Promise<{
    exit: number;
    result: CommandResult;
}>;
export declare function ensureHost(workspace: Workspace): Promise<CommandResult>;
export declare function stopHost(workspace: Workspace, requestId: string, expected: number): Promise<CommandResult>;
export declare function runHost(workspace: Workspace): Promise<void>;
