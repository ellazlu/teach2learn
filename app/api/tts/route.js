import { NextResponse } from 'next/server';
import { getLevel } from '../../../lib/levels.ts';

// Natural voice via ElevenLabs (Flash v2.5: built for real-time, low latency),
// streamed through this route so the API key stays on the server.
// Without ELEVENLABS_API_KEY the browser falls back to its best local voice.
export const maxDuration = 30;

// A premade ElevenLabs voice as a default; set your own in .env.local.
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
const YOUNG = new Set(['kindergarten', 'middle']);

function voiceFor(levelId) {
  if (YOUNG.has(levelId) && process.env.ELEVENLABS_VOICE_ID_YOUNG) return process.env.ELEVENLABS_VOICE_ID_YOUNG;
  return process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE;
}

export async function GET() {
  return NextResponse.json({ provider: process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'browser' });
}

export async function POST(req) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return NextResponse.json({ error: 'No ELEVENLABS_API_KEY set.' }, { status: 404 });
  try {
    const { text, levelId } = await req.json();
    if (!String(text || '').trim()) return NextResponse.json({ error: 'No text.' }, { status: 400 });
    const level = getLevel(levelId);
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceFor(level.id)}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: String(text).slice(0, 600),
        model_id: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: level.id === 'kindergarten' ? 0.95 : 1.0 },
      }),
      signal: req.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 200);
      return NextResponse.json({ error: `ElevenLabs ${upstream.status}: ${detail}` }, { status: 502 });
    }
    return new Response(upstream.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err.message || 'TTS failed' }, { status: 500 });
  }
}
