import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';
import { saveBuffer } from './storage.service.js';
import { prisma } from '../db/prisma.js';

const SARVAM_BASE = 'https://api.sarvam.ai';

// ~15 chars/sec ≈ 150 wpm. Used to bill AI talk-time — stable whether the clip
// was freshly synthesized or served from cache.
export function estimateSpeechSeconds(text) {
  return Math.max(1, Math.round((text || '').length / 15));
}

// Sarvam validates the DECLARED content-type against an allowlist, then
// auto-detects the real codec from the bytes (their docs: WAV, MP3, AAC,
// MP4/M4A, AMR, WebM... all supported). Android recordings arrive as m4a,
// but the colloquial label "audio/m4a" is NOT in the allowlist — the correct
// IANA label for .m4a is audio/mp4, which is. Normalize the LABEL here so
// every client build, past and future, passes validation; never touch bytes.
function sarvamMime(mimetype = '', filename = '') {
  const mt = String(mimetype).toLowerCase();
  const fn = String(filename).toLowerCase();
  if (mt.includes('m4a') || mt === 'audio/mp4' || fn.endsWith('.m4a') || fn.endsWith('.mp4')) {
    return { type: 'audio/mp4', name: 'turn.mp4' };
  }
  if (mt.includes('wav') || fn.endsWith('.wav')) return { type: 'audio/wav', name: 'turn.wav' };
  if (mt.includes('mpeg') || mt.includes('mp3') || fn.endsWith('.mp3')) return { type: 'audio/mp3', name: 'turn.mp3' };
  if (mt.includes('aac') || fn.endsWith('.aac')) return { type: 'audio/aac', name: 'turn.aac' };
  return { type: 'audio/wav', name: 'turn.wav' }; // proven-safe: label passes, codec auto-detected
}

// --- Speech to text (Saaras v3) ---
export async function transcribe(audioBuffer, { filename = 'turn.m4a', mimetype = 'audio/m4a' } = {}) {
  if (config.mockExternal || !config.sarvam.apiKey) {
    return { text: '(mock) I go to market yesterday for buy vegetable.' };
  }
  const norm = sarvamMime(mimetype, filename);
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: norm.type }), norm.name);
  form.append('model', config.sarvam.sttModel);
  form.append('mode', 'transcribe');
  if (config.sarvam.langCode) form.append('language_code', config.sarvam.langCode);

  const res = await withTimeout(
    fetch(`${SARVAM_BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': config.sarvam.apiKey },
      body: form,
    }),
    { label: 'sarvam stt' }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sarvam STT ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { text: (data.transcript || '').trim() };
}

// --- Text to speech (Bulbul v3) with a GLOBAL phrase cache ---
// Repeated phrases (greetings, "try again", stock corrections) synthesize once
// and are served from S3 forever after — the biggest cost saver in the cascade.
export async function synthesize(text) {
  const clean = (text || '').trim();
  if (!clean) return null;

  const hash = crypto
    .createHash('sha1')
    .update(`${config.sarvam.ttsModel}|${config.sarvam.ttsSpeaker}|${config.sarvam.ttsLang}|${config.sarvam.ttsRate}|${clean}`)
    .digest('hex');

  const cached = await prisma.voiceTtsCache.findUnique({ where: { hash } }).catch(() => null);
  if (cached) return { url: cached.url, seconds: cached.seconds, cached: true };

  const seconds = estimateSpeechSeconds(clean);

  if (config.mockExternal || !config.sarvam.apiKey) {
    const { url } = await saveBuffer(silentWav(), { folder: 'tts', ext: 'wav' });
    await cachePut(hash, url, seconds);
    return { url, seconds, cached: false };
  }

  const tSyn0 = Date.now();
  const res = await withTimeout(
    fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: 'POST',
      headers: {
        'api-subscription-key': config.sarvam.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: clean,
        target_language_code: config.sarvam.ttsLang,
        model: config.sarvam.ttsModel,
        speaker: config.sarvam.ttsSpeaker,
        speech_sample_rate: config.sarvam.ttsRate,
      }),
    }),
    { label: 'sarvam tts' }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Sarvam TTS ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const b64 = Array.isArray(data.audios) ? data.audios.join('') : data.audios;
  if (!b64) throw new Error('Sarvam TTS returned no audio');
  const wav = Buffer.from(b64, 'base64');
  const tSyn1 = Date.now();
  const { url } = await saveBuffer(wav, { folder: 'tts', ext: 'wav' });
  console.log(`[voice:tts] synth=${tSyn1 - tSyn0}ms store=${Date.now() - tSyn1}ms bytes=${wav.length}`);
  await cachePut(hash, url, seconds);
  return { url, seconds, cached: false };
}

async function cachePut(hash, url, seconds) {
  await prisma.voiceTtsCache.create({ data: { hash, url, seconds } }).catch(() => {});
}

// Minimal valid 100ms silent WAV (24kHz mono 16-bit) for mock mode.
function silentWav() {
  const sampleRate = 24000, ms = 100;
  const samples = Math.round((sampleRate * ms) / 1000);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}