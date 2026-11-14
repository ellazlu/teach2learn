/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict mode mounts components twice in development, which would start the
  // microphone and the avatar's voice twice. Off to keep dev behaving like prod.
  reactStrictMode: false,
};
export default nextConfig;
