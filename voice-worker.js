'use strict';
/*
 * DotSense voice typing engine. Runs in its own utility process so speech
 * recognition can never slow down or crash the machine connection.
 * Offline speech-to-text: Silero VAD + Moonshine for English, or a streaming zipformer for
 * Bangla (sherpa-onnx).
 * The model downloads once from the sherpa-onnx GitHub releases.
 */

const models = require('./voice-models');
const SAMPLE_RATE = 16000;
const WINDOW = 512;
const PAD = Math.round(0.35 * SAMPLE_RATE);   // audio kept before each detected phrase (soft first words)

let modelsDir = '';
let sherpa = null;
let recognizer = null;
let online = false;   // the Bangla zipformer is a streaming (online) model
let loadedModel = '';
const TAIL = new Float32Array(Math.round(0.5 * SAMPLE_RATE));   // silence after a phrase so its last word comes out
let vad = null;
let acc = new Float32Array(0);
let speech = [];
let speechLen = 0;
let preroll = [];
let inSpeech = false;
let chain = Promise.resolve();
let partialBusy = false;
let lastPartial = 0;
let generation = 0;
let fed = 0;          // samples given to the VAD since its last reset
let recent = [];      // last ~15 s of windows { start, data }: longer than the longest phrase (maxSpeechDuration)

const post = m => process.parentPort.postMessage(m);

function resetBuffers() {
  fed = 0;
  recent = [];
  acc = new Float32Array(0);
  speech = [];
  speechLen = 0;
  preroll = [];
  inSpeech = false;
  lastPartial = 0;
}

async function init(model) {
  const files = await models.ensureFiles(modelsDir, model, post);
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  if (loadedModel !== model || !recognizer) {
    post({ type: 'loading', model });
    if (files.kind === 'zipformer') {
      recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: files.tokens, modelType: 'zipformer2',
          numThreads: 2, provider: 'cpu', debug: 0
        },
        decodingMethod: 'greedy_search', enableEndpoint: false
      });
      online = true;
    } else {
      recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          moonshine: { encoder: files.encoder, mergedDecoder: files.decoder },
          tokens: files.tokens,
          numThreads: 2, provider: 'cpu', debug: 0
        }
      });
      online = false;
    }
    loadedModel = model;
  }
  vad = new sherpa.Vad({
    sileroVad: { model: files.vadPath, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.6, maxSpeechDuration: 12, windowSize: WINDOW },
    sampleRate: SAMPLE_RATE, debug: false, numThreads: 1
  }, 60);
  generation++;
  resetBuffers();
  post({ type: 'ready', model });
}

async function decode(samples) {
  if (online) {
    const st = recognizer.createStream();
    st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    st.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: TAIL });
    st.inputFinished();
    while (recognizer.isReady(st)) recognizer.decode(st);
    const r = recognizer.getResult(st);
    return String((r && r.text) || '').trim();
  }
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  const r = await recognizer.decodeAsync(stream);
  return String((r && r.text) || '').trim();
}

function queueFinal(samples) {
  const gen = generation;
  chain = chain.then(async () => {
    const text = await decode(samples);
    if (gen === generation && text) post({ type: 'final', text });
  }).catch(e => post({ type: 'error', message: e.message }));
}

function concat(parts, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Adds the audio just before the phrase: the VAD can start a little late on a quiet first word.
function withPreroll(seg) {
  const start = seg.start;
  const from = Math.max(0, start - PAD);
  if (!(start > from)) return seg.samples;
  const pre = new Float32Array(start - from);
  let filled = 0;
  for (const w of recent) {
    const a = Math.max(w.start, from), b = Math.min(w.start + w.data.length, start);
    if (b > a) { pre.set(w.data.subarray(a - w.start, b - w.start), a - from); filled += b - a; }
  }
  if (filled < pre.length) return seg.samples;
  return concat([pre, seg.samples], pre.length + seg.samples.length);
}

function onAudio(samples) {
  if (!vad || !recognizer || !samples || !samples.length) return;
  if (!(samples instanceof Float32Array)) samples = Float32Array.from(samples);
  const merged = new Float32Array(acc.length + samples.length);
  merged.set(acc);
  merged.set(samples, acc.length);
  let off = 0;
  while (merged.length - off >= WINDOW) {
    const win = merged.slice(off, off + WINDOW);
    off += WINDOW;
    recent.push({ start: fed, data: win });
    if (recent.length > 480) recent.shift();
    fed += WINDOW;
    vad.acceptWaveform(win);
    if (vad.isDetected()) {
      if (!inSpeech) {
        inSpeech = true;
        speech = preroll.slice();
        speechLen = speech.reduce((n, a) => n + a.length, 0);
        post({ type: 'speech', active: true });
      }
      speech.push(win);
      speechLen += win.length;
    } else {
      preroll.push(win);
      if (preroll.length > 12) preroll.shift();
      if (inSpeech) { inSpeech = false; post({ type: 'speech', active: false }); }
    }
    while (!vad.isEmpty()) {
      const seg = vad.front(false);   // copy: Electron does not allow external buffers
      vad.pop();
      speech = [];
      speechLen = 0;
      queueFinal(withPreroll(seg));
    }
  }
  acc = merged.slice(off);
  // Show words while the person is still talking.
  const now = Date.now();
  if (inSpeech && !partialBusy && speechLen > SAMPLE_RATE * 0.7 && now - lastPartial > 700) {
    lastPartial = now;
    partialBusy = true;
    const gen = generation;
    decode(concat(speech, speechLen))
      .then(text => { if (gen === generation && inSpeech && text) post({ type: 'partial', text }); })
      .catch(() => {})
      .finally(() => { partialBusy = false; });
  }
}

async function flush() {
  if (vad) {
    vad.flush();
    while (!vad.isEmpty()) {
      const seg = vad.front(false);
      vad.pop();
      queueFinal(withPreroll(seg));
    }
    vad.reset();
  }
  resetBuffers();
  await chain;
  post({ type: 'flushed' });
}

process.parentPort.on('message', async e => {
  const m = (e && e.data) || {};
  try {
    if (m.type === 'config') modelsDir = m.modelsDir;
    else if (m.type === 'init') await init(m.model);
    else if (m.type === 'audio') onAudio(m.samples);
    else if (m.type === 'flush') await flush();
    else if (m.type === 'cancel') {
      generation++;
      if (vad) vad.reset();
      resetBuffers();
      post({ type: 'flushed' });
    }
  } catch (err) {
    post({ type: 'error', message: (err && err.message) || String(err) });
  }
});
