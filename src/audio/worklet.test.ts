// 在 Node 裡直接跑 AudioWorklet 的程式，驗證合成出來的聲音頻率與衰減真的等於物理模組給的數值。
import { beforeAll, describe, expect, it } from 'vitest';
import { materialById } from '../physics/materials';
import * as P from '../physics/string';

const SR = 48000;

interface Proc {
  voices: Map<number, unknown>;
  handle(msg: unknown): void;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}
let Processor: new () => Proc;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = SR;
  g.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} };
  };
  g.registerProcessor = (_name: string, cls: new () => Proc) => {
    Processor = cls;
  };
  // @ts-expect-error 純 JS 的 worklet 檔，沒有型別宣告
  await import('../../public/audio/modal-processor.js');
});

function render(proc: Proc, seconds: number): Float32Array {
  const blocks = Math.ceil((seconds * SR) / 128);
  const out = new Float32Array(blocks * 128);
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    proc.process([], [[L, R]]);
    out.set(L, b * 128);
  }
  return out;
}

/** 用上升過零點估計頻率。 */
function zeroCrossFreq(x: Float32Array, from: number, to: number): number {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      else n++;
      last = t;
    }
  }
  return (n * SR) / (last - first);
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

describe('模態合成器', () => {
  it('單一模態：頻率與衰減率正確', () => {
    const proc = new Processor();
    proc.handle({
      type: 'pluck', id: 1, pan: -1,
      freq: new Float32Array([440]), amp: new Float32Array([0.05]), decay: new Float32Array([3]),
    });
    const x = render(proc, 0.5);
    expect(zeroCrossFreq(x, 0.05 * SR, 0.45 * SR)).toBeCloseTo(440, 1);
    const ratio = rms(x, 0.3 * SR, 0.4 * SR) / rms(x, 0.1 * SR, 0.2 * SR);
    expect(ratio).toBeCloseTo(Math.exp(-3 * 0.2), 2);
  });

  it('真實的鋼弦：聽到的基頻等於公式算出的基頻', () => {
    const steel = materialById('steel');
    const modes = P.computeModes(steel, 0.3e-3, 80, 0.65);
    // 只撥出基音（撥在正中間、只取第 1 個模態）來量頻率
    const amp = new Float32Array(modes.count);
    amp[0] = 0.05;
    const proc = new Processor();
    proc.handle({ type: 'pluck', id: 7, pan: -1, freq: modes.freq, amp, decay: modes.decay });
    const x = render(proc, 0.4);
    const expected = P.fundamental(steel, 0.3e-3, 80, 0.65);
    expect(Math.abs(zeroCrossFreq(x, 0.05 * SR, 0.38 * SR) - expected) / expected).toBeLessThan(0.002);
  });

  it('改變弦長（retune）後頻率跟著變', () => {
    const proc = new Processor();
    proc.handle({
      type: 'pluck', id: 2, pan: -1,
      freq: new Float32Array([200]), amp: new Float32Array([0.05]), decay: new Float32Array([1]),
    });
    render(proc, 0.1);
    proc.handle({ type: 'retune', id: 2, freq: new Float32Array([300]), decay: new Float32Array([1]) });
    const x = render(proc, 0.4);
    expect(zeroCrossFreq(x, 0.02 * SR, 0.38 * SR)).toBeCloseTo(300, 1);
  });

  it('止音後很快安靜，voice 會被回收', () => {
    const proc = new Processor();
    proc.handle({
      type: 'pluck', id: 3, pan: -1,
      freq: new Float32Array([220]), amp: new Float32Array([0.3]), decay: new Float32Array([0.5]),
    });
    render(proc, 0.1);
    proc.handle({ type: 'damp', id: 3, rate: 80 });
    const x = render(proc, 0.3);
    expect(rms(x, 0.2 * SR, 0.29 * SR)).toBeLessThan(1e-4);
    expect(proc.voices.size).toBe(0);
  });

  it('共鳴激發：靜止的弦被帶動後以自己的頻率發聲，而且是慢慢變大聲', () => {
    const proc = new Processor();
    proc.handle({
      type: 'excite', id: 5, pan: -1,
      freq: new Float32Array([330]), amp: new Float32Array([0.05]), decay: new Float32Array([1]),
    });
    const x = render(proc, 0.4);
    expect(zeroCrossFreq(x, 0.15 * SR, 0.38 * SR)).toBeCloseTo(330, 1);
    expect(rms(x, 0, 0.02 * SR)).toBeLessThan(rms(x, 0.15 * SR, 0.17 * SR) * 0.35);
  });

  it('共鳴激發疊加在正在響的弦上，不會打斷原本的聲音', () => {
    const proc = new Processor();
    proc.handle({
      type: 'pluck', id: 6, pan: -1,
      freq: new Float32Array([200]), amp: new Float32Array([0.05]), decay: new Float32Array([0.5]),
    });
    render(proc, 0.1);
    const before = rms(render(proc, 0.05), 0, 0.05 * SR);
    proc.handle({
      type: 'excite', id: 6, pan: -1,
      freq: new Float32Array([200, 400]), amp: new Float32Array([0, 0.05]), decay: new Float32Array([0.5, 0.5]),
    });
    const after = rms(render(proc, 0.05), 0, 0.05 * SR);
    expect(after).toBeGreaterThan(before * 1.2);
    expect(proc.voices.size).toBe(1);
  });

  it('超過取樣頻率一半的模態不會被合成（不產生疊頻）', () => {
    const proc = new Processor();
    proc.handle({
      type: 'pluck', id: 4, pan: -1,
      freq: new Float32Array([1000, 30000]), amp: new Float32Array([0.05, 0.5]), decay: new Float32Array([1, 1]),
    });
    const x = render(proc, 0.2);
    expect(zeroCrossFreq(x, 0.02 * SR, 0.18 * SR)).toBeCloseTo(1000, 0);
  });
});
