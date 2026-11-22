import { describe, expect, it } from 'vitest';
import { PinchDetector } from './pinch';

type Frame = [gapCm: number, speed: number];

/** 每 33 毫秒餵一格，回傳每一格結束後是否處於捏合狀態。 */
function feed(det: PinchDetector, frames: Frame[], start = 0): boolean[] {
  return frames.map(([gap, speed], i) => {
    det.update(gap / 100, speed, start + i * 33);
    return det.pinching;
  });
}

const repeat = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => f);

describe('捏合判定', () => {
  it('手靜止、指距持續很小，約 0.07 秒後成立', () => {
    const out = feed(new PinchDetector(), repeat(5, [2, 0.1]));
    expect(out).toEqual([false, false, true, true, true]);
  });

  it('撥弦時指尖只重疊一兩格，不算捏合', () => {
    const out = feed(new PinchDetector(), [[6, 1.2], [2, 1.5], [1.5, 1.4], [6, 1.2], [7, 0.8]]);
    expect(out).toEqual([false, false, false, false, false]);
  });

  it('手靜止時指尖只重疊一格也不算', () => {
    const out = feed(new PinchDetector(), [[6, 0], [2, 0], [6, 0], [6, 0]]);
    expect(out).toEqual([false, false, false, false]);
  });

  it('手快速揮動時，即使指距一直很小也不開始捏合', () => {
    const det = new PinchDetector();
    expect(feed(det, repeat(12, [1.8, 1.0])).every((p) => !p)).toBe(true);
    // 慢下來之後才成立
    const later = feed(det, repeat(5, [1.8, 0.1]), 12 * 33);
    expect(later[later.length - 1]).toBe(true);
  });

  it('確認期間指距彈開就重新計時', () => {
    const out = feed(new PinchDetector(), [[2, 0], [2, 0], [5, 0], [2, 0], [2, 0], [2, 0], [2, 0]]);
    expect(out).toEqual([false, false, false, false, false, true, true]);
  });

  it('確認期間指距小幅晃動（仍在 4 cm 內）不會中斷', () => {
    const out = feed(new PinchDetector(), [[2.2, 0], [3.6, 0], [3.0, 0], [2.0, 0]]);
    expect(out[2]).toBe(true);
  });

  it('捏住之後，單格的追蹤誤判不會放開；明確張開則立刻放開', () => {
    const det = new PinchDetector();
    feed(det, repeat(4, [2, 0]));
    expect(det.pinching).toBe(true);
    det.update(0.07, 0, 200); // 單格誤判成 7 cm
    expect(det.pinching).toBe(true);
    expect(det.solid).toBe(false); // 但這一格不可靠，不該拿來移動東西
    det.update(0.02, 2, 233); // 捏住之後移動多快都沒關係
    expect(det.pinching).toBe(true);
    expect(det.solid).toBe(true);
    det.update(0.1, 0, 266);
    expect(det.pinching).toBe(false);
  });

  it('指距半開（5〜9 cm）持續 0.1 秒才放開', () => {
    const det = new PinchDetector();
    feed(det, repeat(4, [2, 0]));
    // 第 4 格距離開始張開只過了 99 毫秒，第 5 格（132 毫秒）才放開
    expect(feed(det, repeat(5, [6, 0]), 200)).toEqual([true, true, true, true, false]);
  });

  it('拖動途中追蹤短暫失準而放開後，指距一變小就立刻恢復（不必重新確認，移動中也可以）', () => {
    const det = new PinchDetector();
    feed(det, repeat(12, [2, 0])); // 捏住約 0.4 秒
    const lost = feed(det, repeat(5, [6.5, 1.5]), 400);
    expect(lost[4]).toBe(false);
    det.update(0.02, 1.5, 400 + 5 * 33);
    expect(det.pinching).toBe(true);
  });

  it('明確張開放手之後，不適用立刻恢復', () => {
    const det = new PinchDetector();
    feed(det, repeat(12, [2, 0]));
    det.update(0.1, 0, 400); // 張開到 10 cm
    expect(det.pinching).toBe(false);
    det.update(0.02, 0, 433);
    expect(det.pinching).toBe(false); // 需要重新確認
  });
});
