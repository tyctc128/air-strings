// 弦的材質資料庫。
// 數值取自材料手冊與弦樂器聲學文獻的典型值（同一種材料會因製程而有 ±20% 左右的差異），
// 內耗係數 etaF／etaB 依 Woodhouse (2004) 對吉他弦的量測量級估計。

export type MaterialGroup = 'instrument' | 'everyday' | 'special';

export interface Material {
  id: string;
  name: string;
  group: MaterialGroup;
  hint: string;
  /** 密度 kg/m³（纏弦為芯線的密度） */
  density: number;
  /** 楊氏模數 Pa */
  youngs: number;
  /** 抗拉強度 Pa */
  strength: number;
  /** 與頻率無關的內耗係數（無因次） */
  etaF: number;
  /** 彎曲內耗係數（無因次），只作用在彎曲剛性所儲存的能量上 */
  etaB: number;
  /** 纏弦：芯線佔外徑的比例、纏線密度、纏線填充率 */
  wound?: { coreRatio: number; wrapDensity: number; fill: number };
  /** 預設直徑 m */
  defaultDiameter: number;
  /** 可調直徑範圍 m */
  diameterRange: [number, number];
  /** 預設張力 N */
  defaultTension: number;
  /** 畫面上的顏色 */
  color: string;
}

const mm = 1e-3;
const GPa = 1e9;
const MPa = 1e6;

export const MATERIALS: Material[] = [
  // ── 經典樂器弦 ──
  {
    id: 'steel', name: '鋼弦', group: 'instrument', hint: '吉他、鋼琴用的高碳鋼線',
    density: 7850, youngs: 200 * GPa, strength: 2300 * MPa, etaF: 1e-4, etaB: 5e-3,
    defaultDiameter: 0.3 * mm, diameterRange: [0.15 * mm, 0.8 * mm], defaultTension: 80, color: '#bfe3ff',
  },
  {
    id: 'nylon', name: '尼龍弦', group: 'instrument', hint: '古典吉他的高音弦',
    density: 1140, youngs: 5 * GPa, strength: 600 * MPa, etaF: 4e-4, etaB: 2.4e-2,
    defaultDiameter: 0.7 * mm, diameterRange: [0.3 * mm, 1.2 * mm], defaultTension: 65, color: '#fff1b8',
  },
  {
    id: 'gut', name: '羊腸弦', group: 'instrument', hint: '古提琴、豎琴的傳統弦',
    density: 1300, youngs: 6 * GPa, strength: 350 * MPa, etaF: 8e-4, etaB: 3e-2,
    defaultDiameter: 0.7 * mm, diameterRange: [0.3 * mm, 1.2 * mm], defaultTension: 55, color: '#ffc98a',
  },
  {
    id: 'bronze', name: '青銅纏弦', group: 'instrument', hint: '鋼芯外面纏青銅線的低音弦',
    density: 7850, youngs: 200 * GPa, strength: 2300 * MPa, etaF: 3e-4, etaB: 1e-2,
    wound: { coreRatio: 0.4, wrapDensity: 8800, fill: 0.785 },
    defaultDiameter: 1.1 * mm, diameterRange: [0.6 * mm, 1.6 * mm], defaultTension: 130, color: '#ffa23f',
  },
  // ── 生活素材 ──
  {
    id: 'rubber', name: '橡皮筋', group: 'everyday', hint: '很軟、很有彈性的天然橡膠',
    density: 930, youngs: 2 * MPa, strength: 20 * MPa, etaF: 3e-2, etaB: 1e-1,
    defaultDiameter: 2.0 * mm, diameterRange: [1.0 * mm, 4.0 * mm], defaultTension: 3, color: '#ff6f91',
  },
  {
    id: 'fluoro', name: '釣魚線', group: 'everyday', hint: '氟碳（PVDF）單絲',
    density: 1780, youngs: 2.5 * GPa, strength: 550 * MPa, etaF: 5e-4, etaB: 2e-2,
    defaultDiameter: 0.4 * mm, diameterRange: [0.15 * mm, 0.8 * mm], defaultTension: 30, color: '#7ef0dd',
  },
  {
    id: 'cotton', name: '棉線', group: 'everyday', hint: '纖維之間會互相摩擦',
    density: 1000, youngs: 2 * GPa, strength: 150 * MPa, etaF: 1e-2, etaB: 5e-2,
    defaultDiameter: 0.5 * mm, diameterRange: [0.3 * mm, 1.5 * mm], defaultTension: 8, color: '#e9e4d8',
  },
  {
    id: 'copper', name: '銅線', group: 'everyday', hint: '很重但不耐拉的軟金屬',
    density: 8960, youngs: 117 * GPa, strength: 250 * MPa, etaF: 3e-4, etaB: 5e-3,
    defaultDiameter: 0.4 * mm, diameterRange: [0.15 * mm, 1.0 * mm], defaultTension: 15, color: '#ff8c5a',
  },
  // ── 現代／特殊材料 ──
  {
    id: 'carbon', name: '碳纖維', group: 'special', hint: '又輕又硬，強度是鋼的 1.5 倍',
    density: 1750, youngs: 230 * GPa, strength: 3500 * MPa, etaF: 1e-4, etaB: 3e-3,
    defaultDiameter: 0.3 * mm, diameterRange: [0.15 * mm, 0.8 * mm], defaultTension: 60, color: '#b79cff',
  },
  {
    id: 'kevlar', name: '克維拉', group: 'special', hint: '防彈衣用的芳綸纖維',
    density: 1440, youngs: 70 * GPa, strength: 3000 * MPa, etaF: 5e-4, etaB: 1e-2,
    defaultDiameter: 0.4 * mm, diameterRange: [0.15 * mm, 0.8 * mm], defaultTension: 80, color: '#f4e04d',
  },
  {
    id: 'titanium', name: '鈦合金', group: 'special', hint: 'Ti-6Al-4V，內耗極低',
    density: 4430, youngs: 114 * GPa, strength: 950 * MPa, etaF: 5e-5, etaB: 2e-3,
    defaultDiameter: 0.3 * mm, diameterRange: [0.15 * mm, 0.8 * mm], defaultTension: 40, color: '#9fb7ff',
  },
  {
    id: 'silk', name: '蠶絲', group: 'special', hint: '天然蛋白質纖維',
    density: 1300, youngs: 10 * GPa, strength: 500 * MPa, etaF: 1e-3, etaB: 3e-2,
    defaultDiameter: 0.5 * mm, diameterRange: [0.2 * mm, 1.0 * mm], defaultTension: 30, color: '#ffd1f0',
  },
];

export const GROUP_LABELS: Record<MaterialGroup, string> = {
  instrument: '樂器弦',
  everyday: '生活素材',
  special: '特殊材料',
};

export function materialById(id: string): Material {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}
