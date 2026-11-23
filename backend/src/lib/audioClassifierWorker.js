import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';

// #1159: names, not AudioSet's current numeric positions, keep a class-map update honest.
export const AUDIO_CLASSES = {
  cry: ['Crying, sobbing', 'Baby cry, infant cry', 'Whimper', 'Wail, moan'],
  cough: ['Cough'],
  voice: ['Speech', 'Child speech, kid speaking', 'Babbling', 'Whispering', 'Laughter',
    'Baby laughter', 'Giggle', 'Shout', 'Yell', 'Whoop'],
};

// #1159: 0.30 was measured on 104 staging alert clips from one house (cry versus movement and
// sound, plus three owner-listened clips). Cough and voice were not separately calibrated: the
// one identified cough scored 0.04 for cough and 0.98 for speech, so it became voice. A missed
// cry falls back to the movement rule; a false cry keeps the former sound behaviour for its minute.
export const AUDIO_LABEL_MIN_SCORE = 0.30;
// "Talking" needs a stronger score than crying: of 83 non-cry staging clips, 8 scored speech 0.30-0.50 and the one
// of those the owner listened to (fan static in the microphone) was not speech at all. Missing a cry costs a
// wake-up, so cry keeps the lower bar; a wrong "Talking" badge costs only trust in the badge. Not calibrated beyond that.
export const VOICE_LABEL_MIN_SCORE = 0.50;

export function classIndices(csv) {
  const names = new Map();
  for (const line of csv.replace(/\r/g, '').split('\n').slice(1)) {
    const match = /^(\d+),[^,]+,(.*)$/.exec(line);
    if (match) names.set(match[2].replace(/^"|"$/g, ''), Number(match[1]));
  }
  return Object.fromEntries(Object.entries(AUDIO_CLASSES).map(([group, labels]) => [group, labels.map((name) => {
    if (!names.has(name)) throw new Error(`missing audio class: ${name}`);
    return names.get(name);
  })]));
}

export function labelScores(data, dims, groups) {
  const classes = dims.at(-1);
  if (!Number.isInteger(classes) || classes <= 0 || data.length % classes !== 0) throw new Error('invalid audio score shape');
  const scores = {};
  for (const [group, indices] of Object.entries(groups)) {
    let best = 0;
    for (let offset = 0; offset < data.length; offset += classes) {
      for (const index of indices) best = Math.max(best, data[offset + index] || 0);
    }
    scores[group] = best;
  }
  for (const group of ['cry', 'cough', 'voice']) {
    if (scores[group] >= (group === 'voice' ? VOICE_LABEL_MIN_SCORE : AUDIO_LABEL_MIN_SCORE)) return { label: group, score: scores[group] };
  }
  return { label: 'other', score: Math.max(scores.cry, scores.cough, scores.voice) };
}

let loaded;
async function model() {
  if (!loaded) loaded = (async () => {
    const dir = process.env.NIGHTLIGHT_AUDIO_MODEL_DIR || '/app/models';
    const groups = classIndices(await fs.readFile(path.join(dir, 'yamnet_class_map.csv'), 'utf8'));
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(path.join(dir, 'yamnet.onnx'), { executionProviders: ['wasm'] });
    return { groups, ort, session };
  })();
  return loaded;
}

if (parentPort) parentPort.on('message', async ({ id, samples }) => {
  try {
    const { groups, ort, session } = await model();
    const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', samples, [samples.length]) });
    const scores = output[session.outputNames[0]];
    parentPort.postMessage({ id, result: labelScores(scores.data, scores.dims, groups) });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e) });
  }
});
