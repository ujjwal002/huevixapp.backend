import { config, languageMeta } from '../config/env.js';
import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { withTimeout } from '../utils/withTimeout.js';

// THE CORE FEATURE. Takes the user's recording + the card's reference text and
// returns scores plus a per-word breakdown ("what you did great / wrong").
//
// Real implementation uses Azure Pronunciation Assessment, which scores
// accuracy, fluency, completeness and prosody down to the word/phoneme level.
// Mock mode returns realistic, slightly-randomized results so you can build and
// demo the full UX without an Azure account.

// Resolve an ffmpeg binary: prefer the bundled ffmpeg-static (no system install
// needed), fall back to an ffmpeg on PATH.
async function resolveFfmpeg() {
  try {
    const m = await import('ffmpeg-static');
    return m.default || 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
}

// Transcode ANY browser recording (WebM/Opus, MP3, M4A, 44.1kHz stereo, ...)
// into raw 16 kHz mono 16-bit PCM — exactly what Azure's default push stream
// expects. This is why record-and-speak from a browser/phone now works.
async function toPcm16kMono(inputBuffer) {
  const bin = await resolveFfmpeg();
  const tmp = os.tmpdir();
  const inFile = path.join(tmp, `spk_in_${randomUUID()}`);
  const outFile = path.join(tmp, `spk_out_${randomUUID()}.raw`);
  await writeFile(inFile, inputBuffer);
  try {
    await new Promise((resolve, reject) => {
      const args = ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', outFile];
      const proc = spawn(bin, args);
      let err = '';
      let settled = false;
      const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(killTimer); fn(arg); } };
      // Bound transcode time and hard-kill a stuck ffmpeg so it can't pin a worker.
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        done(reject, new Error(`ffmpeg transcode timed out after ${config.externalTimeoutMs}ms`));
      }, config.externalTimeoutMs);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => done(reject, new Error(`ffmpeg not runnable (${e.message}). Install ffmpeg-static or system ffmpeg.`)));
      proc.on('close', (code) => (code === 0 ? done(resolve) : done(reject, new Error('ffmpeg transcode failed: ' + err.slice(-400)))));
    });
    return await readFile(outFile);
  } finally {
    unlink(inFile).catch(() => {});
    unlink(outFile).catch(() => {});
  }
}

export async function assessPronunciation({ audioBuffer, referenceText, targetLanguage }) {
  const meta = languageMeta(targetLanguage);
  if (!meta) throw new Error(`Unsupported target language for assessment: ${targetLanguage}`);

  if (config.mockExternal || !config.azureSpeech.key) {
    return mockAssessment(referenceText);
  }

  // --- Real Azure Pronunciation Assessment ---
  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    config.azureSpeech.key,
    config.azureSpeech.region
  );
  speechConfig.speechRecognitionLanguage = meta.locale;

  // Transcode whatever the browser/phone recorded into 16 kHz mono 16-bit PCM,
  // then push it. createPushStream() defaults to exactly this format, so the
  // raw PCM lines up with no WAV header to confuse the recognizer.
  const pcm = await toPcm16kMono(audioBuffer);
  const pushStream = sdk.AudioInputStream.createPushStream();
  pushStream.write(pcm);
  pushStream.close();
  const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);

  const paConfig = new sdk.PronunciationAssessmentConfig(
    referenceText,
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true // enable miscue (detect omissions/insertions)
  );
  paConfig.enableProsodyAssessment = true;

  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  paConfig.applyTo(recognizer);

  let result;
  try {
    result = await withTimeout(
      new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          (r) => resolve(r),
          (e) => reject(e)
        );
      }),
      { ms: config.externalTimeoutMs, label: 'pronunciation assessment' }
    );
  } finally {
    // Always release the recognizer, including on timeout (when neither
    // callback fires), so the native handle and push stream can't leak.
    try { recognizer.close(); } catch { /* already closed */ }
  }

  const pa = sdk.PronunciationAssessmentResult.fromResult(result);
  const words = (pa.detailResult?.Words || []).map((w) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? null,
    errorType: w.PronunciationAssessment?.ErrorType ?? 'None',
  }));

  return {
    transcript: result.text || '',
    overallScore: pa.pronunciationScore,
    accuracyScore: pa.accuracyScore,
    fluencyScore: pa.fluencyScore,
    completenessScore: pa.completenessScore,
    prosodyScore: pa.prosodyScore ?? null,
    wordScores: words,
    feedback: buildFeedback({
      overall: pa.pronunciationScore,
      words,
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock + feedback helpers
// ---------------------------------------------------------------------------

function mockAssessment(referenceText) {
  const words = referenceText
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 60);

  const wordScores = words.map((word) => {
    const score = Math.round(60 + Math.random() * 40); // 60-100
    let errorType = 'None';
    if (score < 70 && Math.random() < 0.5) errorType = 'Mispronunciation';
    return { word, accuracyScore: score, errorType };
  });

  const avg = (key) =>
    Math.round((70 + Math.random() * 25) * 10) / 10; // 70-95
  const overall = Math.round(
    (wordScores.reduce((s, w) => s + w.accuracyScore, 0) / Math.max(wordScores.length, 1)) * 10
  ) / 10;

  return {
    transcript: referenceText,
    overallScore: overall,
    accuracyScore: avg(),
    fluencyScore: avg(),
    completenessScore: avg(),
    prosodyScore: avg(),
    wordScores,
    feedback: buildFeedback({ overall, words: wordScores }),
    _mock: true,
  };
}

// Turns raw scores into friendly "what you did great / wrong" guidance.
function buildFeedback({ overall, words }) {
  const weak = words
    .filter((w) => w.accuracyScore != null && w.accuracyScore < 70)
    .sort((a, b) => a.accuracyScore - b.accuracyScore)
    .slice(0, 5)
    .map((w) => w.word);

  const strong = words
    .filter((w) => w.accuracyScore != null && w.accuracyScore >= 90)
    .slice(0, 5)
    .map((w) => w.word);

  let summary;
  if (overall >= 90) summary = 'Excellent — you sound clear and natural.';
  else if (overall >= 75) summary = 'Good job. A few words need a little polish.';
  else if (overall >= 60) summary = 'Nice effort. Focus on the flagged words and try again.';
  else summary = 'Keep practising — slow down and focus on each word.';

  return {
    summary,
    didWell: strong.length ? `Clear pronunciation on: ${strong.join(', ')}.` : 'Steady overall delivery.',
    improve: weak.length
      ? `Work on these words: ${weak.join(', ')}. Try saying each one slowly, then in the sentence.`
      : 'No major problem words — push for smoother flow next.',
  };
}