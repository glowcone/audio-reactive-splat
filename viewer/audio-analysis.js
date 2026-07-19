import Meyda from "https://esm.sh/meyda@5.6.3?bundle";

const CHROMA_LABELS = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export class AudioAnalysis extends EventTarget {
  constructor() {
    super();
    this.context = null;
    this.stream = null;
    this.source = null;
    this.worklet = null;
    this.silentGain = null;
    this.previousSpectrum = null;
    this.fluxHistory = [];
    this.lastBeatAt = -Infinity;
    this.midiAccess = null;
    this.midiMappings = new Map();
    this.pendingMidiTarget = null;
    this.config = {
      bassGain: 1, midGain: 1, trebleGain: 1.1,
      gate: 0.06, contrast: 2.6, attack: 0.9, release: 0.18, smoothing: 0.25,
    };
    this.envelope = { bass: 0, mid: 0, treble: 0, volume: 0 };
    this.smoothedBands = { bass: 0, mid: 0, treble: 0 };
    this.genreWorker = new Worker("./genre-worker.js");
    this.genreReady = false;
    this.genreSamples = [];
    this.genreSampleCount = 0;
    this.lastClassificationAt = 0;
    this.genreWorker.onmessage = event => {
      if (event.data.type === "ready") {
        this.genreReady = true;
        this.dispatchEvent(new CustomEvent("classifierstate", { detail: { ready: true } }));
      } else if (event.data.type === "classification") {
        this.dispatchEvent(new CustomEvent("classification", { detail: event.data }));
      } else if (event.data.type === "error") {
        console.error("genre classifier", event.data.message);
        this.dispatchEvent(new CustomEvent("classifierstate", { detail: { ready: false, error: event.data.message } }));
      }
    };
  }

  async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === "audioinput");
  }

  async start(deviceId = "default") {
    await this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId === "default" ? undefined : { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    await this.#startStream(stream);
  }

  async startSystemAudio() {
    await this.stop();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error("The selected tab or screen did not provide an audio track");
    }
    await this.#startStream(stream);
  }

  async #startStream(stream) {
    this.stream = stream;

    this.context = new (window.AudioContext || window.webkitAudioContext)();
    await this.context.audioWorklet.addModule("./audio-worklet.js");
    if (this.context.state === "suspended") await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "feature-frame-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { frameSize: 2048, hopSize: 1024 },
    });
    // Keep the worklet in the render graph without sending input back to the speakers.
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.source.connect(this.worklet).connect(this.silentGain).connect(this.context.destination);
    this.worklet.port.onmessage = event => this.#handleFrame(event.data);
    this.dispatchEvent(new CustomEvent("statechange", { detail: { active: true } }));
  }

  async stop() {
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = this.stream = this.source = this.worklet = this.silentGain = null;
    this.previousSpectrum = null;
    this.genreSamples = [];
    this.genreSampleCount = 0;
  }

  setConfig(key, value) {
    if (key in this.config) this.config[key] = value;
  }

  async enableMidi() {
    if (!navigator.requestMIDIAccess) throw new Error("Web MIDI is not supported in this browser");
    this.midiAccess = await navigator.requestMIDIAccess();
    const bindInputs = () => {
      for (const input of this.midiAccess.inputs.values()) input.onmidimessage = event => this.#handleMidi(event);
      this.dispatchEvent(new CustomEvent("midistatechange", {
        detail: { inputs: [...this.midiAccess.inputs.values()].map(input => input.name || "MIDI input") },
      }));
    };
    this.midiAccess.onstatechange = bindInputs;
    bindInputs();
  }

  mapMidi(channel, controller, target) {
    this.midiMappings.set(`${channel}:${controller}`, target);
  }

  learnMidi(target) {
    this.pendingMidiTarget = target;
  }

  #handleMidi(event) {
    const [status, controller, rawValue] = event.data;
    if ((status & 0xf0) !== 0xb0) return;
    const channel = (status & 0x0f) + 1;
    if (this.pendingMidiTarget) {
      this.mapMidi(channel, controller, this.pendingMidiTarget);
      this.dispatchEvent(new CustomEvent("midimapping", {
        detail: { channel, controller, target: this.pendingMidiTarget },
      }));
      this.pendingMidiTarget = null;
    }
    const target = this.midiMappings.get(`${channel}:${controller}`) || `cc-${channel}-${controller}`;
    this.dispatchEvent(new CustomEvent("midi", {
      detail: { channel, controller, rawValue, value: rawValue / 127, target },
    }));
  }

  #handleFrame(message) {
    if (message.type !== "frame" || !this.context) return;
    Meyda.sampleRate = this.context.sampleRate;
    Meyda.bufferSize = message.samples.length;
    Meyda.windowingFunction = "hanning";
    const features = Meyda.extract(
      ["rms", "spectralCentroid", "spectralFlatness", "amplitudeSpectrum", "chroma"],
      message.samples,
    );
    if (!features) return;
    this.#queueSlowClassification(message.samples);

    const spectrum = features.amplitudeSpectrum;
    const flux = this.#spectralFlux(spectrum);
    const beat = this.#detectOnset(flux);
    const bands = this.#frequencyBands(spectrum);
    const volume = this.#envelope("volume", clamp(features.rms * 5), 0.75, 0.12);
    const bass = this.#shapeBand("bass", bands.bass);
    const mid = this.#shapeBand("mid", bands.mid);
    const treble = this.#shapeBand("treble", bands.treble);
    const centroidHz = features.spectralCentroid * this.context.sampleRate / message.samples.length;
    const chroma = Array.from(features.chroma || [], value => Number.isFinite(value) ? value : 0);
    const dominantChroma = chroma.length ? CHROMA_LABELS[chroma.indexOf(Math.max(...chroma))] : "–";

    this.dispatchEvent(new CustomEvent("features", { detail: {
      volume, beat, flux, bass, mid, treble, centroidHz,
      classification: this.#classify(centroidHz, features.spectralFlatness, beat),
      chroma, dominantChroma,
    } }));
  }

  #queueSlowClassification(samples) {
    // Worklet frames overlap by 50%; retain only the newest hop for continuous audio.
    const hop = Float32Array.from(samples.subarray(samples.length / 2));
    this.genreSamples.push(hop);
    this.genreSampleCount += hop.length;
    const maximum = (this.context?.sampleRate || 48000) * 10;
    while (this.genreSampleCount > maximum && this.genreSamples.length > 1) {
      this.genreSampleCount -= this.genreSamples.shift().length;
    }
    const now = performance.now();
    if (!this.genreReady || now - this.lastClassificationAt < 8000 || this.genreSampleCount < maximum * 0.5) return;
    const snapshot = new Float32Array(this.genreSampleCount);
    let offset = 0;
    for (const frame of this.genreSamples) { snapshot.set(frame, offset); offset += frame.length; }
    this.lastClassificationAt = now;
    this.genreWorker.postMessage({ type: "classify", samples: snapshot, sampleRate: this.context.sampleRate }, [snapshot.buffer]);
  }

  #frequencyBands(spectrum) {
    const hzPerBin = this.context.sampleRate / (spectrum.length * 2);
    const average = (low, high) => {
      const start = Math.max(1, Math.floor(low / hzPerBin));
      const end = Math.min(spectrum.length - 1, Math.ceil(high / hzPerBin));
      let sum = 0;
      for (let i = start; i <= end; i++) sum += spectrum[i];
      return sum / Math.max(1, end - start + 1);
    };
    return { bass: average(20, 250), mid: average(250, 2000), treble: average(2000, 8000) };
  }

  #shapeBand(name, value) {
    const gain = this.config[`${name === "treble" ? "treble" : name}Gain`];
    this.smoothedBands[name] = this.smoothedBands[name] * this.config.smoothing + value * (1 - this.config.smoothing);
    const shaped = clamp(Math.pow(Math.max(0, this.smoothedBands[name] * gain - this.config.gate), this.config.contrast) * 2.6, 0, 1.6);
    return this.#envelope(name, shaped, this.config.attack, this.config.release);
  }

  #envelope(name, value, attack, release) {
    const previous = this.envelope[name];
    const rate = value > previous ? attack : release;
    return this.envelope[name] = previous + (value - previous) * rate;
  }

  #spectralFlux(spectrum) {
    let positiveChange = 0;
    let magnitude = 0;
    if (this.previousSpectrum) {
      for (let i = 1; i < spectrum.length; i++) {
        positiveChange += Math.max(0, spectrum[i] - this.previousSpectrum[i]);
        magnitude += spectrum[i];
      }
    }
    this.previousSpectrum = Float32Array.from(spectrum);
    return magnitude > 0 ? positiveChange / magnitude : 0;
  }

  #detectOnset(flux) {
    const now = performance.now();
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 43) this.fluxHistory.shift();
    if (this.fluxHistory.length < 12) return false;
    const sorted = [...this.fluxHistory].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const deviations = sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)];
    const onset = flux > median + Math.max(0.012, mad * 3.5) && now - this.lastBeatAt > 180;
    if (onset) this.lastBeatAt = now;
    return onset;
  }

  #classify(centroidHz, flatness, onset) {
    if (onset && centroidHz < 350) return "Kick drum";
    if (onset && centroidHz > 4200 && flatness > 0.15) return "Hi-hat";
    if (centroidHz < 650) return "Low centroid";
    if (centroidHz > 4200) return "High centroid";
    if (centroidHz >= 900 && centroidHz <= 3000 && flatness < 0.2) return "Acoustic guitar";
    return "Middle";
  }
}
