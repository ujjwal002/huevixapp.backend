import { config, languageMeta } from '../config/env.js';
import { saveBuffer } from './storage.service.js';

import { withTimeout } from '../utils/withTimeout.js';

// Generates audio for a card's body (the "listen" feature) and stores it once.
// You cache the result on the Card row, so each card costs TTS exactly once
// regardless of how many users listen — this is your main cost lever.

export async function synthesizeSpeech({ text, targetLanguage }) {
  const meta = languageMeta(targetLanguage);
  if (!meta) throw new Error(`Unsupported target language for TTS: ${targetLanguage}`);

  if (config.mockExternal || !config.azureSpeech.key) {
    // Return a tiny silent-ish placeholder buffer so the pipeline + storage work.
    const placeholder = Buffer.from(`MOCK_AUDIO::${targetLanguage}::${text.slice(0, 24)}`, 'utf-8');
    const { url } = await saveBuffer(placeholder, { folder: 'tts', ext: 'txt' });
    return { url, _mock: true };
  }

  // --- Real Azure TTS call ---
  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeech.key,
    config.azureSpeech.region
  );
  speechConfig.speechSynthesisVoiceName = meta.ttsVoice;
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  const audioBuffer = await withTimeout(
    new Promise((resolve, reject) => {
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
      synthesizer.speakTextAsync(
        text,
        (result) => {
          synthesizer.close();
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve(Buffer.from(result.audioData));
          } else {
            reject(new Error(`TTS failed: ${result.errorDetails || result.reason}`));
          }
        },
        (err) => {
          synthesizer.close();
          reject(err);
        }
      );
    }),
    { label: 'azure tts' }
  );
  const { url } = await saveBuffer(audioBuffer, { folder: 'tts', ext: 'mp3' });
  return { url };
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function synthesizeHindi(
  text,
  {
    voice = config.tutor.hindiVoice,
    pitch = config.tutor.hindiPitch,
    rate = config.tutor.hindiRate,
  } = {}
) {
  const hasEleven = !!(config.elevenLabs.apiKey && config.elevenLabs.voiceId);
  const hasAzure = !!config.azureSpeech.key;

  if (config.mockExternal || (!hasEleven && !hasAzure)) {
    const placeholder = Buffer.from(`MOCK_HINDI_TTS::${text.slice(0, 40)}`, 'utf-8');
    const { url } = await saveBuffer(placeholder, { folder: 'tts', ext: 'txt' });
    return { url, _mock: true };
  }

  // Prefer ElevenLabs (much more natural); fall back to Azure if it errors.
  if (hasEleven) {
    try {
      return await elevenLabsTts(text);
    } catch (err) {
      console.warn('[tutor] ElevenLabs TTS failed; falling back to Azure:', err?.message || err);
      if (!hasAzure) throw err;
    }
  }

  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeech.key,
    config.azureSpeech.region
  );
  speechConfig.speechSynthesisVoiceName = voice;
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  // SSML lets us raise the pitch (a younger / more boyish voice) and nudge the
  // rate, which also makes the read less flat/robotic than plain text.
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="hi-IN">` +
    `<voice name="${voice}"><prosody pitch="${pitch}" rate="${rate}">${escapeXml(text)}</prosody></voice>` +
    `</speak>`;

  const audioBuffer = await withTimeout(
    new Promise((resolve, reject) => {
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
      const closeAnd = (fn, arg) => {
        try {
          synthesizer.close();
        } catch {
          /* noop */
        }
        fn(arg);
      };
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            closeAnd(resolve, Buffer.from(result.audioData));
          } else {
            closeAnd(reject, new Error(`TTS failed: ${result.errorDetails || result.reason}`));
          }
        },
        (err) => closeAnd(reject, err)
      );
    }),
    { ms: config.externalTimeoutMs, label: 'text-to-speech (hindi)' }
  );

  const { url } = await saveBuffer(audioBuffer, { folder: 'tts', ext: 'mp3' });
  return { url };
}

// --- ElevenLabs (natural voice for the tutor) -------------------------------

async function elevenLabsTts(text) {
  const { apiKey, voiceId, modelId } = config.elevenLabs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.externalTimeoutMs);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.85,
          style: 0.35,
          use_speaker_boost: true,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 180)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const { url } = await saveBuffer(buf, { folder: 'tts', ext: 'mp3' });
    return { url };
  } finally {
    clearTimeout(timer);
  }
}

// English word/example audio for the tutor. Uses ElevenLabs when configured
// (same voice as the banter), else Azure English, else a mock placeholder.
// The caller caches this per word, so each word costs TTS at most once.
export async function synthesizeWordAudio(text) {
  if (!config.mockExternal && config.elevenLabs.apiKey && config.elevenLabs.voiceId) {
    try {
      return await elevenLabsTts(text);
    } catch (err) {
      console.warn(
        '[tutor] ElevenLabs word audio failed; falling back to Azure:',
        err?.message || err
      );
    }
  }
  return synthesizeSpeech({ text, targetLanguage: 'en' });
}
