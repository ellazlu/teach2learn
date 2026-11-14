/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict mode mounts components twice in development, which would start the
  // microphone and the avatar's voice twice. Off to keep dev behaving like prod.
  reactStrictMode: false,
  // The coach loads these at runtime (lib/coach/agent.ts) and falls back if
  // they're missing, so keep them out of the server bundle.
  serverExternalPackages: ['deepagents', 'langchain', '@langchain/core', '@langchain/anthropic', '@langchain/langgraph'],
};
export default nextConfig;
