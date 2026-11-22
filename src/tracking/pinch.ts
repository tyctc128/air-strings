// 捏合判定（拇指尖與食指尖）。
//
// 只看畫面上兩個指尖的距離很容易誤判：伸食指撥弦時，拇指尖常常剛好在畫面上
// 靠近食指尖一瞬間。所以開始捏合要同時滿足三件事：
//   1. 指距夠小（小於 ON）
//   2. 持續一小段時間（CONFIRM_MS），其間指距不超過 HOLD
//   3. 手不是正在快速揮動（撥弦的揮動速度遠高於刻意去捏東西的速度）
// 放開則相反：指距明確張開（大於 WIDE）立刻放開；介於 OFF 與 WIDE 之間要持續
// RELEASE_MS，因為手快速移動或被遮住時追蹤會短暫失準，不能因此把弦放掉。
// 若是後者這種「不確定的放開」，短時間內指距又變小就立刻恢復捏合，不必重新確認。

/** 指距小於這個值才可能開始捏合（公尺）。真捏合時量到的指距中位數約 2 cm、九成在 3.6 cm 以內。 */
export const PINCH_ON = 0.028;
/** 確認期間指距只要不超過這個值就繼續計時。 */
export const PINCH_HOLD = 0.04;
/** 已經捏合後，指距超過這個值才開始考慮放開。 */
export const PINCH_OFF = 0.05;
/** 指距超過這個值代表明確張開，立刻放開。 */
export const PINCH_WIDE = 0.09;
/** 開始捏合前需要持續的時間（毫秒）。 */
export const CONFIRM_MS = 60;
/** 指距介於 OFF 與 WIDE 之間時，持續這麼久才算放開（毫秒）。 */
export const RELEASE_MS = 100;
/** 捏合點移動速度超過這個值（公尺／秒）時不開始捏合。 */
export const MAX_START_SPEED = 0.8;
/** 不確定的放開之後，這段時間內可以立刻恢復捏合（毫秒）。 */
export const RESUME_MS = 400;
/** 捏合至少維持這麼久，放開後才適用立刻恢復（毫秒）。 */
export const RESUME_MIN_HELD = 250;

export class PinchDetector {
  pinching = false;
  /** 這一格的捏合判定是否可靠（指距確實在放開門檻以內） */
  solid = false;

  private closeSince = -1;
  private openSince = -1;
  private startedAt = -1;
  private resumeUntil = -1;

  reset(): void {
    this.pinching = false;
    this.solid = false;
    this.closeSince = -1;
    this.openSince = -1;
    this.startedAt = -1;
    this.resumeUntil = -1;
  }

  /**
   * @param gap   拇指尖到食指尖的距離（公尺）
   * @param speed 捏合點的移動速度（公尺／秒）
   * @param now   時間（毫秒）
   */
  update(gap: number, speed: number, now: number): void {
    const within = gap <= PINCH_OFF;
    if (this.pinching) {
      if (within) {
        this.openSince = -1;
      } else {
        if (this.openSince < 0) this.openSince = now;
        const wide = gap > PINCH_WIDE;
        if (wide || now - this.openSince >= RELEASE_MS) {
          this.pinching = false;
          const held = now - this.startedAt;
          this.resumeUntil = !wide && held >= RESUME_MIN_HELD ? now + RESUME_MS : -1;
        }
      }
    } else if (now < this.resumeUntil && gap < PINCH_ON) {
      this.start(now);
    } else {
      const calm = speed <= MAX_START_SPEED;
      if (this.closeSince < 0) {
        if (gap < PINCH_ON && calm) this.closeSince = now;
      } else if (gap > PINCH_HOLD || !calm) {
        this.closeSince = -1;
      }
      if (this.closeSince >= 0 && now - this.closeSince >= CONFIRM_MS) this.start(now);
    }
    this.solid = this.pinching && within;
  }

  private start(now: number): void {
    this.pinching = true;
    this.startedAt = now;
    this.closeSince = -1;
    this.openSince = -1;
    this.resumeUntil = -1;
  }
}
