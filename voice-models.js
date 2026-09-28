'use strict';
/*
 * Voice model files for DotSense voice typing: one-time download from the
 * sherpa-onnx GitHub releases, then unpack. Used by the voice engine process.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';
const MODEL_FILES = ['encoder_model.ort', 'decoder_model_merged.ort', 'tokens.txt'];          // Moonshine (English)
const ZIPFORMER_FILES = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'];        // streaming zipformer
const MODELS = {
  accurate: { name: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27', size: 111266225, mb: 111, lang: 'en', kind: 'moonshine', files: MODEL_FILES },
  fast: { name: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27', size: 29858559, mb: 30, lang: 'en', kind: 'moonshine', files: MODEL_FILES },
  // Bangla: Vosk small streaming Bengali model (alphacep, Apache-2.0), packaged by sherpa-onnx
  bangla: { name: 'sherpa-onnx-streaming-zipformer-bn-vosk-2026-02-09', size: 87289525, mb: 87, lang: 'bn', kind: 'zipformer', files: ZIPFORMER_FILES }
};
const VAD_FILE = 'silero_vad.onnx';

function installed(modelsDir) {
  const out = {};
  const vad = fs.existsSync(path.join(modelsDir, VAD_FILE));
  for (const [key, m] of Object.entries(MODELS)) {
    out[key] = { mb: m.mb, lang: m.lang, installed: vad && m.files.every(f => fs.existsSync(path.join(modelsDir, m.name, f))) };
  }
  return out;
}

async function download(url, dest, onProgress) {
  let fetchFn = globalThis.fetch;
  try {
    const { net } = require('electron');   // uses the system proxy settings
    if (net && typeof net.fetch === 'function') fetchFn = net.fetch.bind(net);
  } catch (_) { /* plain Node */ }
  const res = await fetchFn(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('Download failed (HTTP ' + res.status + '). Check the internet connection and try again.');
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const fh = await fsp.open(tmp, 'w');
  let received = 0;
  let last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await fh.write(value);
      received += value.length;
      const now = Date.now();
      if (now - last > 200) { last = now; onProgress(received, total); }
    }
  } finally {
    await fh.close();
  }
  if (total && received !== total) throw new Error('Download was interrupted. Try again.');
  onProgress(received, total || received);
  await fsp.rename(tmp, dest);
}

// Pure JavaScript unpacking of the files we need from a .tar.bz2 archive.
function extract(archive, dir, wanted) {
  const bz2 = require('unbzip2-stream');
  const tar = require('tar-stream');
  return new Promise((resolve, reject) => {
    const ex = tar.extract();
    const got = new Set();
    ex.on('entry', (header, stream, next) => {
      const parts = header.name.split('/').filter(Boolean);
      const base = parts[parts.length - 1];
      if (header.type === 'file' && parts.length === 2 && wanted.includes(base)) {
        const tmp = path.join(dir, base + '.part');
        const out = fs.createWriteStream(tmp);
        out.on('error', reject);
        stream.on('error', reject);
        out.on('finish', () => fs.rename(tmp, path.join(dir, base), err => {
          if (err) return reject(err);
          got.add(base);
          next();
        }));
        stream.pipe(out);
      } else {
        stream.on('end', () => next());
        stream.resume();
      }
    });
    ex.on('finish', () => (got.size === wanted.length ? resolve() : reject(new Error('Voice model archive is incomplete. Try again.'))));
    ex.on('error', reject);
    const input = fs.createReadStream(archive);
    const unzip = bz2();
    input.on('error', reject);
    unzip.on('error', reject);
    input.pipe(unzip).pipe(ex);
  });
}

// System tar (built into Windows 10+, macOS and Linux) is about twice as fast as the JavaScript fallback.
function extractWithTar(archive, parentDir) {
  const { spawn } = require('child_process');
  const bin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  if (process.platform === 'win32' && !fs.existsSync(bin)) return Promise.reject(new Error('tar not found'));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-xjf', archive, '-C', parentDir], { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error('tar exit ' + code))));
  });
}

async function unpack(archive, modelsDir, dir, options = {}, files = MODEL_FILES) {
  await fsp.mkdir(dir, { recursive: true });
  let ok = false;
  if (!options.noSystemTar) {
    try {
      await extractWithTar(archive, modelsDir);
      ok = files.every(f => fs.existsSync(path.join(dir, f)));
    } catch (_) { ok = false; }
  }
  if (!ok) await extract(archive, dir, files);
  for (const extra of ['test_wavs', 'bpe.model', 'unigram_500.vocab', 'README.md']) await fsp.rm(path.join(dir, extra), { recursive: true, force: true }).catch(() => {});
}

// Makes sure the VAD and the chosen model are on disk; downloads them once if needed.
async function ensureFiles(modelsDir, model, post) {
  const info = MODELS[model];
  if (!info) throw new Error('Unknown voice model.');
  if (!modelsDir) throw new Error('Voice engine not configured.');
  await fsp.mkdir(modelsDir, { recursive: true });
  const vadPath = path.join(modelsDir, VAD_FILE);
  if (!fs.existsSync(vadPath)) {
    await download(RELEASE + VAD_FILE, vadPath, (received, total) => post({ type: 'download', part: 'vad', model, received, total }));
  }
  const dir = path.join(modelsDir, info.name);
  if (!info.files.every(f => fs.existsSync(path.join(dir, f)))) {
    const archive = path.join(modelsDir, info.name + '.tar.bz2');
    await download(RELEASE + info.name + '.tar.bz2', archive, (received, total) => post({ type: 'download', part: 'model', model, received, total: total || info.size }));
    post({ type: 'unpacking', model });
    try { await unpack(archive, modelsDir, dir, {}, info.files); }
    finally { await fsp.rm(archive, { force: true }); }
  }
  if (info.kind === 'zipformer') {
    return {
      kind: 'zipformer', vadPath,
      encoder: path.join(dir, 'encoder.onnx'), decoder: path.join(dir, 'decoder.onnx'), joiner: path.join(dir, 'joiner.onnx'),
      tokens: path.join(dir, 'tokens.txt')
    };
  }
  return {
    kind: 'moonshine', vadPath,
    encoder: path.join(dir, 'encoder_model.ort'),
    decoder: path.join(dir, 'decoder_model_merged.ort'),
    tokens: path.join(dir, 'tokens.txt')
  };
}

module.exports = { MODELS, MODEL_FILES, ZIPFORMER_FILES, VAD_FILE, RELEASE, installed, download, extract, extractWithTar, unpack, ensureFiles };
