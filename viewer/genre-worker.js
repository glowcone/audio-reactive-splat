/* Slow-path music tagging. Runs away from both the render thread and audio thread. */
importScripts(
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.umd.js",
  "https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-model.umd.js",
);

const TAGS = [
  "rock", "pop", "alternative", "indie", "electronic", "female vocalists", "dance", "00s",
  "alternative rock", "jazz", "beautiful", "metal", "chillout", "male vocalists", "classic rock",
  "soul", "indie rock", "Mellow", "electronica", "80s", "folk", "90s", "chill", "instrumental",
  "punk", "oldies", "blues", "hard rock", "ambient", "acoustic", "experimental", "female vocalist",
  "guitar", "Hip-Hop", "70s", "party", "country", "easy listening", "sexy", "catchy", "funk",
  "electro", "heavy metal", "Progressive rock", "60s", "rnb", "indie pop", "sad", "House", "happy",
];
const GENRES = new Set([
  "rock", "pop", "alternative", "indie", "electronic", "dance", "alternative rock", "jazz", "metal",
  "classic rock", "soul", "indie rock", "electronica", "folk", "punk", "blues", "hard rock", "ambient",
  "experimental", "Hip-Hop", "country", "funk", "electro", "heavy metal", "Progressive rock", "rnb",
  "indie pop", "House",
]);
const MOODS = new Set(["beautiful", "chillout", "Mellow", "chill", "party", "easy listening", "sexy", "catchy", "sad", "happy"]);
const INSTRUMENTS = new Set(["female vocalists", "male vocalists", "instrumental", "female vocalist", "guitar", "acoustic"]);

let extractor;
let model;
let ready = false;
let busy = false;
let stableScores = new Float32Array(TAGS.length);

async function initialize() {
  try {
    const wasm = typeof EssentiaWASM !== "undefined" ? EssentiaWASM : Module;
    extractor = new EssentiaModel.EssentiaTFInputExtractor(wasm, "musicnn", false);
    const modelURL = new URL("./models/msd-musicnn-1/model.json", self.location.href).href;
    model = new EssentiaModel.TensorflowMusiCNN(tf, modelURL, true);
    await model.initialize();
    ready = true;
    postMessage({ type: "ready" });
  } catch (error) {
    postMessage({ type: "error", message: error.message || String(error) });
  }
}

function resample(input, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return input;
  const output = new Float32Array(Math.floor(input.length * targetRate / sourceRate));
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const mix = position - left;
    output[i] = input[left] * (1 - mix) + (input[Math.min(left + 1, input.length - 1)] || 0) * mix;
  }
  return output;
}

function averagePredictions(predictions) {
  const rows = Array.isArray(predictions[0]) || ArrayBuffer.isView(predictions[0]) ? predictions : [predictions];
  const scores = new Float32Array(TAGS.length);
  for (const row of rows) for (let i = 0; i < scores.length; i++) scores[i] += Number(row[i]) || 0;
  for (let i = 0; i < scores.length; i++) scores[i] /= Math.max(1, rows.length);
  return scores;
}

function bestIn(scores, allowed) {
  let best = { label: "unknown", confidence: 0 };
  TAGS.forEach((tag, index) => {
    if (allowed.has(tag) && scores[index] > best.confidence) best = { label: tag, confidence: scores[index] };
  });
  return best;
}

self.onmessage = async event => {
  if (event.data.type !== "classify" || !ready || busy) return;
  busy = true;
  try {
    const audio = resample(event.data.samples, event.data.sampleRate);
    const features = extractor.computeFrameWise(audio, 256);
    const current = averagePredictions(await model.predict(features, true));
    // Slow EMA prevents one unusual patch from completely changing the visual state.
    for (let i = 0; i < current.length; i++) stableScores[i] = stableScores[i] * 0.65 + current[i] * 0.35;
    postMessage({
      type: "classification",
      genre: bestIn(stableScores, GENRES),
      mood: bestIn(stableScores, MOODS),
      instrument: bestIn(stableScores, INSTRUMENTS),
      tags: TAGS.map((label, index) => ({ label, confidence: stableScores[index] }))
        .sort((a, b) => b.confidence - a.confidence).slice(0, 5),
    });
  } catch (error) {
    postMessage({ type: "error", message: error.message || String(error) });
  } finally {
    busy = false;
  }
};

initialize();
