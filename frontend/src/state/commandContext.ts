export interface CommandEnvelope {
  command_id: string;
  idempotency_key: string;
  expected_sequence: number;
  expected_revision: number;
  issued_at: string;
  expires_at: string;
  actor: string;
}

interface AcceptedCommandContext {
  trainingSessionId: string | null;
  runtimeSessionId: string;
  sequence: number;
  stateRevision: number;
}

const COMMAND_EXPIRY_MS = 20_000;
const DEFAULT_ACTOR = 'smart-atc-operator';

let acceptedContext: AcceptedCommandContext | null = null;

export class CommandContextUnavailableError extends Error {
  constructor() {
    super('Live command context is unavailable. Refresh the authoritative snapshot before reviewing and sending this command.');
    this.name = 'CommandContextUnavailableError';
  }
}

export function updateAcceptedCommandContext(context: AcceptedCommandContext): void {
  if (!Number.isSafeInteger(context.sequence) || context.sequence < 0
    || !Number.isSafeInteger(context.stateRevision) || context.stateRevision < 0
    || !context.runtimeSessionId.trim()) {
    acceptedContext = null;
    return;
  }
  acceptedContext = { ...context };
}

export function clearAcceptedCommandContext(): void {
  acceptedContext = null;
}

/**
 * Creates a single-use envelope from the most recently accepted snapshot.
 * Callers must create a fresh envelope per user action and must never retry it
 * automatically after a conflict.
 */
export function createCommandEnvelope(expectedTrainingSessionId: string, actor = DEFAULT_ACTOR): CommandEnvelope {
  if (!acceptedContext || acceptedContext.trainingSessionId !== expectedTrainingSessionId) {
    clearAcceptedCommandContext();
    throw new CommandContextUnavailableError();
  }
  const normalizedActor = actor.trim();
  if (!normalizedActor) throw new Error('Command actor must not be blank.');

  const issuedAt = new Date();
  const nonce = crypto.randomUUID();
  return {
    command_id: `ui:${nonce}`,
    idempotency_key: `ui:${crypto.randomUUID()}`,
    expected_sequence: acceptedContext.sequence,
    expected_revision: acceptedContext.stateRevision,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + COMMAND_EXPIRY_MS).toISOString(),
    actor: normalizedActor.slice(0, 100),
  };
}
