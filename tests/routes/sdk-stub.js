export default class Anthropic {
  constructor() {
    this.messages = {
      create: async (params) => {
        globalThis.__sdkCalls.push(params);
        const reply = globalThis.__sdkReply(params);
        if (reply instanceof Error) throw reply;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] };
      },
    };
  }
}
