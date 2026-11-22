// 教學任務卡：兩個年級各一套，依學生實際做出來的事自動判定完成。
// 這裡只有純邏輯（不碰畫面），方便測試。

export type Grade = 'elementary' | 'junior';

/** 一次撥弦當下，那條弦的狀態。 */
export interface PluckRecord {
  stringId: number;
  materialId: string;
  /** 張力 N */
  tension: number;
  /** 直徑 m */
  diameter: number;
  /** 弦長 m */
  length: number;
  /** 基頻 Hz */
  f0: number;
  /** 撥弦時若有手指輕觸在節點上，是哪個節點（k/n） */
  touchNode: { k: number; n: number } | null;
}

/** 到目前為止學生做過的事。 */
export interface TaskContext {
  plucks: PluckRecord[];
  /** 被拉斷的弦 */
  breaks: { materialId: string; tension: number }[];
  /** 共鳴發生的次數 */
  resonances: number;
  /** 用手掌把正在響的弦按停的次數 */
  mutes: number;
}

export interface Task {
  id: string;
  title: string;
  body: string;
  /** 做不出來時的提示 */
  hint: string;
  done(ctx: TaskContext): boolean;
}

export function emptyContext(): TaskContext {
  return { plucks: [], breaks: [], resonances: 0, mutes: 0 };
}

/** 最多保留最近幾次撥弦紀錄 */
const MAX_PLUCKS = 60;

export function recordPluck(ctx: TaskContext, rec: PluckRecord): void {
  ctx.plucks.push(rec);
  if (ctx.plucks.length > MAX_PLUCKS) ctx.plucks.shift();
}

// ───────── 比較用的小工具 ─────────

/** a 和 b 相差在 tol（比例）以內。 */
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(a, b);
/** 大的除以小的。 */
const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);
/** 兩個頻率相差幾音分。 */
const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b));

/** 有沒有任兩筆撥弦紀錄符合條件。 */
function anyPair(ctx: TaskContext, test: (a: PluckRecord, b: PluckRecord) => boolean): boolean {
  const p = ctx.plucks;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      if (test(p[i], p[j])) return true;
    }
  }
  return false;
}

const sameMaterial = (a: PluckRecord, b: PluckRecord) => a.materialId === b.materialId;

// ───────── 國小：長短、鬆緊、粗細、材質 ─────────

const ELEMENTARY: Task[] = [
  {
    id: 'e-first',
    title: '讓弦發出聲音',
    body: '用兩隻手拉出一條弦，再伸出食指撥撥看。',
    hint: '兩手同時把拇指和食指捏起來，拉開，再放開。',
    done: (c) => c.plucks.length >= 1,
  },
  {
    id: 'e-length',
    title: '長的弦和短的弦',
    body: '用同一種材質拉出一條長的弦和一條短的弦，兩條都撥撥看。哪一條的聲音比較高？',
    hint: '兩條弦的長度要差多一點（例如一條是另一條的一半），不要去動鬆緊和粗細。',
    done: (c) =>
      anyPair(c, (a, b) =>
        a.stringId !== b.stringId && sameMaterial(a, b) && near(a.tension, b.tension, 0.1) &&
        near(a.diameter, b.diameter, 0.1) && ratio(a.length, b.length) >= 1.5),
  },
  {
    id: 'e-tension',
    title: '鬆的弦和緊的弦',
    body: '先撥一下弦，再用右邊的「鬆緊」把它調緊很多，然後再撥一次。聲音變高還是變低？',
    hint: '同一條弦，長度不要動，把「鬆緊」往右拉多一點再撥。',
    done: (c) =>
      anyPair(c, (a, b) =>
        sameMaterial(a, b) && near(a.length, b.length, 0.08) && near(a.diameter, b.diameter, 0.1) &&
        ratio(a.tension, b.tension) >= 1.5),
  },
  {
    id: 'e-thickness',
    title: '粗的弦和細的弦',
    body: '先撥一下弦，再用右邊的「粗細」把它變粗，然後再撥一次。聲音有什麼不一樣？',
    hint: '同一條弦，長度和鬆緊不要動，只把「粗細」往右拉。',
    done: (c) =>
      anyPair(c, (a, b) =>
        sameMaterial(a, b) && near(a.length, b.length, 0.08) && near(a.tension, b.tension, 0.1) &&
        ratio(a.diameter, b.diameter) >= 1.4),
  },
  {
    id: 'e-material',
    title: '換一種材質',
    body: '用兩種不同的材質，拉出差不多一樣長的兩條弦，都撥撥看。哪一種的聲音比較亮？哪一種響比較久？',
    hint: '先拉一條，再到上面選另一種材質，在旁邊拉一條差不多長的。',
    done: (c) =>
      anyPair(c, (a, b) => a.stringId !== b.stringId && !sameMaterial(a, b) && near(a.length, b.length, 0.1)),
  },
  {
    id: 'e-mute',
    title: '讓聲音停下來',
    body: '撥響一條弦，趁它還在響的時候，張開手掌按住它。聲音怎麼了？',
    hint: '選鋼弦比較容易成功，因為它會響很久。手掌要張開，掌心對準弦。',
    done: (c) => c.mutes >= 1,
  },
  {
    id: 'e-break',
    title: '弦會斷嗎？',
    body: '把一條弦的「鬆緊」一直調緊，看看會發生什麼事。',
    hint: '棉線和銅線很容易斷，克維拉和碳纖維很難斷。',
    done: (c) => c.breaks.length >= 1,
  },
];

// ───────── 國中以上：頻率、比例、泛音、共鳴 ─────────

const JUNIOR: Task[] = [
  {
    id: 'j-tune',
    title: '調出標準音 La',
    body: '調整弦長或張力，讓一條弦的頻率落在 A（220、440 或 880 Hz），誤差在 10 音分以內，然後撥響它。',
    hint: '弦旁會顯示頻率與音名。頻率太低就把弦縮短或把張力調高。',
    done: (c) =>
      c.plucks.some((p) => {
        const steps = 12 * Math.log2(p.f0 / 440);
        return Math.abs(steps - Math.round(steps / 12) * 12) * 100 <= 10;
      }),
  },
  {
    id: 'j-octave',
    title: '弦長減半，頻率加倍',
    body: '用同一種材質、相同的張力和直徑，做出兩條頻率剛好是 2 倍的弦，兩條都撥響。它們的弦長是什麼關係？',
    hint: '先拉一條長的，記下長度；再拉一條，調到長度是它的一半。',
    done: (c) =>
      anyPair(c, (a, b) =>
        a.stringId !== b.stringId && sameMaterial(a, b) && near(a.tension, b.tension, 0.05) &&
        near(a.diameter, b.diameter, 0.05) && cents(ratio(a.f0, b.f0), 2) <= 35),
  },
  {
    id: 'j-tension',
    title: '張力變 4 倍，頻率變幾倍？',
    body: '先預測，再驗證：同一條弦，把張力調成原來的 4 倍，前後各撥一次。',
    hint: '先把張力調低一點再開始，不然調到 4 倍之前弦就斷了。',
    done: (c) =>
      anyPair(c, (a, b) =>
        sameMaterial(a, b) && near(a.length, b.length, 0.08) && near(a.diameter, b.diameter, 0.05) &&
        near(ratio(a.tension, b.tension), 4, 0.12)),
  },
  {
    id: 'j-material',
    title: '不同材質，相同音高',
    body: '用兩種不同的材質做出音高相同的兩條弦（相差 15 音分以內），兩條都撥響。它們的長度一樣嗎？為什麼？',
    hint: '線密度大的弦（例如銅線）要比較短或比較緊，才能和輕的弦一樣高。',
    done: (c) =>
      anyPair(c, (a, b) => a.stringId !== b.stringId && !sameMaterial(a, b) && cents(a.f0, b.f0) <= 15),
  },
  {
    id: 'j-harmonic',
    title: '找出泛音',
    body: '用一根手指輕輕停在弦的 1/2 處，另一隻手撥弦；再換成 1/3 處試一次。聽到的音高各是基音的幾倍？',
    hint: '手指要幾乎不動地停在弦上，出現黃色菱形才算碰到。選取的弦上會標出 1/2、1/3 的位置。',
    done: (c) =>
      c.plucks.some((p) => p.touchNode?.n === 2) && c.plucks.some((p) => p.touchNode?.n === 3),
  },
  {
    id: 'j-resonance',
    title: '讓另一條弦共鳴',
    body: '做出兩條弦，只撥其中一條，讓另一條也跟著振動發光。兩條弦的頻率要有什麼關係？',
    hint: '頻率相同最容易共鳴；成 2 倍（八度）或 3:2（五度）也可以。',
    done: (c) => c.resonances >= 1,
  },
  {
    id: 'j-strength',
    title: '比較抗拉強度',
    body: '選兩種不同的材質，各拉斷一條弦，比較它們斷裂時的張力。哪一種比較耐拉？',
    hint: '把張力滑桿推到最右邊弦就會斷。面板上的「已達斷裂強度」可以看出離極限還有多遠。',
    done: (c) => new Set(c.breaks.map((b) => b.materialId)).size >= 2,
  },
];

export const TASKS: Record<Grade, Task[]> = { elementary: ELEMENTARY, junior: JUNIOR };

/** 回傳目前已完成的任務 id。 */
export function completed(grade: Grade, ctx: TaskContext): string[] {
  return TASKS[grade].filter((t) => t.done(ctx)).map((t) => t.id);
}
