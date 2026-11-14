import Anthropic from '@anthropic-ai/sdk';

export const MODELS = {
  smart: process.env.SMART_MODEL || 'claude-sonnet-5-5', // extraction + feedback
  fast: process.env.FAST_MODEL || 'claude-haiku-5-5', // live evaluation + dialogue
};

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key.');
  }
  client ??= new Anthropic();
  return client;
}

// Structured outputs require every object in the schema to say
// additionalProperties: false, so we add it everywhere.
function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = strictSchema(v);
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// Calls the model with structured outputs (output_config.format), so the reply
// is guaranteed to be JSON matching `schema`.
export async function callJSON({ model, system, content, schema, maxTokens }) {
  const res = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: strictSchema(schema) } },
  });
  if (res.stop_reason === 'max_tokens') {
    throw new Error('The AI response was cut off. Try less material or a shorter session.');
  }
  if (res.stop_reason === 'refusal') {
    throw new Error('The AI declined to process this material. Try different material.');
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The AI returned malformed output. Please try again.');
  }
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
