import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_JSONL_LIMITS,
  CodexJsonlAdapter,
  type CodexAdapterSink,
} from './codex-adapter.js';

function sink() {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const target: CodexAdapterSink = {
    commandStarted: (value) => calls.push({ kind: 'command.started', value }),
    commandFinished: (value) => calls.push({ kind: 'command.finished', value }),
    diagnostic: (value) => calls.push({ kind: 'diagnostic', value }),
    errorObserved: (value) => calls.push({ kind: 'error.observed', value }),
    fileChangeCompleted: (value) => calls.push({ kind: 'file-change', value }),
    requestCheckpoint: () => calls.push({ kind: 'checkpoint' }),
    toolFinished: (value) => calls.push({ kind: 'tool.call.finished', value }),
    toolStarted: (value) => calls.push({ kind: 'tool.call.started', value }),
    usageObserved: (value) => calls.push({ kind: 'usage.observed', value }),
  };
  return { calls, target };
}

function fixture(): string {
  return [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'printf secret',
        cwd: '/private/repository',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        aggregated_output: 'done',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.started',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'files',
        tool: 'read',
        arguments: { path: 'README.md' },
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'files',
        tool: 'read',
        result: { ok: true },
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'file-1', type: 'file_change', changes: ['private'] },
    },
    {
      type: 'item.completed',
      item: { id: 'reason-1', type: 'reasoning', text: 'hidden' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join('\r\n');
}

describe('CodexJsonlAdapter', () => {
  it('accepts the documented JSONL compatibility fixture', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    adapter.push(
      readFileSync(
        new URL('./fixtures/codex-exec-documented.jsonl', import.meta.url),
      ),
    );
    adapter.finish();

    expect(observed.calls.map((call) => call.kind)).toEqual([
      'command.finished',
      'usage.observed',
    ]);
    expect(JSON.stringify(observed.calls)).not.toContain(
      'Inspect the repository',
    );
  });

  it('maps supported observations with stable operation linkage and no reasoning', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    adapter.push(Buffer.from(fixture()));
    adapter.finish();

    expect(observed.calls.map((call) => call.kind)).toEqual([
      'command.started',
      'command.finished',
      'tool.call.started',
      'tool.call.finished',
      'file-change',
      'checkpoint',
      'usage.observed',
    ]);
    const started = observed.calls[0]?.value as { commandId: string };
    const finished = observed.calls[1]?.value as { commandId: string };
    expect(finished.commandId).toBe(started.commandId);
    expect(JSON.stringify(observed.calls)).not.toContain('hidden');
    expect(observed.calls.at(-1)?.value).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
    });
  });

  it('has identical semantics across arbitrary UTF-8 chunk boundaries', () => {
    const bytes = Buffer.from(
      `${JSON.stringify({ type: 'thread.started', thread_id: 't-💡' })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'error', message: 'échec 💡' })}`,
    );
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    for (const byte of bytes) adapter.push(Uint8Array.of(byte));
    adapter.finish();

    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0]).toMatchObject({
      kind: 'error.observed',
      value: { nativeSessionId: 't-💡' },
    });
  });

  it('deduplicates exact native observations and diagnoses conflicts', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const started = JSON.stringify({
      type: 'item.started',
      item: { id: 'web-1', type: 'web_search', query: 'first' },
    });
    adapter.push(
      Buffer.from(
        `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n${JSON.stringify({ type: 'turn.started' })}\n${started}\n${started}\n${JSON.stringify({ type: 'item.started', item: { id: 'web-1', type: 'web_search', query: 'conflict' } })}\n`,
      ),
    );
    adapter.finish();

    expect(
      observed.calls.filter((call) => call.kind === 'tool.call.started'),
    ).toHaveLength(1);
    expect(observed.calls).toContainEqual({
      kind: 'diagnostic',
      value: 'codex-adapter-conflict',
    });
  });

  it('deduplicates anonymous replays within one turn', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const providerError = { type: 'error', message: 'same anonymous error' };
    const usage = {
      type: 'turn.completed',
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const lines = [
      { type: 'thread.started', thread_id: 'dedup-thread' },
      { type: 'turn.started' },
      providerError,
      providerError,
      usage,
      usage,
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(
      observed.calls.filter((call) => call.kind === 'error.observed'),
    ).toHaveLength(1);
    expect(
      observed.calls.filter((call) => call.kind === 'usage.observed'),
    ).toHaveLength(1);
    expect(observed.calls.filter((call) => call.kind === 'diagnostic')).toEqual(
      [],
    );
  });

  it('keeps identical anonymous observations from distinct turns', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const providerError = { type: 'error', message: 'same across turns' };
    const usage = {
      type: 'turn.completed',
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    const lines = [
      { type: 'thread.started', thread_id: 'multi-turn' },
      { type: 'turn.started' },
      providerError,
      usage,
      { type: 'turn.started' },
      providerError,
      usage,
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(
      observed.calls.filter((call) => call.kind === 'error.observed'),
    ).toHaveLength(2);
    expect(
      observed.calls.filter((call) => call.kind === 'usage.observed'),
    ).toHaveLength(2);
  });

  it('keeps native ID replay and conflict protection across turns', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const providerError = {
      type: 'error',
      id: 'global-error',
      message: 'first',
    };
    const usage = {
      type: 'turn.completed',
      id: 'global-usage',
      usage: { input_tokens: 4 },
    };
    const lines = [
      { type: 'thread.started', thread_id: 'native-turns' },
      { type: 'turn.started' },
      providerError,
      usage,
      { type: 'turn.started' },
      providerError,
      usage,
      { type: 'turn.started' },
      { ...providerError, message: 'conflict' },
      { ...usage, usage: { input_tokens: 5 } },
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(
      observed.calls.filter((call) => call.kind === 'error.observed'),
    ).toHaveLength(1);
    expect(
      observed.calls.filter((call) => call.kind === 'usage.observed'),
    ).toHaveLength(1);
    expect(
      observed.calls.filter((call) => call.value === 'codex-adapter-conflict'),
    ).toHaveLength(2);
  });

  it('maps web search, provider errors, failed turns, timestamps, and reported usage only', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const lines = [
      { type: 'thread.started', thread_id: 'thread-2' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        timestamp: '2026-09-30T10:00:00Z',
        item: { id: 'web-2', type: 'web_search', query: 'documentation' },
      },
      {
        type: 'item.completed',
        item: { id: 'web-2', type: 'web_search', status: 'completed' },
      },
      {
        type: 'error',
        id: 'error-1',
        message: 'provider unavailable',
        retryable: true,
      },
      {
        type: 'turn.failed',
        error: { message: 'turn failed', retryable: false },
      },
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          reasoning_output_tokens: 2,
          model: 'gpt-test',
        },
      },
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(observed.calls.map((call) => call.kind)).toEqual([
      'tool.call.started',
      'tool.call.finished',
      'error.observed',
      'error.observed',
      'usage.observed',
    ]);
    expect(observed.calls[0]?.value).toMatchObject({
      toolName: 'web-search',
      occurredAt: '2026-09-30T10:00:00.000Z',
    });
    expect(observed.calls[2]?.value).toMatchObject({
      code: 'codex-provider-error',
      retryable: true,
    });
    expect(observed.calls[3]?.value).toMatchObject({
      code: 'codex-turn-failed',
      retryable: false,
    });
    expect(observed.calls[4]?.value).toMatchObject({
      inputTokens: 9,
      outputTokens: 4,
      reasoningTokens: 2,
      model: 'gpt-test',
    });
    expect(observed.calls[4]?.value).not.toHaveProperty('cachedInputTokens');
  });

  it('diagnoses impossible lifecycle and multiple-thread conflicts while continuing supported mapping', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const lines = [
      { type: 'thread.started', thread_id: 'thread-first' },
      { type: 'thread.started', thread_id: 'thread-second' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'web-3', type: 'web_search', status: 'completed' },
      },
      {
        type: 'item.started',
        item: { id: 'web-3', type: 'web_search', query: 'too late' },
      },
      { type: 'future.observation', private: 'must-not-appear' },
      { type: 'turn.completed', usage: { output_tokens: 1 } },
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(observed.calls.map((call) => call.value)).toContain(
      'codex-adapter-conflict',
    );
    expect(observed.calls.map((call) => call.value)).toContain(
      'codex-adapter-lifecycle',
    );
    expect(observed.calls.map((call) => call.kind)).toContain('usage.observed');
    expect(JSON.stringify(observed.calls)).not.toContain('must-not-appear');
  });

  it('diagnoses missing, repeated, and impossible turn transitions safely', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    const lines = [
      { type: 'thread.started', thread_id: 'turn-lifecycle' },
      { type: 'error', message: 'missing turn' },
      { type: 'turn.completed', usage: { output_tokens: 1 } },
      { type: 'turn.started' },
      { type: 'turn.started' },
      { type: 'turn.completed', usage: { output_tokens: 2 } },
      { type: 'turn.failed', error: { message: 'after completion' } },
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'valid failure' } },
    ];
    adapter.push(
      Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`),
    );
    adapter.finish();

    expect(
      observed.calls.filter((call) => call.value === 'codex-adapter-lifecycle'),
    ).toHaveLength(4);
    expect(
      observed.calls.filter((call) => call.kind === 'usage.observed'),
    ).toHaveLength(1);
    expect(
      observed.calls.filter((call) => call.kind === 'error.observed'),
    ).toHaveLength(1);
  });

  it('bounds malformed input without exposing it to diagnostics', () => {
    const observed = sink();
    observed.target.diagnostic = vi.fn((value) =>
      observed.calls.push({ kind: 'diagnostic', value }),
    );
    const adapter = new CodexJsonlAdapter(observed.target);
    adapter.push(Buffer.from('{"private":"sentinel"}\n'));
    adapter.push(Buffer.alloc(CODEX_JSONL_LIMITS.lineBytes + 1, 65));

    expect(adapter.degraded).toBe(true);
    expect(JSON.stringify(observed.calls)).not.toContain('sentinel');
    expect(observed.calls.map((call) => call.value)).toContain(
      'codex-adapter-bound-reached',
    );
  });

  it('fails closed on malformed UTF-8 and observations before thread binding', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    adapter.push(Buffer.from('{"type":"turn.completed","usage":{}}\n'));
    adapter.push(Uint8Array.of(0xc3, 0x28));

    expect(observed.calls.map((call) => call.value)).toEqual([
      'codex-adapter-missing-thread',
      'codex-adapter-invalid-utf8',
    ]);
  });

  it('rejects malformed consumed field shapes without capturing their values', () => {
    const observed = sink();
    const adapter = new CodexJsonlAdapter(observed.target);
    adapter.push(
      Buffer.from(
        `${JSON.stringify({ type: 'thread.started', thread_id: 'strict-thread' })}\n${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'error', message: { private: 'shape-sentinel' } })}\n${JSON.stringify({ type: 'item.started', item: { id: 'strict-command', type: 'command_execution', command: { private: 'shape-sentinel' } } })}\n`,
      ),
    );
    adapter.finish();

    expect(observed.calls.map((call) => call.value)).toEqual([
      'codex-adapter-lifecycle',
      'codex-adapter-lifecycle',
    ]);
    expect(JSON.stringify(observed.calls)).not.toContain('shape-sentinel');
  });
});
