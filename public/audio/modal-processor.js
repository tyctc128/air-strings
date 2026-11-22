// 模態合成器（AudioWorklet）。
// 每條弦是一個 voice，每個簡正模態是一個「阻尼旋轉相量」：
//   z[k+1] = z[k] · r·e^(iω)，輸出取實部 → A·e^(−αt)·cos(ωt)
// 各模態的頻率、振幅、衰減率都由主執行緒的物理模組算好後傳進來，
// 這裡只負責忠實地把它們加總成聲音。

const MAX_MODES = 64;
const TWO_PI = 2 * Math.PI;

class Voice {
  constructor() {
    this.re = new Float64Array(MAX_MODES);
    this.im = new Float64Array(MAX_MODES);
    this.c = new Float64Array(MAX_MODES);
    this.s = new Float64Array(MAX_MODES);
    this.count = 0;
    this.attack = 0; // 0→1 的起音斜坡，避免爆音
    this.attackStep = 0;
    this.damp = 1; // 止音用的額外增益
    this.dampMul = 1;
    this.panL = Math.SQRT1_2;
    this.panR = Math.SQRT1_2;
  }
}

class ModalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = new Map();
    this.buf = new Float32Array(128);
    this.snapEnv = 0;
    this.snapLp = 0;
    this.pingRe = 0;
    this.pingIm = 0;
    this.dcX = [0, 0];
    this.dcY = [0, 0];
    this.port.onmessage = (e) => this.handle(e.data);
  }

  setCoef(v, i, freq, decay) {
    const w = (TWO_PI * freq) / sampleRate;
    const r = Math.exp(-decay / sampleRate);
    v.c[i] = r * Math.cos(w);
    v.s[i] = r * Math.sin(w);
  }

  setPan(v, pan) {
    const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    v.panL = Math.cos(a);
    v.panR = Math.sin(a);
  }

  handle(m) {
    const nyq = sampleRate * 0.45;
    switch (m.type) {
      case 'pluck': {
        let v = this.voices.get(m.id);
        if (!v) {
          v = new Voice();
          this.voices.set(m.id, v);
        }
        const n = Math.min(m.freq.length, MAX_MODES);
        let count = 0;
        for (let i = 0; i < n; i++) {
          if (m.freq[i] >= nyq) break;
          v.re[i] = m.amp[i];
          v.im[i] = 0;
          this.setCoef(v, i, m.freq[i], m.decay[i]);
          count++;
        }
        v.count = count;
        v.attack = 0;
        v.attackStep = 1 / (0.002 * sampleRate);
        v.damp = 1;
        v.dampMul = 1;
        this.setPan(v, m.pan || 0);
        break;
      }
      case 'retune': {
        const v = this.voices.get(m.id);
        if (!v) break;
        let n = Math.min(v.count, m.freq.length);
        for (let i = 0; i < n; i++) {
          if (m.freq[i] >= nyq) {
            n = i;
            break;
          }
          this.setCoef(v, i, m.freq[i], m.decay[i]);
        }
        v.count = n;
        if (typeof m.pan === 'number') this.setPan(v, m.pan);
        break;
      }
      case 'excite': {
        // 共鳴：在既有的振動上疊加能量；原本靜止的弦則慢慢被帶動起來
        let v = this.voices.get(m.id);
        if (!v) {
          v = new Voice();
          this.voices.set(m.id, v);
          v.count = 0;
          v.attack = 0;
          v.attackStep = 1 / (0.12 * sampleRate);
          v.damp = 1;
          v.dampMul = 1;
          this.setPan(v, m.pan || 0);
        }
        const n = Math.min(m.freq.length, MAX_MODES);
        let top = v.count;
        for (let i = 0; i < n; i++) {
          if (m.freq[i] >= nyq) break;
          if (i >= v.count) {
            v.re[i] = 0;
            v.im[i] = 0;
            this.setCoef(v, i, m.freq[i], m.decay[i]);
          }
          v.re[i] += m.amp[i];
          if (i + 1 > top) top = i + 1;
        }
        v.count = top;
        break;
      }
      case 'damp': {
        const v = this.voices.get(m.id);
        if (v) v.dampMul = Math.exp(-(m.rate || 80) / sampleRate);
        break;
      }
      case 'clear': {
        for (const v of this.voices.values()) v.dampMul = Math.exp(-60 / sampleRate);
        break;
      }
      case 'snap': {
        // 斷弦：一小段雜訊爆裂加上一聲很短的高頻「叮」
        this.snapEnv = m.gain || 0.6;
        this.pingRe = (m.gain || 0.6) * 0.5;
        this.pingIm = 0;
        break;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out.length > 1 ? out[1] : null;
    const N = L.length;
    if (this.buf.length < N) this.buf = new Float32Array(N);
    const buf = this.buf;

    for (const [id, v] of this.voices) {
      buf.fill(0, 0, N);
      const cnt = v.count;
      for (let m = 0; m < cnt; m++) {
        let re = v.re[m];
        let im = v.im[m];
        const c = v.c[m];
        const s = v.s[m];
        for (let i = 0; i < N; i++) {
          buf[i] += re;
          const t = re * c - im * s;
          im = re * s + im * c;
          re = t;
        }
        v.re[m] = re;
        v.im[m] = im;
      }

      let a = v.attack;
      let d = v.damp;
      const step = v.attackStep;
      const dm = v.dampMul;
      const pl = v.panL;
      const pr = v.panR;
      for (let i = 0; i < N; i++) {
        if (a < 1) {
          a += step;
          if (a > 1) a = 1;
        }
        d *= dm;
        const x = buf[i] * a * d;
        L[i] += x * pl;
        if (R) R[i] += x * pr;
      }
      v.attack = a;
      v.damp = d;

      // 尾端的高次模態衰減到聽不見就丟掉，省運算
      while (v.count > 0) {
        const k = v.count - 1;
        if (v.re[k] * v.re[k] + v.im[k] * v.im[k] < 1e-10) v.count--;
        else break;
      }
      if (v.count === 0 || v.damp < 1e-4) this.voices.delete(id);
    }

    if (this.snapEnv > 1e-4 || Math.abs(this.pingRe) + Math.abs(this.pingIm) > 1e-4) {
      const envMul = Math.exp(-1 / (0.018 * sampleRate));
      const w = (TWO_PI * 2600) / sampleRate;
      const pr = Math.exp(-1 / (0.05 * sampleRate));
      const pc = pr * Math.cos(w);
      const ps = pr * Math.sin(w);
      for (let i = 0; i < N; i++) {
        const n = Math.random() * 2 - 1;
        this.snapLp += 0.25 * (n - this.snapLp);
        const x = this.snapEnv * (0.7 * (n - this.snapLp) + 0.3 * n) + this.pingRe;
        this.snapEnv *= envMul;
        const t = this.pingRe * pc - this.pingIm * ps;
        this.pingIm = this.pingRe * ps + this.pingIm * pc;
        this.pingRe = t;
        L[i] += x * 0.7;
        if (R) R[i] += x * 0.7;
      }
    }

    // 去直流 + 軟性限幅
    for (let ch = 0; ch < (R ? 2 : 1); ch++) {
      const o = ch === 0 ? L : R;
      let x1 = this.dcX[ch];
      let y1 = this.dcY[ch];
      for (let i = 0; i < N; i++) {
        const x = o[i];
        const y = x - x1 + 0.9975 * y1;
        x1 = x;
        y1 = y;
        o[i] = Math.tanh(y);
      }
      this.dcX[ch] = x1;
      this.dcY[ch] = y1;
    }
    return true;
  }
}

registerProcessor('modal-processor', ModalProcessor);
