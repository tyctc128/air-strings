// 手部追蹤：MediaPipe HandLandmarker → 兩個穩定的「手」槽位，
// 並算出遊戲需要的量：捏合狀態、捏合點、食指指尖與速度、每公尺對應幾個像素。

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { type Vec, OneEuro, dist, lerp } from '../util/math';
import { PinchDetector } from './pinch';

/** 追蹤短暫掉失時，手的狀態保留多久（毫秒）。 */
const HOLD_MS = 250;

/** 用來估計比例尺的骨架線段（手腕、各指根之間，不受手指彎曲影響）。 */
const SCALE_PAIRS: [number, number][] = [[0, 5], [0, 9], [0, 17], [5, 17], [5, 9], [9, 13], [13, 17]];

export interface TrackedHand {
  slot: number;
  present: boolean;
  lastSeen: number;
  /** 21 個關節點，舞台座標（像素，已鏡像） */
  lm: Vec[];
  /** 這隻手所在深度的比例尺：每公尺幾個像素 */
  ppm: number;
  /** 拇指尖到食指尖的距離（公尺） */
  pinchDist: number;
  pinching: boolean;
  /** 這一格的捏合判定是否可靠（指距確實在放開門檻以內）；不可靠時不要用 pinchPos 移動東西 */
  pinchSolid: boolean;
  /** 捏合點（拇指尖與食指尖的中點，已濾波） */
  pinchPos: Vec;
  /** 食指指尖 */
  tip: Vec;
  /** 食指指尖速度（像素／秒） */
  tipVel: Vec;
  /** 模型判斷的左右手標籤（用來維持兩隻手的身分） */
  label: string;
  /** 剪刀手勢：食指與中指伸直、無名指與小指收起 */
  vPose: boolean;
  /** 食指尖到中指尖的距離（公尺）——剪刀的開合 */
  vGap: number;
  /** 手掌張開（食指到小指都伸直）——用來按住弦止音 */
  openPalm: boolean;
  /** 掌心位置（手腕與四個指根的中心） */
  palm: Vec;
}

interface Filters {
  x: OneEuro;
  y: OneEuro;
}

function makeHand(slot: number): TrackedHand {
  return {
    slot, present: false, lastSeen: -1e9, lm: [], ppm: 1000, pinchDist: 1, pinching: false, pinchSolid: false,
    pinchPos: { x: 0, y: 0 }, tip: { x: 0, y: 0 }, tipVel: { x: 0, y: 0 }, label: '',
    vPose: false, vGap: 0, openPalm: false, palm: { x: 0, y: 0 },
  };
}

export class HandTracker {
  hands: TrackedHand[] = [makeHand(0), makeHand(1)];
  /** 攝影機畫面是否左右鏡像（自拍視角） */
  mirror = true;
  /** 手的大小修正：1 = 成人，約 0.8 = 國小學童 */
  handScale = 1;
  /** 實際使用的運算後端（GPU 或 CPU） */
  delegate = '';
  /** 最近一次偵測花費的毫秒數 */
  detectMs = 0;

  private landmarker: HandLandmarker | null = null;
  private filters: Filters[] = [
    { x: new OneEuro(), y: new OneEuro() },
    { x: new OneEuro(), y: new OneEuro() },
  ];
  private pinch = [new PinchDetector(), new PinchDetector()];
  /** 上一格未濾波的捏合點，用來算捏合點的移動速度 */
  private rawPinch: (Vec | null)[] = [null, null];
  private lastVideoTime = -1;
  private lastStamp = 0;

  get ready(): boolean {
    return this.landmarker !== null;
  }

  async init(): Promise<void> {
    const base = document.baseURI;
    const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', base).href);
    const modelAssetPath = new URL('mediapipe/hand_landmarker.task', base).href;
    const create = (delegate: 'GPU' | 'CPU') =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await create('GPU');
      this.delegate = 'GPU';
    } catch {
      this.landmarker = await create('CPU');
      this.delegate = 'CPU';
    }
  }

  /** 若影片有新的一格就做偵測並更新 hands，回傳是否有更新。 */
  process(video: HTMLVideoElement, now: number): boolean {
    if (!this.landmarker || video.readyState < 2 || video.videoWidth === 0) return false;
    if (video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = video.currentTime;

    const stamp = Math.max(now, this.lastStamp + 1);
    const dt = this.lastStamp > 0 ? Math.min((stamp - this.lastStamp) / 1000, 0.1) : 1 / 30;
    this.lastStamp = stamp;

    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, stamp);
    this.detectMs = performance.now() - t0;

    const W = video.videoWidth;
    const H = video.videoHeight;
    let dets = result.landmarks.map((lm, i) => {
      const cat = result.handedness?.[i]?.[0];
      return {
        lm: lm.map((p) => ({ x: (this.mirror ? 1 - p.x : p.x) * W, y: p.y * H })),
        world: result.worldLandmarks?.[i] ?? null,
        label: cat?.categoryName ?? '',
        score: cat?.score ?? 0,
      };
    });

    // 同一隻手偶爾會被偵測成兩筆：手腕與中指根都幾乎重疊時，只留信心較高的那筆
    if (dets.length === 2) {
      const [a, b] = dets;
      const palm = Math.max(dist(a.lm[0], a.lm[9]), dist(b.lm[0], b.lm[9]));
      if (dist(a.lm[0], b.lm[0]) < palm * 0.5 && dist(a.lm[9], b.lm[9]) < palm * 0.5) {
        dets = [a.score >= b.score ? a : b];
      }
    }

    // 把偵測結果配對到既有槽位：以手腕距離為主，左右手標籤不同則加罰分，
    // 距離太遠（不可能是同一隻手在一格之內移動到的）就不配對，避免兩隻手的身分互換。
    const assigned: (typeof dets[number] | null)[] = [null, null];
    const pairs: { cost: number; det: number; slot: number }[] = [];
    dets.forEach((det, di) => {
      for (const h of this.hands) {
        if (!h.present || !h.lm.length) continue;
        const d = dist(det.lm[0], h.lm[0]);
        if (d > W * 0.3) continue;
        pairs.push({ cost: d + (det.label && h.label && det.label !== h.label ? W * 0.2 : 0), det: di, slot: h.slot });
      }
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const used = new Set<number>();
    for (const p of pairs) {
      if (used.has(p.det) || assigned[p.slot]) continue;
      assigned[p.slot] = dets[p.det];
      used.add(p.det);
    }
    dets.forEach((det, di) => {
      if (used.has(di)) return;
      const free =
        this.hands.find((h) => !h.present && !assigned[h.slot]) ?? this.hands.find((h) => !assigned[h.slot]);
      if (free) {
        if (free.present) this.reset(free);
        assigned[free.slot] = det;
        used.add(di);
      }
    });

    for (const h of this.hands) {
      const det = assigned[h.slot];
      if (det) {
        this.updateHand(h, det.lm, det.world, stamp, dt);
        h.label = det.label;
      }
      else if (h.present && stamp - h.lastSeen > HOLD_MS) this.reset(h);
    }
    return true;
  }

  private reset(h: TrackedHand): void {
    h.present = false;
    h.pinching = false;
    h.pinchSolid = false;
    this.pinch[h.slot].reset();
    this.rawPinch[h.slot] = null;
    h.vPose = false;
    h.openPalm = false;
    h.label = '';
    h.lm = [];
    h.tipVel = { x: 0, y: 0 };
    this.filters[h.slot].x.reset();
    this.filters[h.slot].y.reset();
  }

  private updateHand(
    h: TrackedHand, lm: Vec[], world: { x: number; y: number; z: number }[] | null, now: number, dt: number,
  ): void {
    const wasPresent = h.present;

    // 比例尺：螢幕上的骨架長度 ÷ 模型估計的真實長度（只取平行於畫面的分量，抵消手掌轉向造成的縮短）
    let px = 0;
    let meters = 0;
    for (const [a, b] of SCALE_PAIRS) {
      px += dist(lm[a], lm[b]);
      if (world) meters += Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y);
    }
    let ppm = meters > 0.02 ? px / meters : dist(lm[0], lm[9]) / 0.09;
    ppm /= this.handScale;
    h.ppm = wasPresent ? lerp(h.ppm, ppm, 0.15) : ppm;

    const tip = lm[8];
    if (wasPresent) {
      const vx = (tip.x - h.tip.x) / dt;
      const vy = (tip.y - h.tip.y) / dt;
      h.tipVel = { x: lerp(h.tipVel.x, vx, 0.6), y: lerp(h.tipVel.y, vy, 0.6) };
    } else {
      h.tipVel = { x: 0, y: 0 };
    }
    h.tip = { x: tip.x, y: tip.y };

    h.pinchDist = dist(lm[4], lm[8]) / h.ppm;
    const mid = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
    const before = this.rawPinch[h.slot];
    const speed = wasPresent && before ? dist(mid, before) / dt / h.ppm : 0;
    this.rawPinch[h.slot] = mid;
    const det = this.pinch[h.slot];
    det.update(h.pinchDist, speed, now);
    h.pinching = det.pinching;
    h.pinchSolid = det.solid;

    // 剪刀手勢：用「指尖到手腕」與「第二指節到手腕」的距離比判斷手指伸直或彎曲。
    // 進入與離開用不同門檻，避免在邊界上閃爍。
    const ext = (tipI: number, pipI: number) => dist(lm[0], lm[tipI]) / (dist(lm[0], lm[pipI]) || 1);
    const straight = h.vPose ? 1.12 : 1.22;
    const folded = h.vPose ? 1.18 : 1.08;
    h.vPose =
      !h.pinching && ext(8, 6) > straight && ext(12, 10) > straight && ext(16, 14) < folded && ext(20, 18) < folded;
    h.vGap = dist(lm[8], lm[12]) / h.ppm;

    const open = h.openPalm ? 1.12 : 1.22;
    h.openPalm =
      !h.pinching && ext(8, 6) > open && ext(12, 10) > open && ext(16, 14) > open && ext(20, 18) > open;
    h.palm = {
      x: (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5,
      y: (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5,
    };

    const f = this.filters[h.slot];
    h.pinchPos = { x: f.x.filter(mid.x, dt), y: f.y.filter(mid.y, dt) };

    h.lm = lm;
    h.present = true;
    h.lastSeen = now;
  }
}
