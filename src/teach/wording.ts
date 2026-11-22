// 依年級切換的用詞與數值格式。
// 國小：口語、整數、音名用 Do Re Mi、把「赫茲」說成「每秒幾次」。
// 國中以上：使用頻率、赫茲、牛頓等單位，數值多一位小數，音名加上音分偏差。

import * as P from '../physics/string';
import type { Grade } from './tasks';

export function fmtLength(meters: number, grade: Grade): string {
  const cm = meters * 100;
  return grade === 'elementary' ? `${cm.toFixed(0)} 公分` : `${cm.toFixed(1)} cm`;
}

export function fmtFreq(f: number, grade: Grade): string {
  if (grade === 'elementary') return `${f.toFixed(0)} 次/秒`;
  return `${f >= 1000 ? f.toFixed(0) : f.toFixed(1)} Hz`;
}

export function fmtNote(f: number, grade: Grade): string {
  const n = P.noteInfo(f);
  if (grade === 'elementary') return n.solfege;
  const cents = n.cents === 0 ? '' : n.cents > 0 ? ` +${n.cents}¢` : ` −${-n.cents}¢`;
  return `${n.name}${cents}`;
}

export function fmtTension(newtons: number, grade: Grade): string {
  const v = newtons >= 10 ? newtons.toFixed(0) : newtons.toFixed(1);
  return grade === 'elementary' ? `${v} 牛頓` : `${v} N`;
}

export function fmtDiameter(meters: number, grade: Grade): string {
  return grade === 'elementary' ? `${(meters * 1000).toFixed(1)} 毫米` : `${(meters * 1000).toFixed(2)} mm`;
}

/** 弦旁的標籤。 */
export function stringLabel(
  s: { materialName: string; length: number; tension: number; f0: number }, grade: Grade, selected: boolean,
): string {
  if (grade === 'elementary') {
    const base = `${fmtNote(s.f0, grade)} · ${fmtFreq(s.f0, grade)}`;
    return selected ? `${s.materialName} ${fmtLength(s.length, grade)} · ${base}` : base;
  }
  const base = `${fmtFreq(s.f0, grade)} · ${fmtNote(s.f0, grade)}`;
  return selected
    ? `${s.materialName} ${fmtLength(s.length, grade)} · ${fmtTension(s.tension, grade)} · ${base}`
    : base;
}

/** 面板上各欄位的名稱。 */
export function panelLabels(grade: Grade) {
  return grade === 'elementary'
    ? { tension: '鬆緊（張力）', diameter: '粗細（直徑）', load: '離斷掉還有多遠', length: '長度', freq: '每秒振動', note: '音名' }
    : { tension: '張力', diameter: '直徑', load: '已達斷裂強度', length: '弦長', freq: '頻率', note: '音名' };
}
