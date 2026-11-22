// 音訊引擎：把物理模組算好的模態參數送進 AudioWorklet 合成。
// 訊號路徑：模態合成器（虛擬拾音器）→ 乾聲 + 輕微空間殘響 → 壓縮器 → 喇叭

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;

  get ready(): boolean {
    return this.node !== null;
  }

  /** 必須在使用者點擊（手勢）之內呼叫，瀏覽器才允許發聲。 */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('audio/modal-processor.js', document.baseURI).href);
    const node = new AudioWorkletNode(ctx, 'modal-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    const master = ctx.createGain();
    master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;

    const dry = ctx.createGain();
    dry.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    const reverb = ctx.createConvolver();
    reverb.buffer = makeRoomImpulse(ctx, 1.3);

    node.connect(dry).connect(comp);
    node.connect(reverb).connect(wet).connect(comp);
    comp.connect(master).connect(ctx.destination);

    this.node = node;
    this.master = master;
    await ctx.resume();
  }

  setVolume(v: number): void {
    if (this.master) this.master.gain.value = v;
  }

  pluck(id: number, freq: Float32Array, amp: Float32Array, decay: Float32Array, pan: number): void {
    this.node?.port.postMessage({ type: 'pluck', id, freq, amp, decay, pan });
  }

  retune(id: number, freq: Float32Array, decay: Float32Array, pan: number): void {
    this.node?.port.postMessage({ type: 'retune', id, freq, decay, pan });
  }

  /** 共鳴：把能量疊加到一條弦既有的振動上（沒在響的弦會慢慢被帶動）。 */
  excite(id: number, freq: Float32Array, amp: Float32Array, decay: Float32Array, pan: number): void {
    this.node?.port.postMessage({ type: 'excite', id, freq, amp, decay, pan });
  }

  /** 止音：rate 為每秒的衰減率（80 ≈ 0.1 秒內安靜）。 */
  damp(id: number, rate = 80): void {
    this.node?.port.postMessage({ type: 'damp', id, rate });
  }

  clear(): void {
    this.node?.port.postMessage({ type: 'clear' });
  }

  /** 斷弦的聲音。 */
  snap(gain = 0.6): void {
    this.node?.port.postMessage({ type: 'snap', gain });
  }
}

/** 產生一個小房間的脈衝響應：指數衰減的雜訊。 */
function makeRoomImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.floor(ctx.sampleRate * 0.012);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / ctx.sampleRate;
      const n = Math.random() * 2 - 1;
      // 越後面的殘響越悶（高頻被空氣與牆面吸收）
      const k = 0.6 * Math.exp(-t * 3) + 0.08;
      lp += k * (n - lp);
      data[i] = lp * Math.exp(-t * 5.2);
    }
  }
  return buf;
}
