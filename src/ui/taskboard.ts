// 任務卡面板：顯示目前的任務、提示與完成進度，並依遊戲裡發生的事自動打勾。

import type { Game } from '../game/game';
import { type Grade, TASKS, type TaskContext, completed, emptyContext, recordPluck } from '../teach/tasks';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const storeKey = (grade: Grade) => `air-strings.tasks.${grade}`;

export class TaskBoard {
  grade: Grade = 'elementary';
  private index = 0;
  private ctx: TaskContext = emptyContext();
  private done = new Set<string>();
  private advanceTimer = 0;

  private root = document.getElementById('tasks')!;
  private count = el('span', 'task-count');
  private title = el('h2', 'task-title');
  private body = el('p', 'task-body');
  private hint = el('p', 'task-hint');
  private hintBtn = el('button', 'link', '給我提示');
  private badge = el('span', 'task-badge', '完成');
  private dots = el('div', 'task-dots');
  private gradeBtns = new Map<Grade, HTMLButtonElement>();

  constructor(game: Game, onGrade: (g: Grade) => void) {
    const head = el('div', 'task-head');
    const seg = el('div', 'seg small');
    for (const [g, label] of [['elementary', '國小'], ['junior', '國中']] as [Grade, string][]) {
      const b = el('button', '', label);
      b.addEventListener('click', () => onGrade(g));
      this.gradeBtns.set(g, b);
      seg.append(b);
    }
    const fold = el('button', 'task-fold', '任務');
    fold.title = '收合／展開任務卡';
    fold.addEventListener('click', () => this.root.classList.toggle('folded'));
    head.append(fold, this.count, seg);

    const prev = el('button', 'ghost', '上一個');
    const next = el('button', 'ghost', '下一個');
    prev.addEventListener('click', () => this.go(this.index - 1));
    next.addEventListener('click', () => this.go(this.index + 1));
    const nav = el('div', 'task-nav');
    nav.append(prev, next);

    this.hintBtn.addEventListener('click', () => {
      this.hint.hidden = !this.hint.hidden;
      this.hintBtn.textContent = this.hint.hidden ? '給我提示' : '收起提示';
    });
    const reset = el('button', 'link', '重新開始');
    reset.title = '清除這個年級的完成紀錄';
    reset.addEventListener('click', () => this.reset());
    const links = el('div', 'task-links');
    links.append(this.hintBtn, reset);

    const titleRow = el('div', 'task-title-row');
    titleRow.append(this.title, this.badge);
    const content = el('div', 'task-content');
    content.append(titleRow, this.body, this.hint, links, this.dots, nav);
    this.root.append(head, content);

    // 遊戲裡發生的事 → 記錄 → 檢查任務
    game.events.onPluck = (rec) => {
      recordPluck(this.ctx, rec);
      this.check();
    };
    game.events.onBreak = (b) => {
      this.ctx.breaks.push(b);
      this.check();
    };
    game.events.onResonate = () => {
      this.ctx.resonances++;
      this.check();
    };
    game.events.onMute = () => {
      this.ctx.mutes++;
      this.check();
    };

    this.setGrade(this.grade);
  }

  setGrade(grade: Grade): void {
    this.grade = grade;
    for (const [g, b] of this.gradeBtns) b.classList.toggle('on', g === grade);
    this.done = new Set(load(grade));
    const firstOpen = TASKS[grade].findIndex((t) => !this.done.has(t.id));
    this.index = firstOpen < 0 ? 0 : firstOpen;
    this.render();
  }

  private go(i: number): void {
    const n = TASKS[this.grade].length;
    this.index = ((i % n) + n) % n;
    window.clearTimeout(this.advanceTimer);
    this.render();
  }

  private reset(): void {
    this.done.clear();
    this.ctx = emptyContext();
    save(this.grade, []);
    this.go(0);
  }

  private check(): void {
    const list = TASKS[this.grade];
    let changed = false;
    for (const id of completed(this.grade, this.ctx)) {
      if (!this.done.has(id)) {
        this.done.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    save(this.grade, [...this.done]);
    const current = list[this.index];
    this.render();
    if (this.done.has(current.id)) {
      // 目前這張剛完成：慶祝一下，稍後自動跳到下一張還沒完成的
      this.root.classList.remove('celebrate');
      void this.root.offsetWidth; // 重新觸發動畫
      this.root.classList.add('celebrate');
      window.clearTimeout(this.advanceTimer);
      this.advanceTimer = window.setTimeout(() => {
        const nextOpen = list.findIndex((t) => !this.done.has(t.id));
        if (nextOpen >= 0) this.go(nextOpen);
      }, 2600);
    }
  }

  private render(): void {
    const list = TASKS[this.grade];
    const task = list[this.index];
    const allDone = list.every((t) => this.done.has(t.id));
    this.count.textContent = allDone ? '全部完成！' : `${this.index + 1} / ${list.length}`;
    this.title.textContent = task.title;
    this.body.textContent = task.body;
    this.hint.textContent = task.hint;
    this.hint.hidden = true;
    this.hintBtn.textContent = '給我提示';
    this.badge.hidden = !this.done.has(task.id);
    this.dots.replaceChildren(
      ...list.map((t, i) => {
        const d = el('button', 'dot');
        d.title = t.title;
        d.classList.toggle('done', this.done.has(t.id));
        d.classList.toggle('current', i === this.index);
        d.addEventListener('click', () => this.go(i));
        return d;
      }),
    );
  }
}

function load(grade: Grade): string[] {
  try {
    const raw = localStorage.getItem(storeKey(grade));
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function save(grade: Grade, ids: string[]): void {
  try {
    localStorage.setItem(storeKey(grade), JSON.stringify(ids));
  } catch {
    // 無痕模式或儲存空間被停用時，只是不記錄進度
  }
}
