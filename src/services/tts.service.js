import { config, languageMeta } from '../config/env.js';
import { saveBuffer } from './storage.service.js';

// Generates audio for a card's body (the "listen" feature) and stores it once.
// You cache the result on the Card row, so each card costs TTS exactly once
// regardless of how many users listen — this is your main cost lever.

export async function synthesizeSpeech({ text, targetLanguage }) {
  const meta = languageMeta(targetLanguage);
  if (!meta) throw new Error(`Unsupported target language for TTS: ${targetLanguage}`);

  if (config.mockExternal || !config.azureSpeech.key) {
    // Return a tiny silent-ish placeholder buffer so the pipeline + storage work.
    const placeholder = Buffer.from(
      `MOCK_AUDIO::${targetLanguage}::${text.slice(0, 24)}`,
      'utf-8'
    );
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

  const audioBuffer = await new Promise((resolve, reject) => {
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
  });

  const { url } = await saveBuffer(audioBuffer, { folder: 'tts', ext: 'mp3' });
  return { url };
}
