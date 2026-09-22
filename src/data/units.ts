/**
 * 兵种表：会遇到谁、他有多强。
 *
 * 这张表取代了 waves.ts 里原来那个 EnemyKinds。那边一条记录是 `{ def, palette, speed }` ——
 * 长相、配色，外加一个孤零零的速度。速度当年没放进 UnitDef 是对的（它不是长相），但它也
 * 没有别的地方可去，只好挂在出兵表上。现在它和血、攻、防、范围、频率一起回到同一条记录里。
 *
 * 出兵模板（waves.ts）按 id 配比例，只认名字，不认属性 —— 改一个兵种有多强不用碰任何一张
 * 出兵表，反过来也一样。
 *
 * 这里的数是**第一波**的值。往后每一波按 balance.ts 的波次曲线整体抬高，地图还能再乘一层，
 * 见 game/stats.ts 的 resolveEnemyStats。
 */

import { PALETTE_PEASANT, PALETTE_RED } from '../characters/palette';
import { CRIT_CHANCE_BASIC } from './balance';
import { unitAppearance } from '../characters/unitDef';
import type { ResolvedUnitKind, UnitKindDef, UnitStats } from './types';

/**
 * 兵种的名字。出兵模板按它配比例，改名字要同步改所有模板。
 *
 * 首领（elite / knightBoss）也在这个联合里，但**不写进任何一张出兵模板的 mix** —— 首领的
 * 出场由 WaveSpec.bosses 单独管，混进普通配比就成了大号杂兵。
 */
export type EnemyKindId =
  | 'thug'
  | 'peasant'
  | 'spearman'
  | 'shieldman'
  | 'bulwark'
  | 'archer'
  | 'halberdier'
  | 'cavalry'
  | 'lancer'
  | 'horseArcher';

export type BossKindId = 'elite' | 'knightBoss';
export type UnitKindId = EnemyKindId | BossKindId;

/**
 * 一个杂兵的属性底稿。十种兵都是在它上面改几项 —— 这样"这个兵和普通兵差在哪儿"是**写出来**
 * 的，而不是要拿两行数去对。
 */
const grunt = (overrides: Partial<UnitStats>): UnitStats => ({
  maxHp: 400,
  // 敌人不耗蓝：他们身上只有基础攻击，没有主动技。字段还是得有 —— 玩家和敌人共用同一份
  // 属性形状，让敌人少一个字段就得给每个读它的地方加一个分支。
  maxMp: 0,
  mpRegen: 0,
  // 敌人的暴击率全部用基准线。暴击是给玩家看的一个奖励，敌人那一侧只需要一个数。
  crit: CRIT_CHANCE_BASIC,
  attack: 10,
  defense: 4,
  moveSpeed: 12,
  attackRange: 11,
  attackArc: 1.6,
  attackSpeed: 1,
  // 敌人不捡东西。字段还是得有 —— 玩家和敌人共用同一个伤害公式和同一份属性形状，让敌人
  // 少一个字段就得给每个读它的地方加一个分支。
  pickupRange: 0,
  ...overrides,
});

/**
 * 全部兵种。
 *
 * 血量这一列的基准是"一级玩家一刀能不能秒"：双锤武将一级 120 攻击，打杂兵（4 防）实收约
 * 115，所以 40 血的杂兵一刀一个 —— 割草的手感在第一波必须是原样的。往上是按"要补几刀"排的：
 * 持盾兵和戟兵两刀，轻骑三刀，枪骑兵四刀。技能那一下按 SKILL_DAMAGE_PER_POWER 翻倍，所以
 * 用招时这几档各自减半。
 *
 * 速度沿用接数据层之前那一版的数（是按"多久能走进画面"倒推的，不是写实步速），一个没动。
 */
export const UnitKinds: readonly UnitKindDef[] = [
  {
    id: 'thug',
    nameKey: 'unitThugName',
    noteKey: 'unitThugNote',
    appearance: 'thug',
    palette: PALETTE_RED,
    stats: grunt({}),
    exp: 1,
  },
  {
    id: 'peasant',
    nameKey: 'unitPeasantName',
    noteKey: 'unitPeasantNote',
    appearance: 'thug',
    palette: PALETTE_PEASANT,
    // 比杂兵更脆更快：他是来填人数的，不是来打人的。
    stats: grunt({ maxHp: 320, attack: 8, defense: 2, moveSpeed: 14 }),
    exp: 1,
  },
  {
    id: 'spearman',
    nameKey: 'unitSpearmanName',
    noteKey: 'unitSpearmanNote',
    appearance: 'spearman',
    palette: PALETTE_RED,
    stats: grunt({ maxHp: 550, attack: 12, defense: 7, moveSpeed: 11, attackRange: 20, attackArc: 0.9 }),
    exp: 2,
  },
  {
    id: 'shieldman',
    nameKey: 'unitShieldmanName',
    noteKey: 'unitShieldmanNote',
    appearance: 'shieldman',
    palette: PALETTE_RED,
    // 防御是杂兵的四倍 —— "正面推不动"这件事以前只写在说明里，现在是个真的数。
    stats: grunt({ maxHp: 850, attack: 10, defense: 16, moveSpeed: 9, attackArc: 1.5, attackSpeed: 0.85 }),
    exp: 3,
  },
  {
    id: 'bulwark',
    nameKey: 'unitBulwarkName',
    noteKey: 'unitBulwarkNote',
    appearance: 'bulwark',
    palette: PALETTE_RED,
    // **全场防御最高的杂兵**：34 挡掉玩家 25.4% 的伤害（持盾兵 16 是 13.8%，末波枪骑兵
    // 那一档才追得上），已经摸到首领的量级（精锐 40）而仍然低于他 —— 首领必须还是最硬的
    // 那一个。血也给到杂兵里的头一档，两样加起来就是"这个人得砍好几刀"。
    //
    // 代价全写在别的列里，不然他就是个无解的东西：
    //   最慢（7）     —— 全场最慢，比持盾兵还慢两档。这是玩家唯一稳定的解法：走开。一堵
    //                    墙的压力来自推不动，不来自追得上。
    //   出手最慢（0.7）—— 他不挥，所以"他要打我了"在画面上没有任何预告。再给一个快的频率，
    //                    玩家会觉得自己在被看不见的东西扎。
    //   攻击只有 15    —— 比戟兵还低。他是一堵墙，不是一把刀。
    //
    // 范围 24 就是那条画出来的线：杆长 15×2.1，握点往前占七成，矛尖落在身体中心前面约 24 个
    // 单位。判定还会再加上两个人的身体半径（见 battle.ts 的 reachable），所以实战里他比画面上
    // 再够远一点点 —— 全场每个兵都是这么算的。
    //
    // attackArc 0.6 是全场最窄的，填的是这杆矛真实的样子（只戳正前方那一条线）。**但敌人这
    // 一侧现在用不上它**：敌人打玩家只看距离，不看角度（同上，reachable 那段注释写了为什么）。
    // 照实填是为了哪天角度判定接上来时它是对的，而不是留一个"绕到侧面就安全"的假承诺。
    stats: grunt({
      maxHp: 1400, attack: 15, defense: 34, moveSpeed: 7,
      attackRange: 24, attackArc: 0.6, attackSpeed: 0.7,
    }),
    exp: 6,
  },
  {
    id: 'archer',
    nameKey: 'unitArcherName',
    noteKey: 'unitArcherNote',
    appearance: 'archer',
    palette: PALETTE_PEASANT,
    stats: grunt({ maxHp: 340, attack: 12, defense: 3, moveSpeed: 15, attackRange: 96, attackArc: 1.4, attackSpeed: 0.9 }),
    exp: 2,
  },
  {
    id: 'halberdier',
    nameKey: 'unitHalberdierName',
    noteKey: 'unitHalberdierNote',
    appearance: 'halberdier',
    palette: PALETTE_RED,
    // 全场伤害最高的步兵，代价是抡起来慢（attackSpeed 0.8）。
    stats: grunt({ maxHp: 700, attack: 16, defense: 9, moveSpeed: 10, attackRange: 16, attackArc: 1.25, attackSpeed: 0.8 }),
    exp: 3,
  },
  {
    id: 'cavalry',
    nameKey: 'unitCavalryName',
    noteKey: 'unitCavalryNote',
    appearance: 'cavalry',
    palette: PALETTE_RED,
    stats: grunt({ maxHp: 950, attack: 14, defense: 10, moveSpeed: 16, attackRange: 20, attackArc: 1.6 }),
    exp: 5,
  },
  {
    id: 'lancer',
    nameKey: 'unitLancerName',
    noteKey: 'unitLancerNote',
    appearance: 'lancer',
    palette: PALETTE_RED,
    // 最硬的杂兵。马衣在画面上是"贵"，在这张表里就是血和防御。
    stats: grunt({ maxHp: 1300, attack: 20, defense: 18, moveSpeed: 14, attackRange: 30, attackArc: 0.95, attackSpeed: 0.85 }),
    exp: 7,
  },
  {
    id: 'horseArcher',
    nameKey: 'unitHorseArcherName',
    noteKey: 'unitHorseArcherNote',
    appearance: 'horseArcher',
    palette: PALETTE_PEASANT,
    stats: grunt({ maxHp: 600, attack: 12, defense: 6, moveSpeed: 16, attackRange: 84, attackArc: 1.4, attackSpeed: 0.95 }),
    exp: 5,
  },

  // ------------------------------------------------------------ 首领
  //
  // 属性和杂兵是同一套字段，只是数大一截 —— 首领不需要新的机制，需要的是"打不动"这件事
  // 真的成立。他是场上唯一一个要认真打十几秒的人。
  //
  // 他们不吃普通那条波次曲线，走自己的两段斜坡（balance.ts 的 BOSS_*_PER_WAVE_EARLY/LATE）。
  //
  // **下面这三个数是"第 1 波的首领"，不是"首领"。** 这一条很容易记反：血 3200、防 45、攻 60
  // 看着一点都不像首领，而末波那个是 51,680 / 211 / 381 —— 十几倍的差距全在那两段斜坡上。
  // 想让首领整体更硬，改 balance.ts 的 LATE 那几条；想让**开局第一个**更软，才改这里。
  //
  // 防御 45 是照着老版本的 40 定的：那一档一个一级玩家砍得动，而首领的毛病从来不在开局太软。
  // 它往后每波按 DEFENSE_SCALE 那条递减曲线长上去，末波的 211 挡掉玩家 68% 的伤害 —— 那时候
  // 他才是"硬得像一堵墙"。防御比血要紧，因为玩家身上叠的全是乘算加成：只加血的话首领就是个
  // 数字很大的沙袋，砍的时间变长了，但每一刀仍然轻飘飘。
  {
    id: 'elite',
    nameKey: 'unitEliteName',
    noteKey: 'unitEliteNote',
    appearance: 'elite',
    palette: PALETTE_RED,
    stats: grunt({ maxHp: 3200, attack: 60, defense: 45, moveSpeed: 22, attackRange: 19, attackArc: 1.5, attackSpeed: 0.85 }),
    boss: true,
    exp: 500,
  },
  {
    id: 'knightBoss',
    nameKey: 'unitKnightBossName',
    noteKey: 'unitKnightBossNote',
    appearance: 'knight',
    palette: PALETTE_RED,
    stats: grunt({ maxHp: 2240, attack: 48, defense: 36, moveSpeed: 26, attackRange: 16, attackArc: 1.7, attackSpeed: 1.05 }),
    boss: true,
    exp: 380,
  },
];

const byId = new Map<string, UnitKindDef>(UnitKinds.map((kind) => [kind.id, kind]));

export function unitKind(id: UnitKindId): UnitKindDef {
  const kind = byId.get(id);
  // 取不到就说明有人改了名字而没有同步出兵模板。宁可当场炸，也别默默画错人。
  if (!kind) throw new Error(`Unknown unit kind: ${id}`);
  return kind;
}

/**
 * 把一条兵种记录展开成能直接用的形式：外观工厂变成一份真的 UnitDef。
 *
 * 同一个兵种的几百个人共用**同一份** UnitDef 和调色板 —— 它们是只读的，一百个杂兵指向同一
 * 份就够了。所以这里缓存，不是每次现造。
 */
const resolved = new Map<string, ResolvedUnitKind>();

export function resolveKind(id: UnitKindId): ResolvedUnitKind {
  const hit = resolved.get(id);
  if (hit) return hit;
  const kind = unitKind(id);
  const made: ResolvedUnitKind = {
    id: kind.id,
    def: unitAppearance(kind.appearance),
    palette: kind.palette,
    stats: kind.stats,
    boss: kind.boss ?? false,
    exp: kind.exp,
  };
  resolved.set(id, made);
  return made;
}

/** 出兵模板能配比例的那几种，不含首领。 */
export const EnemyKindIds: readonly EnemyKindId[] = UnitKinds
  .filter((kind) => !kind.boss)
  .map((kind) => kind.id as EnemyKindId);
