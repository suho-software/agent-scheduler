import { describe, it, expect, vi } from 'vitest';
import { wrapAnthropic, instrumentStream, wrapOpenAI, instrumentOpenAIStream } from './tracker.js';
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

// ─── instrumentOpenAIStream (unit) ────────────────────────────────────────────

describe('instrumentOpenAIStream', () => {
  async function* makeOpenAIStream(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedTokens = 0,
  ): AsyncGenerator<any> {
    // Content chunks (no usage yet)
    yield { id: 'chatcmpl-1', model, choices: [{ delta: { content: 'Hello' } }], usage: null };
    yield { id: 'chatcmpl-1', model, choices: [{ delta: { content: ' world' } }], usage: null };
    // Final chunk carries usage when stream_options.include_usage = true
    yield {
      id: 'chatcmpl-1',
      model,
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: cachedTokens > 0 ? { cached_tokens: cachedTokens } : undefined,
      },
    };
  }

  it('yields all chunks unchanged', async () => {
    const chunks: any[] = [];
    for await (const c of instrumentOpenAIStream(makeOpenAIStream('gpt-4o', 100, 50), 'unknown', () => {})) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(3);
  });

  it('records usage from final chunk after stream ends', async () => {
    const recorded: UsagePayload[] = [];
    for await (const _ of instrumentOpenAIStream(
      makeOpenAIStream('gpt-4o', 1000, 500),
      'unknown',
      (r) => recorded.push(r),
    )) { /* consume */ }

    expect(recorded).toHaveLength(1);
    expect(recorded[0].provider).toBe('openai');
    expect(recorded[0].model).toBe('gpt-4o');
    expect(recorded[0].inputTokens).toBe(1000);
    expect(recorded[0].outputTokens).toBe(500);
    expect(recorded[0].cacheWriteTokens).toBe(0); // OpenAI has no write cost
    expect(recorded[0].costUsd).toBeGreaterThan(0);
  });

  it('captures cached_tokens from prompt_tokens_details', async () => {
    const recorded: UsagePayload[] = [];
    for await (const _ of instrumentOpenAIStream(
      makeOpenAIStream('gpt-4o', 500, 200, 300),
      'unknown',
      (r) => recorded.push(r),
    )) { /* consume */ }

    expect(recorded[0].cacheReadTokens).toBe(300);
  });

  it('uses model from chunk (overrides fallback)', async () => {
    const recorded: UsagePayload[] = [];
    for await (const _ of instrumentOpenAIStream(
      makeOpenAIStream('gpt-4o-mini', 100, 50),
      'unknown-model',
      (r) => recorded.push(r),
    )) { /* consume */ }

    expect(recorded[0].model).toBe('gpt-4o-mini');
  });

  it('fires onUsage exactly once', async () => {
    const onUsage = vi.fn();
    for await (const _ of instrumentOpenAIStream(makeOpenAIStream('gpt-4o', 100, 50), 'unknown', onUsage)) { /* consume */ }
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});

// ─── wrapOpenAI ───────────────────────────────────────────────────────────────

describe('wrapOpenAI', () => {
  function makeFakeOpenAIClient(streamChunks: any[]) {
    return {
      chat: {
        completions: {
          create: async (params: any) => {
            if (params.stream) {
              async function* gen() { for (const c of streamChunks) yield c; }
              return gen();
            }
            return {
              model: params.model ?? 'gpt-4o',
              usage: { prompt_tokens: 400, completion_tokens: 200, total_tokens: 600 },
              choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
            };
          },
        },
      },
    };
  }

  const streamChunks = [
    { model: 'gpt-4o', choices: [{ delta: { content: 'hi' } }], usage: null },
    {
      model: 'gpt-4o',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 300, total_tokens: 1100 },
    },
  ];

  it('non-streaming records usage from response.usage', async () => {
    const recorded: UsagePayload[] = [];
    const client = makeFakeOpenAIClient([]);
    const wrapped = wrapOpenAI(client, (r) => recorded.push(r));

    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] });

    expect(recorded).toHaveLength(1);
    expect(recorded[0].provider).toBe('openai');
    expect(recorded[0].inputTokens).toBe(400);
    expect(recorded[0].outputTokens).toBe(200);
    expect(recorded[0].costUsd).toBeGreaterThan(0);
  });

  it('streaming records usage after stream is consumed', async () => {
    const recorded: UsagePayload[] = [];
    const client = makeFakeOpenAIClient(streamChunks);
    const wrapped = wrapOpenAI(client, (r) => recorded.push(r));

    const stream = await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true });
    expect(recorded).toHaveLength(0); // not yet consumed

    for await (const _ of stream) { /* consume */ }
    expect(recorded).toHaveLength(1);
    expect(recorded[0].inputTokens).toBe(800);
    expect(recorded[0].outputTokens).toBe(300);
  });

  it('injects stream_options.include_usage into streaming params', async () => {
    let capturedParams: any;
    const client = {
      chat: {
        completions: {
          create: async (params: any) => {
            capturedParams = params;
            async function* gen() { yield { model: 'gpt-4o', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }; }
            return gen();
          },
        },
      },
    };
    const wrapped = wrapOpenAI(client, () => {});
    const stream = await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [], stream: true });
    for await (const _ of stream) { /* consume */ }

    expect(capturedParams.stream_options?.include_usage).toBe(true);
  });
});
