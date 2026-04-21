import { describe, it, expect, vi } from 'vitest';
import { wrapAnthropic, instrumentStream } from './tracker.js';
import type { UsageRecord } from './types.js';

type UsagePayload = Omit<UsageRecord, 'id' | 'timestamp'>;

// ─── instrumentStream (unit) ───────────────────────────────────────────────────

describe('instrumentStream', () => {
  /** Build a minimal Anthropic stream event sequence. */
  async function* makeStream(
    model: string,
    inputTokens: number,
    outputTokens: number,
    opts: { cacheRead?: number; cacheWrite?: number } = {},
  ): AsyncGenerator<any> {
    yield {
      type: 'message_start',
      message: {
        model,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheWrite ?? 0,
        },
      },
    };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } };
    yield { type: 'message_stop' };
  }

  it('yields all events unchanged', async () => {
    const recorded: UsagePayload[] = [];
    const events: any[] = [];

    const stream = instrumentStream(
      makeStream('claude-sonnet-4-6', 100, 50),
      'unknown',
      (r) => recorded.push(r),
    );

    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('records usage from message_start + message_delta after stream ends', async () => {
    const recorded: UsagePayload[] = [];

    for await (const _ of instrumentStream(
      makeStream('claude-sonnet-4-6', 1000, 500),
      'unknown',
      (r) => recorded.push(r),
    )) { /* consume */ }

    expect(recorded).toHaveLength(1);
    expect(recorded[0].model).toBe('claude-sonnet-4-6');
    expect(recorded[0].inputTokens).toBe(1000);
    expect(recorded[0].outputTokens).toBe(500);
    expect(recorded[0].costUsd).toBeGreaterThan(0);
  });

  it('captures cache tokens from message_start', async () => {
    const recorded: UsagePayload[] = [];

    for await (const _ of instrumentStream(
      makeStream('claude-sonnet-4-6', 200, 100, { cacheRead: 800, cacheWrite: 50 }),
      'unknown',
      (r) => recorded.push(r),
    )) { /* consume */ }

    expect(recorded[0].cacheReadTokens).toBe(800);
    expect(recorded[0].cacheWriteTokens).toBe(50);
  });

  it('uses fallback model when message_start has no model field', async () => {
    const recorded: UsagePayload[] = [];

    async function* noModelStream(): AsyncGenerator<any> {
      yield { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };
      yield { type: 'message_delta', delta: {}, usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    }

    for await (const _ of instrumentStream(noModelStream(), 'claude-haiku-4-5', (r) => recorded.push(r))) { /* consume */ }

    expect(recorded[0].model).toBe('claude-haiku-4-5');
  });

  it('fires onUsage exactly once even for long streams', async () => {
    const onUsage = vi.fn();

    async function* longStream(): AsyncGenerator<any> {
      yield { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 0 } } };
      for (let i = 0; i < 50; i++) {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } };
      }
      yield { type: 'message_delta', delta: {}, usage: { output_tokens: 50 } };
      yield { type: 'message_stop' };
    }

    for await (const _ of instrumentStream(longStream(), 'unknown', onUsage)) { /* consume */ }

    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});

// ─── wrapAnthropic — streaming path ───────────────────────────────────────────

describe('wrapAnthropic — streaming', () => {
  function makeFakeClient(streamEvents: any[]) {
    return {
      messages: {
        create: async (_params: any) => {
          async function* gen() {
            for (const e of streamEvents) yield e;
          }
          return gen();
        },
      },
    };
  }

  const standardStreamEvents = [
    { type: 'message_start', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } },
    { type: 'message_stop' },
  ];

  it('records correct token counts for a streamed call', async () => {
    const recorded: UsagePayload[] = [];
    const client = makeFakeClient(standardStreamEvents);
    const wrapped = wrapAnthropic(client, (r) => recorded.push(r));

    const stream = await wrapped.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 256, stream: true, messages: [] });
    for await (const _ of stream) { /* consume */ }

    expect(recorded).toHaveLength(1);
    expect(recorded[0].inputTokens).toBe(500);
    expect(recorded[0].outputTokens).toBe(200);
    expect(recorded[0].model).toBe('claude-sonnet-4-6');
  });

  it('does NOT record usage before the stream is consumed', async () => {
    const recorded: UsagePayload[] = [];
    const client = makeFakeClient(standardStreamEvents);
    const wrapped = wrapAnthropic(client, (r) => recorded.push(r));

    await wrapped.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 256, stream: true, messages: [] });
    // Stream returned but not consumed yet
    expect(recorded).toHaveLength(0);
  });

  it('non-streaming calls are unaffected', async () => {
    const recorded: UsagePayload[] = [];
    const client = {
      messages: {
        create: async (_params: any) => ({
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 300, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      },
    };
    const wrapped = wrapAnthropic(client, (r) => recorded.push(r));

    await wrapped.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 256, messages: [] });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].inputTokens).toBe(300);
    expect(recorded[0].outputTokens).toBe(150);
  });
});
