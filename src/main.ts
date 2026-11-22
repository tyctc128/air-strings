import './style.css';
import { AudioEngine } from './audio/engine';
import { Game, type Mode } from './game/game';
import { materialById } from './physics/materials';
import { Renderer } from './render/renderer';
import type { Grade } from './teach/tasks';
import { HandTracker } from './tracking/hands';
import { TaskBoard } from './ui/taskboard';
import { UI } from './ui/ui';
import { type Vec, clamp } from './util/math';

// 網址參數：
//   ?mode=exhibit     直接以展覽模式開啟
//   ?grade=junior     年級（elementary 國小／junior 國中以上）
//   ?hand=child       手的大小（child 小朋友／adult 大人）
//   ?debug=1          顯示除錯資訊
//   ?video=路徑       用影片檔取代攝影機（搭配 &mirror=1 可左右鏡像，測試用）
const params = new URLSearchParams(location.search);

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const video = document.getElementById('cam') as HTMLVideoElement;

const audio = new AudioEngine();
const game = new Game(audio);
const tracker = new HandTracker();
const renderer = new Renderer(canvas, video, game, tracker);
renderer.debug = params.has('debug');

// ───────── 畫質分級 ─────────
// 平板與舊電腦從中等開始；執行中如果畫面更新率持續偏低，會自動再降一級。
const QUALITY = [
  { modes: 28, particles: 120, glow: false, dpr: 1, halo: 2 },
  { modes: 40, particles: 220, glow: false, dpr: 1.5, halo: 4 },
  { modes: 64, particles: 420, glow: true, dpr: 2, halo: 5 },
];
const lowEnd =
  (navigator.hardwareConcurrency ?? 8) <= 4 || /Android|iPhone|iPad/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent)); // iPad 會自稱是 Mac
let quality = lowEnd ? 1 : 2;

function applyQuality(q: number): void {
  quality = q;
  const c = QUALITY[q];
  game.maxModes = c.modes;
  game.maxParticles = c.particles;
  renderer.softGlow = c.glow;
  renderer.haloLayers = c.halo;
  if (renderer.dprCap !== c.dpr) {
    renderer.dprCap = c.dpr;
    renderer.resize();
  }
}
applyQuality(quality);

/** 記住使用者的選擇（年級、手的大小）；無痕模式下存不了就算了。 */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`air-strings.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`air-strings.${key}`, value);
    } catch {
      // 忽略
    }
  },
};

const DWELL_MS = 600;
let starting = false;
let playing = false;
let cameraOn = false;
let notice = '';
let noticeUntil = 0;

const ui = new UI(game, {
  onStart: (useCamera) => void start(useCamera),
  onClear: () => game.clearAll(performance.now()),
  onDelete: () => game.deleteSelected(performance.now()),
  onMode: (mode) => setMode(mode),
  onSlowMo: (on) => setSlowMo(on),
  onFullscreen: () => toggleFullscreen(),
  onHandScale: (scale) => setHandScale(scale),
});
const tasks = new TaskBoard(game, (grade) => setGrade(grade));

function setGrade(grade: Grade): void {
  game.grade = grade;
  ui.setGrade(grade);
  tasks.setGrade(grade);
  prefs.set('grade', grade);
}

function setHandScale(scale: number): void {
  tracker.handScale = scale;
  ui.setHandScale(scale);
  prefs.set('hand', String(scale));
}

setGrade((params.get('grade') ?? prefs.get('grade')) === 'junior' ? 'junior' : 'elementary');
{
  const hand = params.get('hand');
  setHandScale(hand === 'child' ? 0.8 : hand === 'adult' ? 1 : prefs.get('hand') === '0.8' ? 0.8 : 1);
}

function setMode(mode: Mode): void {
  game.setMode(mode);
  ui.setMode(mode);
  if (mode === 'exhibit') {
    setSlowMo(false);
    game.select(null);
  }
}

function setSlowMo(on: boolean): void {
  renderer.slowMo = on;
  ui.setSlowMo(on);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => undefined);
}

// 網址加 ?mode=exhibit 可以直接以展覽模式開啟
setMode(params.get('mode') === 'exhibit' ? 'exhibit' : 'teach');

async function start(useCamera: boolean): Promise<void> {
  if (starting) return;
  starting = true;

  ui.setStatus('正在啟動聲音…', true);
  try {
    await audio.init();
  } catch (err) {
    console.error(err);
    showNotice('聲音無法啟動，仍可以操作但不會有聲音。');
  }

  if (useCamera) {
    try {
      ui.setStatus('正在開啟攝影機…', true);
      await openVideo();
      game.setStage(video.videoWidth, video.videoHeight);
      renderer.mirror = tracker.mirror;
      renderer.layout();
      ui.setStatus('正在載入手部追蹤模型…', true);
      await tracker.init();
      cameraOn = true;
    } catch (err) {
      console.error(err);
      stopVideo();
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showNotice(denied ? '沒有取得攝影機權限，已改用滑鼠操作。' : '無法使用攝影機或手部追蹤，已改用滑鼠操作。');
    }
  }
  ui.setStatus('');
  ui.hideStart();
  playing = true;
  void keepAwake();
}

/** 展示或上課時不要讓螢幕自動休眠（瀏覽器不支援就算了）。 */
async function keepAwake(): Promise<void> {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch {
    // 省電模式等情況下會被拒絕，不影響使用
  }
}

async function openVideo(): Promise<void> {
  const file = params.get('video');
  if (file) {
    video.src = file;
    video.loop = true;
    tracker.mirror = params.get('mirror') === '1';
  } else {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('這個瀏覽器不支援攝影機');
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    tracker.mirror = true;
  }
  video.muted = true;
  await video.play();
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
}

function stopVideo(): void {
  const stream = video.srcObject;
  if (stream instanceof MediaStream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  video.removeAttribute('src');
}

function showNotice(text: string): void {
  notice = text;
  noticeUntil = performance.now() + 6000;
}

// ───────── 滑鼠／觸控 ─────────

const stagePos = (e: PointerEvent) => renderer.toStage(e.clientX, e.clientY);

// 觸控的規則和手勢對應：兩指 = 兩手捏合（拉新弦），單指 = 食指（撥弦、拖端點）。
const touches = new Map<number, Vec>();
let pairing = false; // 兩指正在拉新弦
let pairDone = false; // 新弦已經定下來，等手指全部離開

function touchEnd(e: PointerEvent): void {
  if (!touches.delete(e.pointerId)) return;
  const now = performance.now();
  if (pairing) {
    pairing = false;
    pairDone = true;
    game.commitPointerPreview(now);
  } else if (touches.size === 0 && !pairDone) {
    game.pointerUp(stagePos(e), now);
  }
  if (touches.size === 0) pairDone = false;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    canvas.setPointerCapture(e.pointerId);
    touches.set(e.pointerId, stagePos(e));
    if (touches.size === 1) {
      game.pointerDown(stagePos(e), true);
    } else if (touches.size === 2 && !pairDone && !game.pointerBusy) {
      game.pointerLeave(performance.now());
      pairing = true;
      const [a, b] = [...touches.values()];
      game.setPointerPreview(a, b);
    }
    return;
  }
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  game.pointerDown(stagePos(e));
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, stagePos(e));
    if (pairing) {
      const [a, b] = [...touches.values()];
      game.setPointerPreview(a, b);
    } else if (touches.size === 1 && !pairDone) {
      game.pointerMove(stagePos(e), true, true, performance.now());
    }
    return;
  }
  game.pointerMove(stagePos(e), e.buttons !== 0, e.pointerType === 'mouse' && e.buttons === 0, performance.now());
});
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') touchEnd(e);
  else if (e.button === 0) game.pointerUp(stagePos(e), performance.now());
});
// 滑鼠右鍵：在弦上放置／移除輕觸點（代替另一根手指，用來做泛音）
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  game.togglePin(stagePos(e), performance.now());
});
canvas.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') touchEnd(e);
  game.pointerLeave(performance.now());
});
canvas.addEventListener('pointerleave', () => game.pointerLeave(performance.now()));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'c' || e.key === 'C') game.clearAll(performance.now());
  else if (e.key === 'Delete' || e.key === 'Backspace') game.deleteSelected(performance.now());
  else if (e.key === 'Escape') game.select(null);
  else if (e.key === 'd' || e.key === 'D') renderer.debug = !renderer.debug;
  else if (e.key === 'm' || e.key === 'M') setMode(game.mode === 'teach' ? 'exhibit' : 'teach');
  else if ((e.key === 's' || e.key === 'S') && game.mode === 'teach') setSlowMo(!renderer.slowMo);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// 分頁切回來時恢復聲音
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  void audio.ctx?.resume();
  if (playing) void keepAwake();
});

// ───────── 食指停留選材質 ─────────

const dwell = [0, 1].map(() => ({ id: null as string | null, since: 0, done: false }));

function updateDwell(now: number): void {
  const hover: (string | null)[] = [];
  for (const h of tracker.hands) {
    const d = dwell[h.slot];
    let id: string | null = null;
    if (h.present && !h.pinching) {
      const sp = renderer.toScreen(h.tip);
      id = ui.materialAt(sp.x, sp.y, now);
    }
    if (id !== d.id) {
      d.id = id;
      d.since = now;
      d.done = false;
    }
    const progress = id && !d.done ? clamp((now - d.since) / DWELL_MS, 0, 1) : 0;
    if (id && !d.done && progress >= 1) {
      d.done = true;
      game.setMaterial(materialById(id));
      ui.sync(now);
    }
    renderer.dwell[h.slot] = d.done ? 0 : progress;
    hover.push(id);
  }
  ui.setHover(hover);
}

// ───────── 主迴圈 ─────────

function tipText(now: number): string {
  if (now < noticeUntil) return notice;
  if (game.strings.length === 0) {
    return cameraOn ? '兩隻手同時捏起拇指和食指，拉開後放開，就會出現一條弦' : '按住滑鼠拖曳，拉出一條弦';
  }
  if (game.pluckCount === 0) return cameraOn ? '伸出食指掃過弦，撥撥看' : '移動滑鼠掃過弦，撥撥看';
  return '';
}

/** 測試用：暫停主迴圈，改由外部逐格驅動 */
const dev = { paused: false };
let last = performance.now();
let uiAt = 0;
let frames = 0;
let tracks = 0;
let fpsAt = last;
let fps = 0;
let trackFps = 0;
let slowSeconds = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (dev.paused) return;

  if (cameraOn) {
    if (tracker.process(video, now)) {
      game.updateHands(tracker.hands, now);
      tracks++;
    }
    updateDwell(now);
  }
  game.step(now, dt);
  renderer.draw(now);

  frames++;
  if (now - fpsAt >= 1000) {
    fps = (frames * 1000) / (now - fpsAt);
    trackFps = (tracks * 1000) / (now - fpsAt);
    frames = 0;
    tracks = 0;
    fpsAt = now;
    // 畫面更新率持續偏低就降一級畫質。分頁在背景時瀏覽器會把更新率壓到個位數，那不算。
    slowSeconds = playing && !document.hidden && fps >= 8 && fps < 26 ? slowSeconds + 1 : 0;
    if (slowSeconds >= 3 && quality > 0) {
      applyQuality(quality - 1);
      slowSeconds = 0;
    }
  }
  if (now - uiAt > 100) {
    uiAt = now;
    ui.sync(now);
    ui.setTip(tipText(now));
    if (renderer.debug) {
      renderer.debugLines = [
        `畫面 ${fps.toFixed(0)} fps｜追蹤 ${trackFps.toFixed(0)} fps｜偵測 ${tracker.detectMs.toFixed(1)} ms (${tracker.delegate || '—'})`,
        `弦 ${game.strings.length}｜粒子 ${game.particles.length}｜舞台 ${game.stageW}×${game.stageH}｜畫質 ${quality}`,
        ...tracker.hands.map((h) =>
          h.present
            ? `手${h.slot}  ${h.ppm.toFixed(0)} px/m  指距 ${(h.pinchDist * 100).toFixed(1)} cm  ${h.pinching ? '捏合' : '張開'}`
            : `手${h.slot}  —`,
        ),
      ];
    }
  }
}
requestAnimationFrame(frame);

// 方便在瀏覽器主控台檢查狀態
Object.assign(window, { __air: { game, tracker, audio, renderer, ui, tasks, dev } });
