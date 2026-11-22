import { describe, expect, it } from 'vitest';
import { MATERIALS, materialById } from './materials';
import * as P from './string';

const steel = materialById('steel');
const nylon = materialById('nylon');
const bronze = materialById('bronze');
const rubber = materialById('rubber');

describe('基頻', () => {
  it('吉他第一弦（鋼 0.012 吋、23.3 磅、弦長 648 mm）≈ E4 329.6 Hz', () => {
    const f = P.fundamental(steel, 0.305e-3, 23.3 * 4.448, 0.648);
    expect(f).toBeGreaterThan(329.6 * 0.98);
    expect(f).toBeLessThan(329.6 * 1.02);
  });

  it('吉他第五弦（青銅纏弦 0.042 吋、29.9 磅）≈ A2 110 Hz', () => {
    const f = P.fundamental(bronze, 1.067e-3, 29.9 * 4.448, 0.648);
    expect(f).toBeGreaterThan(110 * 0.95);
    expect(f).toBeLessThan(110 * 1.05);
  });

  it('弦長減半，頻率加倍', () => {
    const a = P.fundamental(nylon, 0.7e-3, 65, 0.6);
    const b = P.fundamental(nylon, 0.7e-3, 65, 0.3);
    expect(b / a).toBeCloseTo(2, 6);
  });

  it('張力變 4 倍，頻率變 2 倍', () => {
    const a = P.fundamental(steel, 0.3e-3, 20, 0.5);
    const b = P.fundamental(steel, 0.3e-3, 80, 0.5);
    expect(b / a).toBeCloseTo(2, 6);
  });

  it('直徑加倍（線密度變 4 倍），頻率減半', () => {
    const a = P.fundamental(steel, 0.3e-3, 80, 0.5);
    const b = P.fundamental(steel, 0.6e-3, 80, 0.5);
    expect(b / a).toBeCloseTo(0.5, 6);
  });
});

describe('非諧性與阻尼', () => {
  it('泛音頻率略高於整數倍，而且越高次偏越多', () => {
    const f1 = P.modeFrequency(steel, 0.3e-3, 80, 0.5, 1);
    const f10 = P.modeFrequency(steel, 0.3e-3, 80, 0.5, 10);
    const f20 = P.modeFrequency(steel, 0.3e-3, 80, 0.5, 20);
    expect(f10 / f1).toBeGreaterThan(10);
    expect(f20 / f1 / 20).toBeGreaterThan(f10 / f1 / 10);
  });

  it('同樣尺寸下，鋼比尼龍硬所以非諧性較大', () => {
    expect(P.inharmonicity(steel, 0.5e-3, 60, 0.5)).toBeGreaterThan(P.inharmonicity(nylon, 0.5e-3, 60, 0.5));
  });

  it('橡皮筋衰減得比鋼弦快很多', () => {
    const r = P.modeDecay(rubber, 2e-3, 3, 0.3, 1);
    const s = P.modeDecay(steel, 0.3e-3, 80, 0.3, 1);
    expect(r).toBeGreaterThan(s * 3);
  });

  it('高次模態衰減較快，衰減率皆為正', () => {
    for (const m of MATERIALS) {
      const set = P.computeModes(m, m.defaultDiameter, m.defaultTension, 0.5);
      expect(set.count).toBeGreaterThan(0);
      expect(set.decay[0]).toBeGreaterThan(0);
      expect(set.decay[set.count - 1]).toBeGreaterThanOrEqual(set.decay[0]);
    }
  });

  it('鋼弦基音的延音在合理範圍（T60 約 3〜20 秒）', () => {
    const t60 = Math.log(1000) / P.modeDecay(steel, 0.3e-3, 80, 0.65, 1);
    expect(t60).toBeGreaterThan(3);
    expect(t60).toBeLessThan(20);
  });
});

describe('撥弦', () => {
  it('端點受力振幅 An 與位移振幅 cn 互相一致：An = T·cn·nπ/L', () => {
    const T = 65, L = 0.55, p = 0.23, F = 3;
    const h = P.slipDisplacement(F, T, L, p);
    const c = P.displacementAmplitudes(h, p, L, 12);
    const A = P.forceAmplitudes(F, p, L, 12);
    for (let i = 0; i < 12; i++) {
      expect((T * c[i] * (i + 1) * Math.PI) / L).toBeCloseTo(A[i], 5);
    }
  });

  it('撥在正中間時偶數泛音消失', () => {
    const A = P.forceAmplitudes(2, 0.5, 0.6, 8);
    expect(Math.abs(A[1])).toBeLessThan(1e-6);
    expect(Math.abs(A[3])).toBeLessThan(1e-6);
    expect(Math.abs(A[0])).toBeGreaterThan(0.5);
  });

  it('拉開位移與施力互為反函數', () => {
    const h = P.slipDisplacement(4, 80, 0.6, 0.3);
    expect(P.holdForce(h, 80, 0.6, 0.3)).toBeCloseTo(4, 9);
  });

  it('低張力的弦要拉得比高張力的遠才會滑脫', () => {
    expect(P.slipDisplacement(2, 3, 0.3, 0.5)).toBeGreaterThan(P.slipDisplacement(2, 80, 0.3, 0.5) * 10);
  });
});

describe('強度', () => {
  it('每種材質的預設張力都在斷裂張力的 80% 以下', () => {
    for (const m of MATERIALS) {
      const ratio = P.stressRatio(m, m.defaultDiameter, m.defaultTension);
      expect(ratio, m.name).toBeGreaterThan(0.02);
      expect(ratio, m.name).toBeLessThan(0.8);
    }
  });

  it('鋼弦 0.3 mm 的斷裂張力 ≈ 163 N', () => {
    expect(P.breakingTension(steel, 0.3e-3)).toBeCloseTo(162.6, 0);
  });

  it('纏弦只有芯線受力', () => {
    expect(P.loadArea(bronze, 1e-3)).toBeCloseTo((Math.PI * 0.4e-3 ** 2) / 4, 12);
  });
});

describe('止音與泛音', () => {
  const base = new Float32Array([1, 2, 3, 4, 5, 6]);

  it('手掌止音讓所有模態都衰減得更快', () => {
    const d = P.effectiveDecay(base, P.PALM_DAMPING, null);
    for (let i = 0; i < base.length; i++) expect(d[i]).toBeCloseTo(base[i] + P.PALM_DAMPING, 5);
  });

  it('輕觸正中間：偶數泛音（中點是節點）不受影響，奇數泛音被吸收', () => {
    const d = P.effectiveDecay(base, 0, 0.5);
    expect(d[1]).toBeCloseTo(base[1], 4); // 第 2 泛音
    expect(d[3]).toBeCloseTo(base[3], 4); // 第 4 泛音
    expect(d[0]).toBeCloseTo(base[0] + P.TOUCH_DAMPING, 3); // 基音
    expect(d[2]).toBeCloseTo(base[2] + P.TOUCH_DAMPING, 3); // 第 3 泛音
  });

  it('輕觸三分之一處：只有 3 的倍數泛音留下來', () => {
    const d = P.effectiveDecay(base, 0, 1 / 3);
    expect(d[2] - base[2]).toBeLessThan(1e-3);
    expect(d[5] - base[5]).toBeLessThan(1e-3);
    expect(d[0] - base[0]).toBeGreaterThan(200);
    expect(d[1] - base[1]).toBeGreaterThan(200);
  });

  it('沒碰到任何東西時衰減率不變', () => {
    expect([...P.effectiveDecay(base, 0, null)]).toEqual([...base]);
  });

  it('辨認節點位置', () => {
    expect(P.nearestNode(0.5)).toEqual({ k: 1, n: 2 });
    expect(P.nearestNode(0.34)).toEqual({ k: 1, n: 3 });
    expect(P.nearestNode(0.745)).toEqual({ k: 3, n: 4 });
    expect(P.nearestNode(0.43)).toBeNull();
  });
});

describe('共鳴', () => {
  it('頻率相同時響應最強，差 10 音分降為一半，差太多就沒有反應', () => {
    expect(P.sympatheticGain(440, 440)).toBe(1);
    expect(P.sympatheticGain(440 * 2 ** (10 / 1200), 440)).toBeCloseTo(0.5, 2);
    expect(P.sympatheticGain(466.16, 440)).toBe(0); // 差一個半音
  });

  it('撥低八度的弦會帶動高八度弦的基音（第 2 泛音與它同頻）', () => {
    const low = P.computeModes(steel, 0.3e-3, 80, 0.6, 12);
    const high = P.computeModes(steel, 0.3e-3, 80, 0.3, 12);
    const force = P.forceAmplitudes(3, 0.2, 0.6, low.count);
    const out = P.sympatheticForces(low.freq, force, high.freq, 6);
    expect(Math.abs(out[0])).toBeGreaterThan(0.02);
    expect(Math.abs(out[0])).toBeLessThan(Math.abs(force[1]) * P.SYMPATHETIC_COUPLING * 1.001);
  });

  it('音高不成簡單比例的兩條弦不會共鳴', () => {
    const a = P.computeModes(steel, 0.3e-3, 80, 0.6, 12);
    const b = P.computeModes(steel, 0.3e-3, 80, 0.6 / 1.37, 6);
    const out = P.sympatheticForces(a.freq, P.forceAmplitudes(3, 0.2, 0.6, a.count), b.freq, 3);
    expect(Math.abs(out[0])).toBeLessThan(1e-3);
  });
});

describe('音階吸附', () => {
  it('吸附到五聲音階裡最近的音', () => {
    expect(P.snapFrequency(450, P.PENTATONIC)).toBeCloseTo(440, 6); // La
    expect(P.snapFrequency(300, P.PENTATONIC)).toBeCloseTo(293.66, 1); // Re
    expect(P.snapFrequency(350, P.PENTATONIC)).toBeCloseTo(329.63, 1); // Fa 不在音階裡 → Mi
  });

  it('已經在音階上的音不會被移動', () => {
    expect(P.snapFrequency(261.63, P.PENTATONIC)).toBeCloseTo(261.63, 2);
  });
});

describe('音名', () => {
  it('440 Hz = A4', () => {
    const n = P.noteInfo(440);
    expect(n.name).toBe('A4');
    expect(n.solfege).toBe('La');
    expect(n.cents).toBe(0);
  });
  it('261.63 Hz = C4', () => {
    expect(P.noteInfo(261.63).name).toBe('C4');
  });
  it('偏高時音分為正', () => {
    expect(P.noteInfo(450).cents).toBeGreaterThan(0);
  });
});
