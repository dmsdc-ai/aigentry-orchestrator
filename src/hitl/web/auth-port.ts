import type { IncomingMessage, ServerResponse } from 'node:http';

export type AuthState = 'dependency_unverified' | 'setup_required' | 'ready';
export type Principal = Readonly<{
  id: string;
  credentialId: string;
  sessionId: string;
  expiresAt: number;
}>;
export interface AuthPort {
  status(): Readonly<{ state: AuthState; reason: string | null }>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  authenticate(req: IncomingMessage): Promise<Principal | null>;
  close(): Promise<void>;
}

/** Denies every private read until the separately verified adapter is composed. */
export function unavailableAuth(): AuthPort {
  return {
    status: () => ({ state: 'dependency_unverified', reason: 'dependency_unverified' }),
    handle: async () => false,
    authenticate: async () => null,
    close: async () => {},
  };
}
