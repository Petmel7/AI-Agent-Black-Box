import { createHash, randomUUID } from 'node:crypto';

export const CODEX_JSONL_LIMITS = Object.freeze({
  acceptedObservations: 10_000,
  bufferedBytes: 2_000_000,
  diagnostics: 8,
  lineBytes: 1_000_000,
  nativeIdentities: 5_000,
  operations: 2_000,
});

type Outcome = 'cancelled' | 'failed' | 'succeeded' | 'unknown';

export interface CodexAdapterSink {
  commandFinished(input: {
    commandId: string;
    durationMs?: number;
    exitCode?: number;
    nativeEventId: string;
    nativeSessionId: string;
    occurredAt?: string;
    outcome: Outcome;
    stderr?: Uint8Array;
    stdout?: Uint8Array;
    terminationSignal?: string;
  }): void;
  commandStarted(input: {
    command: Uint8Array;
    commandId: string;
    nativeEventId: string;
    nativeSessionId: string;
    occurredAt?: string;
    workingDirectory?: Uint8Array;
  }): void;
  diagnostic(code: CodexDiagnosticCode, nativeSessionId?: string): void;
  errorObserved(input: {
    code: 'codex-provider-error' | 'codex-turn-failed';
    message?: Uint8Array;
    nativeEventId?: string;
    nativeSessionId: string;
    occurredAt?: string;
    relatedOperationId?: string;
    retryable?: boolean;
  }): void;
  fileChangeCompleted(input: {
    nativeEventId: string;
    nativeSessionId: string;
    occurredAt?: string;
    toolCallId: string;
  }): void;
  requestCheckpoint(): void;
  toolFinished(input: {
    durationMs?: number;
    nativeEventId: string;
    nativeSessionId: string;
    occurredAt?: string;
    outcome: Outcome;
    output?: Uint8Array;
    toolCallId: string;
    toolName: string;
  }): void;
  toolStarted(input: {
    input?: Uint8Array;
    nativeEventId: string;
    nativeSessionId: string;
    occurredAt?: string;
    toolCallId: string;
    toolName: string;
  }): void;
  usageObserved(input: {
    cachedInputTokens?: number;
    inputTokens?: number;
    model?: string;
    nativeSessionId: string;
    occurredAt?: string;
    outputTokens?: number;
    reasoningTokens?: number;
  }): void;
}

export type CodexDiagnosticCode =
  | 'codex-adapter-bound-reached'
  | 'codex-adapter-conflict'
  | 'codex-adapter-invalid-json'
  | 'codex-adapter-invalid-utf8'
  | 'codex-adapter-lifecycle'
  | 'codex-adapter-missing-thread'
  | 'codex-adapter-unsupported'
  | 'codex-checkpoint-abandoned'
  | 'codex-checkpoint-failed';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function boundedString(value: unknown, maximum = 256): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /(?:Z|[+-]\d\d:\d\d)$/u.test(value)
    ? new Date(parsed).toISOString()
    : undefined;
}

function contentBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value === undefined) return undefined;
  try {
    return Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

function textBytes(value: unknown): Uint8Array | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : undefined;
}

function outcome(item: JsonRecord): Outcome {
  const status = item.status;
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  const exitCode = safeInteger(item.exit_code);
  if (exitCode !== undefined) return exitCode === 0 ? 'succeeded' : 'failed';
  if (status === 'completed') return 'succeeded';
  return 'unknown';
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function toolName(item: JsonRecord): string | undefined {
  if (item.type === 'web_search') return 'web-search';
  if (item.type !== 'mcp_tool_call') return undefined;
  const server = boundedString(item.server, 96);
  const tool = boundedString(item.tool, 128);
  if (!server || !tool) return undefined;
  return `mcp:${server}/${tool}`.slice(0, 128);
}

export class CodexJsonlAdapter {
  readonly #sink: CodexAdapterSink;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #seen = new Map<string, string>();
  readonly #operations = new Map<string, string>();
  readonly #lifecycles = new Map<
    string,
    { state: 'completed' | 'started'; type: string }
  >();
  #buffer = '';
  #bufferBytes = 0;
  #disabled = false;
  #degraded = false;
  #diagnostics = 0;
  #observations = 0;
  #sessionId: string | undefined;
  #turnActive = false;
  #turnOrdinal = 0;
  #lastTurnTerminal:
    { digest: string; type: 'turn.completed' | 'turn.failed' } | undefined;

  constructor(sink: CodexAdapterSink) {
    this.#sink = sink;
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  push(chunk: Uint8Array): void {
    if (this.#disabled) return;
    if (
      this.#bufferBytes + chunk.byteLength >
      CODEX_JSONL_LIMITS.bufferedBytes
    ) {
      this.#degrade('codex-adapter-bound-reached');
      return;
    }
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch {
      this.#degrade('codex-adapter-invalid-utf8');
      return;
    }
    this.#buffer += decoded;
    this.#bufferBytes += chunk.byteLength;
    this.#drainLines(false);
  }

  finish(): void {
    if (this.#disabled) return;
    try {
      this.#buffer += this.#decoder.decode();
    } catch {
      this.#degrade('codex-adapter-invalid-utf8');
      return;
    }
    this.#drainLines(true);
  }

  transportFailure(): void {
    if (!this.#disabled) this.#degrade('codex-adapter-lifecycle');
  }

  #diagnose(code: CodexDiagnosticCode): void {
    this.#degraded = true;
    if (this.#diagnostics >= CODEX_JSONL_LIMITS.diagnostics) return;
    this.#diagnostics += 1;
    try {
      this.#sink.diagnostic(code, this.#sessionId);
    } catch {
      /* Telemetry failure never affects transport draining. */
    }
  }

  #degrade(code: CodexDiagnosticCode): void {
    this.#disabled = true;
    this.#buffer = '';
    this.#bufferBytes = 0;
    this.#diagnose(code);
  }

  #acceptSemanticObservation(
    type: string,
    nativeIdentity: string | undefined,
    value: unknown,
    identityNamespace = 'provider-native',
  ): boolean {
    const semanticDigest = this.#semanticDigest(type, value);
    const observationKey = nativeIdentity
      ? `${identityNamespace}:${nativeIdentity}`
      : `turn:${this.#turnOrdinal}:${type}:anonymous:${semanticDigest}`;
    const previous = this.#seen.get(observationKey);
    if (previous === semanticDigest) return false;
    if (previous) {
      this.#diagnose('codex-adapter-conflict');
      return false;
    }
    if (this.#seen.size >= CODEX_JSONL_LIMITS.nativeIdentities) {
      this.#degrade('codex-adapter-bound-reached');
      return false;
    }
    this.#seen.set(observationKey, semanticDigest);
    return true;
  }

  #semanticDigest(type: string, value: unknown): string {
    return digest(Buffer.from(JSON.stringify({ type, value }), 'utf8'));
  }

  #startTurn(): void {
    if (this.#turnActive) {
      this.#diagnose('codex-adapter-lifecycle');
      return;
    }
    this.#turnOrdinal += 1;
    this.#turnActive = true;
  }

  #requireActiveTurn(): boolean {
    if (this.#turnActive) return true;
    this.#diagnose('codex-adapter-lifecycle');
    return false;
  }

  #acceptTurnTerminal(
    type: 'turn.completed' | 'turn.failed',
    value: unknown,
  ): boolean {
    const semanticDigest = this.#semanticDigest(type, value);
    if (!this.#turnActive) {
      if (
        this.#lastTurnTerminal?.type === type &&
        this.#lastTurnTerminal.digest === semanticDigest
      )
        return false;
      this.#diagnose(
        this.#lastTurnTerminal?.type === type
          ? 'codex-adapter-conflict'
          : 'codex-adapter-lifecycle',
      );
      return false;
    }
    this.#turnActive = false;
    this.#lastTurnTerminal = {
      digest: semanticDigest,
      type,
    };
    return true;
  }

  #drainLines(final: boolean): void {
    while (!this.#disabled) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#bufferBytes = Buffer.byteLength(this.#buffer);
      this.#acceptLine(line);
    }
    if (!this.#disabled && this.#bufferBytes > CODEX_JSONL_LIMITS.lineBytes)
      this.#degrade('codex-adapter-bound-reached');
    if (final && !this.#disabled && this.#buffer.length > 0) {
      const line = this.#buffer.replace(/\r$/u, '');
      this.#buffer = '';
      this.#bufferBytes = 0;
      this.#acceptLine(line);
    }
  }

  #acceptLine(line: string): void {
    if (line.length === 0) return;
    if (Buffer.byteLength(line) > CODEX_JSONL_LIMITS.lineBytes) {
      this.#degrade('codex-adapter-bound-reached');
      return;
    }
    if (++this.#observations > CODEX_JSONL_LIMITS.acceptedObservations) {
      this.#degrade('codex-adapter-bound-reached');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#degrade('codex-adapter-invalid-json');
      return;
    }
    const envelope = record(value);
    const type = boundedString(envelope?.type, 64);
    if (!envelope || !type) {
      this.#diagnose('codex-adapter-unsupported');
      return;
    }
    this.#map(envelope, type);
  }

  #map(envelope: JsonRecord, type: string): void {
    if (type === 'thread.started') {
      const candidate = boundedString(envelope.thread_id, 128);
      if (!candidate) return this.#diagnose('codex-adapter-lifecycle');
      if (this.#sessionId && this.#sessionId !== candidate)
        return this.#diagnose('codex-adapter-conflict');
      this.#sessionId = candidate;
      return;
    }
    if (!this.#sessionId) {
      this.#diagnose('codex-adapter-missing-thread');
      return;
    }
    if (type === 'turn.started') {
      this.#startTurn();
      return;
    }
    let occurredAt = timestamp(envelope.timestamp);
    if (type === 'error' || type === 'turn.failed') {
      if (type === 'error' && !this.#requireActiveTurn()) return;
      const nativeEventId =
        boundedString(envelope.id, 128) ?? boundedString(envelope.turn_id, 128);
      const failure = record(envelope.error);
      if (type === 'turn.failed' && !failure) {
        if (this.#acceptTurnTerminal(type, { malformed: true }))
          this.#diagnose('codex-adapter-lifecycle');
        return;
      }
      const rawMessage = type === 'error' ? envelope.message : failure?.message;
      if (rawMessage !== undefined && typeof rawMessage !== 'string')
        return this.#diagnose('codex-adapter-lifecycle');
      const message = textBytes(rawMessage);
      const retryable =
        typeof failure?.retryable === 'boolean'
          ? failure.retryable
          : typeof envelope.retryable === 'boolean'
            ? envelope.retryable
            : undefined;
      const semanticValue = {
        occurredAt,
        message: rawMessage,
        retryable,
      };
      if (
        type === 'turn.failed' &&
        !this.#acceptTurnTerminal(type, semanticValue)
      )
        return;
      if (!this.#acceptSemanticObservation(type, nativeEventId, semanticValue))
        return;
      this.#sink.errorObserved({
        code: type === 'error' ? 'codex-provider-error' : 'codex-turn-failed',
        ...(message ? { message } : {}),
        ...(nativeEventId ? { nativeEventId } : {}),
        nativeSessionId: this.#sessionId,
        ...(occurredAt ? { occurredAt } : {}),
        ...(retryable === undefined ? {} : { retryable }),
      });
      return;
    }
    if (type === 'turn.completed') {
      const usage = record(envelope.usage);
      if (!usage) {
        if (this.#acceptTurnTerminal(type, { malformed: true }))
          this.#diagnose('codex-adapter-lifecycle');
        return;
      }
      const cachedInputTokens = safeInteger(usage.cached_input_tokens);
      const inputTokens = safeInteger(usage.input_tokens);
      const outputTokens = safeInteger(usage.output_tokens);
      const reasoningTokens = safeInteger(
        usage.reasoning_tokens ?? usage.reasoning_output_tokens,
      );
      const model =
        boundedString(usage.model, 128) ?? boundedString(envelope.model, 128);
      const nativeIdentity =
        boundedString(envelope.id, 128) ?? boundedString(envelope.turn_id, 128);
      const semanticValue = {
        cachedInputTokens,
        inputTokens,
        model,
        occurredAt,
        outputTokens,
        reasoningTokens,
      };
      if (!this.#acceptTurnTerminal(type, semanticValue)) return;
      if (!this.#acceptSemanticObservation(type, nativeIdentity, semanticValue))
        return;
      this.#sink.usageObserved({
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(model ? { model } : {}),
        nativeSessionId: this.#sessionId,
        ...(occurredAt ? { occurredAt } : {}),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      });
      return;
    }
    if (type !== 'item.started' && type !== 'item.completed') {
      this.#diagnose('codex-adapter-unsupported');
      return;
    }
    if (!this.#requireActiveTurn()) return;
    const item = record(envelope.item);
    const id = boundedString(item?.id, 128);
    const itemType = boundedString(item?.type, 64);
    if (!item || !id || !itemType)
      return this.#diagnose('codex-adapter-lifecycle');
    occurredAt = timestamp(item.timestamp) ?? occurredAt;
    if (
      itemType === 'reasoning' ||
      itemType === 'agent_message' ||
      itemType === 'plan_update'
    )
      return;
    if (
      !this.#acceptSemanticObservation(
        type,
        id,
        {
          phase: type,
          itemType,
          occurredAt,
          command: item.command,
          cwd: item.cwd,
          status: item.status,
          exitCode: item.exit_code,
          durationMs: item.duration_ms,
          signal: item.signal,
          stderr: item.stderr,
          stdout: item.stdout,
          aggregatedOutput: item.aggregated_output,
          server: item.server,
          tool: item.tool,
          arguments: item.arguments,
          result: item.result,
          output: item.output,
          error: item.error,
          query: item.query,
        },
        `item:${type}`,
      )
    )
      return;
    if (
      ![
        'command_execution',
        'mcp_tool_call',
        'web_search',
        'file_change',
      ].includes(itemType)
    )
      return this.#diagnose('codex-adapter-unsupported');
    const phase = type === 'item.started' ? 'started' : 'completed';
    const lifecycle = this.#lifecycles.get(id);
    if (lifecycle?.type !== undefined && lifecycle.type !== itemType)
      return this.#diagnose('codex-adapter-conflict');
    if (lifecycle?.state === 'completed' && phase === 'started')
      return this.#diagnose('codex-adapter-lifecycle');
    this.#lifecycles.set(id, { state: phase, type: itemType });
    let operationId = this.#operations.get(id);
    if (!operationId) {
      if (this.#operations.size >= CODEX_JSONL_LIMITS.operations)
        return this.#degrade('codex-adapter-bound-reached');
      operationId = randomUUID();
      this.#operations.set(id, operationId);
    }
    if (itemType === 'command_execution') {
      if (type === 'item.started') {
        const command = textBytes(item.command);
        if (item.cwd !== undefined && typeof item.cwd !== 'string')
          return this.#diagnose('codex-adapter-lifecycle');
        const workingDirectory = textBytes(item.cwd);
        if (!command) return this.#diagnose('codex-adapter-lifecycle');
        this.#sink.commandStarted({
          command,
          commandId: operationId,
          nativeEventId: id,
          nativeSessionId: this.#sessionId,
          ...(occurredAt ? { occurredAt } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        });
      } else {
        if (
          (item.stderr !== undefined && typeof item.stderr !== 'string') ||
          (item.stdout !== undefined && typeof item.stdout !== 'string') ||
          (item.aggregated_output !== undefined &&
            typeof item.aggregated_output !== 'string')
        )
          return this.#diagnose('codex-adapter-lifecycle');
        const durationMs = safeInteger(item.duration_ms);
        const exitCode = safeInteger(item.exit_code);
        const stderr = textBytes(item.stderr);
        const stdout = textBytes(item.stdout ?? item.aggregated_output);
        const terminationSignal = boundedString(item.signal, 32);
        this.#sink.commandFinished({
          commandId: operationId,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(exitCode === undefined ? {} : { exitCode }),
          nativeEventId: id,
          nativeSessionId: this.#sessionId,
          ...(occurredAt ? { occurredAt } : {}),
          outcome: outcome(item),
          ...(stderr ? { stderr } : {}),
          ...(stdout ? { stdout } : {}),
          ...(terminationSignal ? { terminationSignal } : {}),
        });
      }
      return;
    }
    const name = itemType === 'file_change' ? 'file-change' : toolName(item);
    if (!name) return this.#diagnose('codex-adapter-lifecycle');
    if (itemType === 'file_change' && type === 'item.started') return;
    if (type === 'item.started') {
      if (itemType === 'web_search' && typeof item.query !== 'string')
        return this.#diagnose('codex-adapter-lifecycle');
      if (
        itemType === 'mcp_tool_call' &&
        item.arguments !== undefined &&
        !record(item.arguments)
      )
        return this.#diagnose('codex-adapter-lifecycle');
      const toolInput = contentBytes(item.arguments ?? item.query);
      this.#sink.toolStarted({
        ...(toolInput ? { input: toolInput } : {}),
        nativeEventId: id,
        nativeSessionId: this.#sessionId,
        ...(occurredAt ? { occurredAt } : {}),
        toolCallId: operationId,
        toolName: name,
      });
      return;
    }
    if (itemType === 'file_change') {
      this.#sink.fileChangeCompleted({
        nativeEventId: id,
        nativeSessionId: this.#sessionId,
        ...(occurredAt ? { occurredAt } : {}),
        toolCallId: operationId,
      });
      this.#sink.requestCheckpoint();
      return;
    }
    const durationMs = safeInteger(item.duration_ms);
    const toolOutput = contentBytes(item.result ?? item.output ?? item.error);
    this.#sink.toolFinished({
      ...(durationMs === undefined ? {} : { durationMs }),
      nativeEventId: id,
      nativeSessionId: this.#sessionId,
      ...(occurredAt ? { occurredAt } : {}),
      outcome: outcome(item),
      ...(toolOutput ? { output: toolOutput } : {}),
      toolCallId: operationId,
      toolName: name,
    });
  }
}
