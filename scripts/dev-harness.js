// 開發用測試工具（不會被打包進正式版）。
// 用途：把一支影片逐格餵給手部追蹤與遊戲邏輯，檢查手勢判斷是否正確，不受瀏覽器畫面更新率影響。
//
// 用法（開發伺服器執行中，在瀏覽器主控台）：
//   const h = await import('/scripts/dev-harness.js');
//   await h.setup('/reference_video/reel.mp4');   // 先用「改用滑鼠操作」進入畫面
//   console.log(await h.run(0, 10));              // 跑影片的第 0〜10 秒，回傳事件記錄

const BASE = 1e6;

export async function setup(src, mirror = false) {
  const A = window.__air;
  A.dev.paused = true;
  document.getElementById('start').style.display = 'none';
  for (const id of ['palette', 'panel', 'tip']) document.getElementById(id).style.transition = 'none';
  const v = document.getElementById('cam');
  v.src = src;
  v.muted = true;
  await new Promise((resolve, reject) => {
    v.addEventListener('loadeddata', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('影片載入失敗')), { once: true });
  });
  A.tracker.mirror = mirror;
  A.renderer.mirror = mirror;
  A.game.setStage(v.videoWidth, v.videoHeight);
  A.renderer.layout();
  if (!A.tracker.ready) await A.tracker.init();
  return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, delegate: A.tracker.delegate };
}

/** 跑影片的 from〜to 秒；trace = true 時另外回傳每一格兩隻手的指距（公分）。 */
export async function run(from, to, { fps = 30, trace = false } = {}) {
  const A = window.__air;
  const g = A.game;
  const v = document.getElementById('cam');
  const log = [];
  const dists = [];
  let nStrings = g.strings.length;
  let nPlucks = g.pluckCount;
  const pin = A.tracker.hands.map((h) => h.pinching);
  let hadPreview = !!g.handPreview;

  for (let i = Math.round(from * fps); i < to * fps; i++) {
    const t = i / fps;
    v.currentTime = t;
    await new Promise((resolve) => v.addEventListener('seeked', resolve, { once: true }));
    const now = BASE + t * 1000;
    if (A.tracker.process(v, now)) g.updateHands(A.tracker.hands, now);
    g.step(now, 1 / fps);

    A.tracker.hands.forEach((h, k) => {
      if (h.pinching === pin[k]) return;
      pin[k] = h.pinching;
      const st = g.slots[k];
      const what = h.pinching ? ` 捏合 ${st.grab ? `抓住弦#${st.grab.s.id}端點${st.grab.end}` : '空手'}` : ' 放開';
      log.push(`${t.toFixed(2)} 手${k}${h.label ? h.label[0] : '?'}${what} 指距${(h.pinchDist * 100).toFixed(1)}`);
    });
    if (!!g.handPreview !== hadPreview) {
      hadPreview = !!g.handPreview;
      log.push(`${t.toFixed(2)} ${hadPreview ? '開始拉弦' : '結束拉弦'}`);
    }
    if (g.strings.length !== nStrings) {
      log.push(`${t.toFixed(2)} 弦數 ${nStrings}→${g.strings.length}`);
      nStrings = g.strings.length;
    }
    if (g.pluckCount !== nPlucks) {
      log.push(`${t.toFixed(2)} 撥弦`);
      nPlucks = g.pluckCount;
    }
    if (trace) {
      dists.push(
        `${t.toFixed(2)}:` +
          A.tracker.hands.map((h) => (h.present ? (h.pinchDist * 100).toFixed(1) + (h.pinching ? '*' : '') : '-')).join('/'),
      );
    }
  }
  window.__now = BASE + to * 1000;
  A.renderer.draw(window.__now);
  const out = {
    log: log.join(' | '),
    strings: g.strings.map(
      (s) =>
        `#${s.id} ${s.material.name} ${(s.length * 100).toFixed(0)}cm ${s.f0.toFixed(0)}Hz ` +
        `(${s.a.x.toFixed(0)},${s.a.y.toFixed(0)})-(${s.b.x.toFixed(0)},${s.b.y.toFixed(0)})`,
    ),
    plucks: g.pluckCount,
  };
  if (trace) out.dists = dists.join(' ');
  return out;
}

/** 重畫目前這一格（主迴圈暫停時截圖前呼叫）。 */
export function redraw() {
  window.__air.renderer.draw(window.__now ?? performance.now());
}
