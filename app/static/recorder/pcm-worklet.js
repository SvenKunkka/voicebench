// No gate, silence trimming, normalization or speech processing. Every render
// quantum becomes mono PCM16; missing input becomes silence and is reported.
class VibePCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new ArrayBuffer(8192); this.view = new DataView(this.buffer);
    this.used = 0; this.peak = 0; this.missing = 0; this.stopped = false;
    this.port.onmessage = ({data}) => {
      if (data === 'stop') { this.flush(); this.stopped = true; this.port.postMessage({type: 'stopped'}); }
    };
  }
  flush() {
    if (!this.used) return;
    const payload = this.buffer.slice(0, this.used * 2);
    this.port.postMessage({type:'pcm', buffer:payload, frames:this.used, peak:this.peak, missing:this.missing}, [payload]);
    this.used = 0; this.peak = 0; this.missing = 0;
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    const count = outputs[0]?.[0]?.length || 128;
    for (let i = 0; i < count; i++) {
      const x = Math.max(-1, Math.min(1, input?.[i] ?? 0));
      this.peak = Math.max(this.peak, Math.abs(x));
      if (!input) this.missing++;
      this.view.setInt16(this.used++ * 2, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
      if (this.used === 4096) this.flush();
    }
    return true;
  }
}
registerProcessor('vibe-pcm', VibePCM);
