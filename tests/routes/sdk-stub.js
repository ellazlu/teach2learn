// Stand-in for @anthropic-ai/sdk: records calls, returns scripted replies.
export default class Anthropic {
  constructor() {
    this.messages = {
      create: async (params) => {
        globalThis.__sdkCalls.push(params);
        const reply = globalThis.__sdkReply(params);
        if (reply instanceof Error) throw reply;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
      },
      stream: (params) => {
        globalThis.__sdkCalls.push(params);
        const chunks = globalThis.__streamChunks || [];
        let aborted = false;
        return {
          abort() { aborted = true; globalThis.__streamAborted = true; },
          async *[Symbol.asyncIterator]() {
            yield { type: 'message_start' };
            for (const c of chunks) {
              if (aborted) return;
              await new Promise((r) => setTimeout(r, 5));
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } };
            }
            yield { type: 'message_stop' };
          },
        };
      },
    };
  }
}
