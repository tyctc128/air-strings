// 介面：開始畫面、上方的材質盤、右側的張力／直徑面板。

import type { Game, Mode } from '../game/game';
import { GROUP_LABELS, MATERIALS, type Material, type MaterialGroup } from '../physics/materials';
import * as P from '../physics/string';
import type { Grade } from '../teach/tasks';
import { fmtDiameter, fmtFreq, fmtLength, fmtNote, fmtTension, panelLabels } from '../teach/wording';
import { clamp } from '../util/math';

export interface UICallbacks {
  onStart(useCamera: boolean): void;
  onClear(): void;
  onDelete(): void;
  onMode(mode: Mode): void;
  onSlowMo(on: boolean): void;
  onFullscreen(): void;
  /** 手的大小修正：1 = 大人，0.8 = 國小學童 */
  onHandScale(scale: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class UI {
  private paletteButtons = new Map<string, HTMLButtonElement>();
  private rects: { id: string; r: DOMRect }[] = [];
  private rectsAt = 0;

  private title = el('div', 'panel-title');
  private hint = el('div', 'panel-hint');
  private tension = el('input');
  private tensionVal = el('span', 'val');
  private diameter = el('input');
  private diameterVal = el('span', 'val');
  private outLength = el('b');
  private outFreq = el('b');
  private outNote = el('b');
  private loadBar = el('div', 'bar-fill');
  private loadVal = el('span', 'val');
  private cutBtn = el('button', 'ghost', '剪斷這條弦（Delete）');
  private lblTension = el('span');
  private lblDiameter = el('span');
  private lblLoad = el('span');
  private lblLength = el('span');
  private lblFreq = el('span');
  private lblNote = el('span');
  private handBtns = new Map<number, HTMLButtonElement>();
  private about = document.getElementById('about') as HTMLDialogElement;
  private dragging: HTMLInputElement | null = null;
  /** 弦被滑桿拉斷後，在放開滑桿之前不再接受輸入（否則會連下一條弦的設定一起推到極限） */
  private locked = false;

  private startEl = document.getElementById('start')!;
  private startBtn = el('button', 'primary', '開始');
  private statusEl = el('div', 'status');
  private tipEl = document.getElementById('tip')!;
  private modeBtns = new Map<Mode, HTMLButtonElement>();
  private slowBtn = el('button', 'chip teach-only', '慢動作');

  constructor(private game: Game, private cb: UICallbacks) {
    this.buildStart();
    this.buildPalette();
    this.buildPanel();
    this.buildModeBar();
    this.buildAbout();
    this.setGrade(game.grade);
    this.sync(performance.now());
  }

  /** 換年級：面板上的欄位名稱跟著換（數值格式在 sync 裡處理）。 */
  setGrade(grade: Grade): void {
    const l = panelLabels(grade);
    this.lblTension.textContent = l.tension;
    this.lblDiameter.textContent = l.diameter;
    this.lblLoad.textContent = l.load;
    this.lblLength.textContent = l.length;
    this.lblFreq.textContent = l.freq;
    this.lblNote.textContent = l.note;
  }

  setHandScale(scale: number): void {
    for (const [v, b] of this.handBtns) b.classList.toggle('on', v === scale);
  }

  // ───────── 說明 ─────────

  private buildAbout(): void {
    const d = this.about;
    d.append(el('h2', '', '這個模擬有多真實？'));
    d.append(
      el('p', '', '弦的音高、音色和延音長短，都是用真實材料的密度、楊氏模數、抗拉強度和內耗，代入弦振動的物理公式算出來的，沒有使用任何錄音。但有幾件事和真實世界不一樣：'),
    );
    const ul = el('ul');
    for (const text of [
      '真的弦如果懸在空中、沒有共鳴箱，幾乎聽不到聲音。這裡假設弦的端點裝了拾音器（像電吉他），直接把振動變成聲音。',
      '弦的端點假設不是完全固定，每次振動傳到端點都會損失一點能量；否則鋼弦會響將近一分鐘。',
      '拉長或縮短弦的時候，張力維持不變（像從捲弦器放線或收線），所以越長的弦聲音越低。',
      '弦與弦之間的共鳴，強度是假設的：真實樂器靠琴身傳遞振動，這裡沒有琴身。',
      '畫面上的電弧鋸齒是視覺效果。打開「慢動作」看到的才是真實的波形；弦的實際振幅只有幾毫米，畫面上放大了，倍率標在弦旁。',
      '材質的數值是手冊上的典型值，同一種材料實際上會因為製造方式而有差異。',
      '手和弦的長度是用手掌大小估計的，會有一成左右的誤差。',
    ]) {
      ul.append(el('li', '', text));
    }
    const foot = el('p', 'foot', '攝影機影像只在這台裝置上運算，不會上傳或儲存。互動的點子來自鄭各均的科技藝術作品（靈感來自 Pat Metheny 的 42 弦吉他）。');
    const close = el('button', 'primary small', '知道了');
    close.addEventListener('click', () => d.close());
    d.append(ul, foot, close);
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close(); // 點對話框外面的陰影處關閉
    });
  }

  // ───────── 模式列 ─────────

  private buildModeBar(): void {
    const root = document.getElementById('modebar')!;
    const seg = el('div', 'seg');
    for (const [mode, label] of [['teach', '教學'], ['exhibit', '展覽']] as [Mode, string][]) {
      const b = el('button', '', label);
      b.addEventListener('click', () => this.cb.onMode(mode));
      this.modeBtns.set(mode, b);
      seg.append(b);
    }
    this.slowBtn.title = '只顯示真實的波形並放慢，看清楚波在弦上來回跑（S）';
    this.slowBtn.addEventListener('click', () => this.cb.onSlowMo(!this.slowBtn.classList.contains('on')));
    const full = el('button', 'chip', '全螢幕');
    full.title = '切換全螢幕（F）';
    full.addEventListener('click', () => this.cb.onFullscreen());
    const info = el('button', 'chip', '說明');
    info.title = '這個模擬採用了哪些假設';
    info.addEventListener('click', () => this.about.showModal());
    root.append(seg, this.slowBtn, full, info);
  }

  /** 反映目前的模式：展覽模式隱藏面板與數據。 */
  setMode(mode: Mode): void {
    for (const [m, b] of this.modeBtns) b.classList.toggle('on', m === mode);
    document.body.classList.toggle('mode-exhibit', mode === 'exhibit');
  }

  setSlowMo(on: boolean): void {
    this.slowBtn.classList.toggle('on', on);
  }

  // ───────── 開始畫面 ─────────

  private buildStart(): void {
    const card = el('div', 'start-card');
    card.append(
      el('h1', '', '空中的弦'),
      el('p', 'lead', '用雙手在空中拉出一條弦，換不同的材質，聽聽真實物理算出來的聲音。'),
    );
    const steps = el('ol', 'steps');
    for (const [a, b] of [
      ['拉出一條弦', '兩隻手同時把拇指和食指捏起來，拉開，再放開。'],
      ['撥弦', '伸出食指掃過弦。動作越快，撥得越用力。'],
      ['改變音高', '捏住弦的端點拖動來改變長度；右側可以調整張力和粗細。'],
      ['搬動', '一隻手捏住弦的中段，就能提著整條弦走，音高不變。'],
      ['剪斷', '食指和中指比剪刀，把弦夾在中間再合起來。'],
      ['止音', '張開手掌按在弦上，聲音很快就停。'],
      ['泛音', '一根手指輕輕停在弦的正中間，另一隻手去撥，會聽到高八度的聲音。'],
      ['換材質', '食指在上方的材質上停一下，或直接用滑鼠點選。'],
    ]) {
      const li = el('li');
      li.append(el('b', '', a), el('span', '', b));
      steps.append(li);
    }
    const mouse = el('button', 'link', '不使用攝影機，改用滑鼠操作');
    this.startBtn.addEventListener('click', () => this.cb.onStart(true));
    mouse.addEventListener('click', () => this.cb.onStart(false));
    const foot = el('p', 'foot', '攝影機影像只在這台裝置上運算，不會上傳或儲存。　靈感來自鄭各均的科技藝術作品。');
    card.append(steps, this.startBtn, mouse, this.statusEl, foot);
    this.startEl.append(card);
  }

  setStatus(text: string, busy = false): void {
    this.statusEl.textContent = text;
    this.startBtn.disabled = busy;
  }

  hideStart(): void {
    this.startEl.classList.add('hidden');
    document.body.classList.add('playing');
  }

  /** 畫面下方的操作提示。 */
  setTip(text: string): void {
    if (this.tipEl.textContent !== text) this.tipEl.textContent = text;
    this.tipEl.classList.toggle('hidden', text === '');
  }

  // ───────── 材質盤 ─────────

  private buildPalette(): void {
    const root = document.getElementById('palette')!;
    const groups: MaterialGroup[] = ['instrument', 'everyday', 'special'];
    for (const g of groups) {
      const box = el('div', 'group');
      box.append(el('span', 'group-label', GROUP_LABELS[g]));
      const row = el('div', 'group-row');
      for (const m of MATERIALS.filter((x) => x.group === g)) {
        const b = el('button', 'mat');
        b.title = m.hint;
        const sw = el('i', 'swatch');
        sw.style.background = m.color;
        sw.style.height = `${clamp(m.defaultDiameter * 1000 * 2.2, 2, 7).toFixed(1)}px`;
        b.append(sw, el('span', '', m.name));
        b.addEventListener('click', () => {
          this.game.setMaterial(m);
          this.sync(performance.now());
        });
        this.paletteButtons.set(m.id, b);
        row.append(b);
      }
      box.append(row);
      root.append(box);
    }
  }

  /** 螢幕座標 (x, y) 落在哪個材質按鈕上。 */
  materialAt(x: number, y: number, now: number): string | null {
    if (now - this.rectsAt > 500) {
      this.rects = [...this.paletteButtons].map(([id, b]) => ({ id, r: b.getBoundingClientRect() }));
      this.rectsAt = now;
    }
    for (const { id, r } of this.rects) {
      if (x >= r.left && x <= r.right && y >= r.top - 6 && y <= r.bottom + 10) return id;
    }
    return null;
  }

  setHover(ids: (string | null)[]): void {
    for (const [id, b] of this.paletteButtons) b.classList.toggle('hover', ids.includes(id));
  }

  // ───────── 面板 ─────────

  private buildPanel(): void {
    const root = document.getElementById('panel')!;
    const slider = (input: HTMLInputElement, label: HTMLElement, val: HTMLElement) => {
      input.type = 'range';
      input.min = '0';
      input.max = '1000';
      input.step = '1';
      const row = el('label', 'slider');
      const head = el('div', 'slider-head');
      head.append(label, val);
      row.append(head, input);
      input.addEventListener('pointerdown', () => (this.dragging = input));
      const release = () => {
        this.dragging = null;
        this.locked = false;
      };
      input.addEventListener('pointerup', release);
      input.addEventListener('pointercancel', release);
      input.addEventListener('change', release);
      input.addEventListener('blur', release);
      return row;
    };

    const edit = (apply: () => void) => {
      if (this.locked) return;
      const before = this.game.selected;
      apply();
      if (before && !this.game.strings.includes(before)) this.locked = true;
      this.sync(performance.now());
    };
    this.tension.addEventListener('input', () =>
      edit(() => {
        const { m, d } = this.current();
        this.game.setTension(this.tensionFromSlider(m, d, +this.tension.value), performance.now());
      }),
    );
    this.diameter.addEventListener('input', () =>
      edit(() => {
        const { m } = this.current();
        const [lo, hi] = m.diameterRange;
        this.game.setDiameter(lo + ((hi - lo) * +this.diameter.value) / 1000, performance.now());
      }),
    );

    const outs = el('div', 'outs');
    const out = (label: HTMLElement, b: HTMLElement) => {
      const d = el('div');
      d.append(label, b);
      return d;
    };
    outs.append(out(this.lblLength, this.outLength), out(this.lblFreq, this.outFreq), out(this.lblNote, this.outNote));

    const load = el('div', 'load');
    const loadHead = el('div', 'slider-head');
    loadHead.append(this.lblLoad, this.loadVal);
    const bar = el('div', 'bar');
    bar.append(this.loadBar);
    load.append(loadHead, bar);

    this.cutBtn.addEventListener('click', () => {
      this.cb.onDelete();
      this.sync(performance.now());
    });
    const clear = el('button', 'ghost', '全部清除（C）');
    clear.addEventListener('click', () => this.cb.onClear());
    const actions = el('div', 'actions');
    actions.append(this.cutBtn, clear);

    // 手的大小：弦的真實長度是拿手掌當尺換算的，小朋友的手比較小
    const hand = el('div', 'hand-row');
    const handSeg = el('div', 'seg small');
    for (const [scale, label] of [[1, '大人'], [0.8, '小朋友']] as [number, string][]) {
      const b = el('button', '', label);
      b.addEventListener('click', () => this.cb.onHandScale(scale));
      this.handBtns.set(scale, b);
      handSeg.append(b);
    }
    hand.append(el('span', '', '誰的手'), handSeg);

    root.append(
      this.title, this.hint,
      slider(this.tension, this.lblTension, this.tensionVal),
      slider(this.diameter, this.lblDiameter, this.diameterVal),
      load, outs, actions, hand,
    );
  }

  private current(): { m: Material; d: number; T: number } {
    const s = this.game.selected;
    if (s) return { m: s.material, d: s.diameter, T: s.tension };
    const set = this.game.settingsFor(this.game.material);
    return { m: this.game.material, d: set.diameter, T: set.tension };
  }

  // 張力滑桿是對數刻度：最右邊比斷裂張力再多 10%，推到底弦就會斷
  private tensionRange(m: Material, d: number): [number, number] {
    const brk = P.breakingTension(m, d);
    return [brk / 300, brk * 1.1];
  }

  private tensionFromSlider(m: Material, d: number, v: number): number {
    const [lo, hi] = this.tensionRange(m, d);
    return lo * Math.pow(hi / lo, v / 1000);
  }

  private sliderFromTension(m: Material, d: number, T: number): number {
    const [lo, hi] = this.tensionRange(m, d);
    return clamp((Math.log(T / lo) / Math.log(hi / lo)) * 1000, 0, 1000);
  }

  /** 把遊戲狀態同步到介面（每 100 毫秒與每次操作後呼叫）。 */
  sync(_now: number): void {
    const g = this.game;
    const s = g.selected;
    const { m, d, T } = this.current();

    for (const [id, b] of this.paletteButtons) b.classList.toggle('active', id === g.material.id);

    this.cutBtn.disabled = !s;
    this.title.textContent = s ? `調整中：${m.name}` : `下一條弦：${m.name}`;
    this.title.style.setProperty('--c', m.color);
    this.hint.textContent = m.hint;

    if (this.dragging !== this.tension || this.locked) this.tension.value = String(Math.round(this.sliderFromTension(m, d, T)));
    if (this.dragging !== this.diameter || this.locked) {
      const [lo, hi] = m.diameterRange;
      this.diameter.value = String(Math.round(((d - lo) / (hi - lo)) * 1000));
    }
    const grade = g.grade;
    this.tensionVal.textContent = fmtTension(T, grade);
    this.diameterVal.textContent = fmtDiameter(d, grade);

    const ratio = P.stressRatio(m, d, T);
    this.loadVal.textContent = `${Math.round(ratio * 100)}%`;
    this.loadBar.style.width = `${clamp(ratio, 0, 1) * 100}%`;
    this.loadBar.dataset.level = ratio > 0.85 ? 'high' : ratio > 0.6 ? 'mid' : 'low';

    if (s) {
      const note = P.noteInfo(s.f0);
      this.outLength.textContent = fmtLength(s.length, grade);
      this.outFreq.textContent = grade === 'elementary' ? `${s.f0.toFixed(0)} 次` : fmtFreq(s.f0, grade);
      this.outNote.textContent = grade === 'elementary' ? note.solfege : `${fmtNote(s.f0, grade)}（${note.solfege}）`;
    } else {
      this.outLength.textContent = '—';
      this.outFreq.textContent = '—';
      this.outNote.textContent = '—';
    }
  }
}
