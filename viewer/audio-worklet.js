class FeatureFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.frameSize = config.frameSize || 2048;
    this.hopSize = config.hopSize || 1024;
    this.frame = new Float32Array(this.frameSize);
    this.writeIndex = 0;
    this.samplesSinceFrame = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;

    const blockSize = channels[0].length;
    for (let i = 0; i < blockSize; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        sample += channels[channel][i] || 0;
      }
      this.frame[this.writeIndex] = sample / channels.length;
      this.writeIndex = (this.writeIndex + 1) % this.frameSize;
      this.samplesSinceFrame++;

      if (this.samplesSinceFrame >= this.hopSize) {
        this.samplesSinceFrame = 0;
        const ordered = new Float32Array(this.frameSize);
        const tail = this.frameSize - this.writeIndex;
        ordered.set(this.frame.subarray(this.writeIndex), 0);
        ordered.set(this.frame.subarray(0, this.writeIndex), tail);
        this.port.postMessage({ type: "frame", samples: ordered }, [ordered.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("feature-frame-processor", FeatureFrameProcessor);
