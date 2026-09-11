/* KYX core bitcrusher worklet — generated. Do not edit. */
"use strict";
(() => {
  // src/audio-worklets/bitcrusher-processor.js
  var BitcrusherProcessor = class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.heldValue = 0;
      this.counter = 0;
    }
    static get parameterDescriptors() {
      return [
        { name: "bits", defaultValue: 8, minValue: 1, maxValue: 16, automationRate: "k-rate" },
        { name: "downsample", defaultValue: 1, minValue: 1, maxValue: 50, automationRate: "k-rate" }
      ];
    }
    process(inputs, outputs, parameters) {
      const input = inputs[0];
      const output = outputs[0];
      if (!input || !input[0] || !output || !output[0]) return true;
      const bits = parameters.bits;
      const downsample = parameters.downsample;
      const bitsIsConstant = bits.length === 1;
      const dsIsConstant = downsample.length === 1;
      const channelCount = Math.min(input.length, output.length);
      for (let ch = 0; ch < channelCount; ch++) {
        const inCh = input[ch];
        const outCh = output[ch];
        for (let i = 0; i < outCh.length; i++) {
          const b = bitsIsConstant ? bits[0] : bits[i];
          const ds = dsIsConstant ? downsample[0] : downsample[i];
          if (this.counter === 0) {
            const levels = Math.max(2, Math.pow(2, Math.max(1, Math.round(b))));
            const step = 2 / (levels - 1);
            const quantized = Math.round((inCh[i] + 1) / step) * step - 1;
            this.heldValue = Math.max(-1, Math.min(1, quantized));
          }
          outCh[i] = this.heldValue;
          this.counter = (this.counter + 1) % Math.max(1, Math.round(ds));
        }
      }
      return true;
    }
  };
  registerProcessor("bitcrusher-processor", BitcrusherProcessor);
})();
