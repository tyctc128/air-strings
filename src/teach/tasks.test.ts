import { describe, expect, it } from 'vitest';
import { materialById } from '../physics/materials';
import * as P from '../physics/string';
import { type PluckRecord, TASKS, completed, emptyContext, recordPluck } from './tasks';

let nextString = 1;

/** 用真實的物理算出一筆撥弦紀錄。 */
function pluck(over: Partial<PluckRecord> & { materialId?: string } = {}): PluckRecord {
  const m = materialById(over.materialId ?? 'steel');
  const tension = over.tension ?? m.defaultTension;
  const diameter = over.diameter ?? m.defaultDiameter;
  const length = over.length ?? 0.5;
  return {
    stringId: over.stringId ?? nextString++,
    materialId: m.id,
    tension,
    diameter,
    length,
    f0: over.f0 ?? P.fundamental(m, diameter, tension, length),
    touchNode: over.touchNode ?? null,
  };
}

function ctxWith(...records: PluckRecord[]) {
  const ctx = emptyContext();
  for (const r of records) recordPluck(ctx, r);
  return ctx;
}

const isDone = (grade: 'elementary' | 'junior', id: string, ctx: ReturnType<typeof emptyContext>) =>
  completed(grade, ctx).includes(id);

describe('任務卡內容', () => {
  it('兩個年級各有 7 張，id 不重複，文字齊全', () => {
    for (const grade of ['elementary', 'junior'] as const) {
      const list = TASKS[grade];
      expect(list).toHaveLength(7);
      expect(new Set(list.map((t) => t.id)).size).toBe(7);
      for (const t of list) {
        expect(t.title.length).toBeGreaterThan(2);
        expect(t.body.length).toBeGreaterThan(10);
        expect(t.hint.length).toBeGreaterThan(5);
      }
    }
  });

  it('什麼都還沒做時，沒有任何任務完成', () => {
    expect(completed('elementary', emptyContext())).toEqual([]);
    expect(completed('junior', emptyContext())).toEqual([]);
  });

  it('國小的任務不出現公式與「頻率」這類用詞', () => {
    for (const t of TASKS.elementary) {
      expect(t.title + t.body + t.hint).not.toMatch(/頻率|Hz|牛頓|音分|√/);
    }
  });
});

describe('國小任務', () => {
  it('撥響任何一條弦就完成第一張', () => {
    expect(isDone('elementary', 'e-first', ctxWith(pluck()))).toBe(true);
  });

  it('長短：同材質、長度差 1.5 倍以上的兩條弦都撥過', () => {
    expect(isDone('elementary', 'e-length', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.3 })))).toBe(true);
    expect(isDone('elementary', 'e-length', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.5 })))).toBe(false);
    // 同時改了鬆緊就不算（變因沒有控制好）
    expect(
      isDone('elementary', 'e-length', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.3, tension: 30 }))),
    ).toBe(false);
    // 換了材質也不算
    expect(
      isDone('elementary', 'e-length', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.3, materialId: 'nylon', tension: 80, diameter: 0.3e-3 }))),
    ).toBe(false);
  });

  it('鬆緊：同一條弦調緊 1.5 倍以上，前後各撥一次', () => {
    const a = pluck({ stringId: 9, tension: 40 });
    expect(isDone('elementary', 'e-tension', ctxWith(a, pluck({ stringId: 9, tension: 70 })))).toBe(true);
    expect(isDone('elementary', 'e-tension', ctxWith(a, pluck({ stringId: 9, tension: 45 })))).toBe(false);
  });

  it('粗細：同一條弦變粗 1.4 倍以上，前後各撥一次', () => {
    const a = pluck({ stringId: 9, diameter: 0.3e-3 });
    expect(isDone('elementary', 'e-thickness', ctxWith(a, pluck({ stringId: 9, diameter: 0.5e-3 })))).toBe(true);
    expect(isDone('elementary', 'e-thickness', ctxWith(a, pluck({ stringId: 9, diameter: 0.33e-3 })))).toBe(false);
  });

  it('材質：兩種材質、長度差不多的兩條弦都撥過', () => {
    expect(isDone('elementary', 'e-material', ctxWith(pluck(), pluck({ materialId: 'rubber', length: 0.52 })))).toBe(true);
    expect(isDone('elementary', 'e-material', ctxWith(pluck(), pluck({ materialId: 'rubber', length: 0.2 })))).toBe(false);
  });

  it('止音與斷弦', () => {
    const ctx = emptyContext();
    expect(isDone('elementary', 'e-mute', ctx)).toBe(false);
    ctx.mutes = 1;
    expect(isDone('elementary', 'e-mute', ctx)).toBe(true);
    ctx.breaks.push({ materialId: 'cotton', tension: 30 });
    expect(isDone('elementary', 'e-break', ctx)).toBe(true);
  });
});

describe('國中任務', () => {
  it('調音：頻率在任一個八度的 A、誤差 10 音分內', () => {
    expect(isDone('junior', 'j-tune', ctxWith(pluck({ f0: 441 })))).toBe(true);
    expect(isDone('junior', 'j-tune', ctxWith(pluck({ f0: 219.5 })))).toBe(true);
    expect(isDone('junior', 'j-tune', ctxWith(pluck({ f0: 450 })))).toBe(false);
  });

  it('八度：同材質同張力，弦長減半（頻率 2 倍）', () => {
    expect(isDone('junior', 'j-octave', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.3 })))).toBe(true);
    expect(isDone('junior', 'j-octave', ctxWith(pluck({ length: 0.6 }), pluck({ length: 0.33 })))).toBe(false);
  });

  it('張力 4 倍：真實物理下頻率剛好變 2 倍', () => {
    const a = pluck({ stringId: 5, tension: 20 });
    const b = pluck({ stringId: 5, tension: 80 });
    expect(b.f0 / a.f0).toBeCloseTo(2, 2);
    expect(isDone('junior', 'j-tension', ctxWith(a, b))).toBe(true);
    expect(isDone('junior', 'j-tension', ctxWith(a, pluck({ stringId: 5, tension: 40 })))).toBe(false);
  });

  it('不同材質相同音高', () => {
    const steel = pluck({ length: 0.5 });
    const copperLength = 0.5 * (P.fundamental(materialById('copper'), 0.4e-3, 15, 0.5) / steel.f0);
    const copper = pluck({ materialId: 'copper', length: copperLength });
    expect(Math.abs(copper.f0 - steel.f0)).toBeLessThan(0.5);
    expect(isDone('junior', 'j-material', ctxWith(steel, copper))).toBe(true);
    expect(isDone('junior', 'j-material', ctxWith(steel, pluck({ materialId: 'copper', length: 0.5 })))).toBe(false);
  });

  it('泛音：1/2 和 1/3 都要做過', () => {
    const half = pluck({ touchNode: { k: 1, n: 2 } });
    expect(isDone('junior', 'j-harmonic', ctxWith(half))).toBe(false);
    expect(isDone('junior', 'j-harmonic', ctxWith(half, pluck({ touchNode: { k: 2, n: 3 } })))).toBe(true);
  });

  it('共鳴，以及比較兩種材質的強度', () => {
    const ctx = emptyContext();
    ctx.resonances = 1;
    expect(isDone('junior', 'j-resonance', ctx)).toBe(true);
    ctx.breaks.push({ materialId: 'steel', tension: 163 });
    ctx.breaks.push({ materialId: 'steel', tension: 163 });
    expect(isDone('junior', 'j-strength', ctx)).toBe(false);
    ctx.breaks.push({ materialId: 'cotton', tension: 30 });
    expect(isDone('junior', 'j-strength', ctx)).toBe(true);
  });
});

describe('紀錄', () => {
  it('只保留最近 60 次撥弦', () => {
    const ctx = emptyContext();
    for (let i = 0; i < 100; i++) recordPluck(ctx, pluck());
    expect(ctx.plucks).toHaveLength(60);
  });
});
