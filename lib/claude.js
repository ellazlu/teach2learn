import Anthropic from '@anthropic-ai/sdk';

export const MODELS = {
  smart: process.env.SMART_MODEL || 'claude-sonnet-5-5', // prep + grading
  fast: process.env.FAST_MODEL || 'claude-haiku-5-5', // live note-taker
};

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key.');
  }
  client ??= new Anthropic();
  return client;
}

// Calls the model and forces it to answer through `tool`, so we always get JSON
// that matches the tool's input_schema.
export async function callTool({ model, system, content, tool, maxTokens }) {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  if (res.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off. Try less material or a shorter session.');
  }
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('The AI did not return structured output. Please try again.');
  return block.input;
}

// Turns uploaded sources into Claude content blocks. PDFs go in natively
// (no text extraction needed); images too; text is wrapped in tags.
export function sourcesToBlocks(sources) {
  const blocks = [];
  for (const s of sources) {
    if (s.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: s.data },
        title: s.name,
      });
    } else if (s.kind === 'image') {
      blocks.push({ type: 'text', text: `Source "${s.name}" (image):` });
      blocks.push({ type: 'image', source: { type: 'base64', media_type: s.mediaType, data: s.data } });
    } else {
      blocks.push({ type: 'text', text: `<source name="${s.name}">\n${s.data}\n</source>` });
    }
  }
  return blocks;
}
