/**
 * 商店的货架。三档东西，三种花钱的形状。
 *
 *   根基   永久属性，**全账号共享**。金币本来就是一个公共池，按角色分的话四个角色等于四条
 *          独立的长线，而练满一个角色已经要八十五万经验了。
 *   师承   某一招的**初始等级**。买到 +3，那一招无论什么时候到手都从四级起步 —— 对自带的
 *          自动攻击技就是开局直接四级，对抽来的招是抽到那一刻就已经练过了。
 *   补给   一次性的符，游戏里打不出来，买一次用一局。
 *
 * 为什么补给最便宜：它自己会消耗掉。一张符要是和一项永久属性一个价，那它永远不该买 ——
 * 同样的钱买根基是带得走的。"用完就没、下一局再买"那条循环才是它存在的理由。
 *
 * 定价的尺子是**打满一局 575 到 725 枚金币**（四张图各按出兵预算倒推，演武荒原 726、
 * 黑石隘口 651、赤沙荒原 574、雪原 615，均值六百三上下）。中途退出刷金币是亏的：金币按
 * 击杀给，而清场速度随波次涨得比时长快，刷前三波的效率只有打满一局的四分之一。
 *
 * **每一档商品的第 1 级都定在"一局左右"**（根基 400、师承 800、补给 120–300），往后每一级
 * 按三倍上去。第一次打完回到商店必须买得起点什么 —— 那一下是玩家学会"打完一局是有意义的"
 * 的唯一机会；而第二级开始要攒两到四局，才轮到"这笔钱花在哪一项"这个真正的问题。
 */

import type { HudTextKey } from '../ui/text/hudText.types';
import type { StatKey } from './types';
import { Skills, type SkillId } from '../game/skills';
import { SPRINT_SKILL } from '../game/skillLoadout';

/** 一项根基。三级，每级 +3%，满级 +9%。 */
export interface RootDef {
  key: StatKey;
  nameKey: HudTextKey;
  /** 每一级加多少，乘算。 */
  perRank: number;
  /** 第 1/2/3 级各多少钱。 */
  prices: readonly number[];
}

/**
 * 根基能买的六项。
 *
 * 没有暴击：那一项目前在 feat/hero-identity 分支上，主干的 UnitStats 里还没有它。
 * 分支合进来之后在这里添一行就行，别的地方一行都不用改 —— 整张表是数据，界面按它长。
 * 现在的第六项是攻击范围，它是主干上真实存在、而且玩家确实能感觉到的一项。
 */
/**
 * 三级的价钱：**第一级买得起，第二级开始要攒**。
 *
 * 400 / 1200 / 2800 是 1 : 3 : 7，不是等差。理由在第一次打完那一刻：一局收六百多枚，
 * 所以**第一局打完回到商店，一定买得起点什么** —— 那一下是玩家学会"打完一局是有意义的"
 * 的唯一机会。以前第一级就要 1500（两局半），第一次进商店是一屏买不起的东西，
 * 而那等于告诉他这一屏还不关他的事。
 *
 * 第二级 1200 要攒两局，第三级 2800 要攒四局半 —— 从这里开始它才是一个"要不要现在花"的
 * 决定：同样的钱可以买另一项的第一级。一项顶满 4400（七局），六项全顶 26,400。
 */
const ROOT_PRICES = [400, 1200, 2800] as const;

export const Roots: readonly RootDef[] = [
  { key: 'maxHp', nameKey: 'rootMaxHp', perRank: 0.03, prices: ROOT_PRICES },
  { key: 'attack', nameKey: 'rootAttack', perRank: 0.03, prices: ROOT_PRICES },
  { key: 'defense', nameKey: 'rootDefense', perRank: 0.03, prices: ROOT_PRICES },
  { key: 'moveSpeed', nameKey: 'rootMoveSpeed', perRank: 0.03, prices: ROOT_PRICES },
  { key: 'attackSpeed', nameKey: 'rootAttackSpeed', perRank: 0.03, prices: ROOT_PRICES },
  { key: 'attackRange', nameKey: 'rootAttackRange', perRank: 0.03, prices: ROOT_PRICES },
];

export const ROOT_MAX_RANK = 3;

/**
 * 师承：第 1/2/3 级各多少钱。
 *
 * 不限制能买几招 —— 价格本身就是闸。一招买到 +3 是九千二（十四五局），而打满一局六百多，
 * 没有人会把十招都堆上去。限制一个数量反而要在界面上解释"为什么这一格不让买"。
 *
 * 比根基整体贵一倍，档位的比例一样（1 : 3 : 7.5）：一招从四级起步比"某一项属性 +3%"值钱
 * 得多 —— 它改的是开局那几分钟到底有多难熬。但第一级仍然压在 800（一局出头）：
 * **每一档商品都该有一个"打一两局就摸得到"的入口**，否则师承这一栏在前十局里只是一排灰字。
 */
export const MASTERY_PRICES: readonly number[] = [800, 2400, 6000];
export const MASTERY_MAX = 3;

/** 补给：商店独有的符，买一次用一局。id 对应 data/pickups.ts 里 weight 为 0 的那四张。 */
export interface SupplyDef {
  id: string;
  price: number;
}

/*
 * 补给跟着降了一档，而且**必须比根基的第一级（400）便宜**。
 *
 * 这不是手松，是顺序问题：一张用完就没的符要是和一项永久属性一个价，那它永远不该买 ——
 * 同样的钱买根基是带得走的。补给的位置是"这一局我想怎么打"，所以它得站在永久那一档下面，
 * 玩家才会在每一局开始前真的去点它。
 *
 * 聚宝符是例外，留在 300 没动：它的收益本来就是用金币量出来的（一局多收六百多枚），
 * 再便宜就成了一张每局必点的税单，而不是一个赌注。
 */
export const Supplies: readonly SupplyDef[] = [
  { id: 'charm-rage', price: 150 },
  { id: 'charm-gale', price: 120 },
  { id: 'charm-aegis', price: 200 },
  { id: 'charm-fortune', price: 300 },
];

/** 一种补给最多屯几个。四个快捷栏格子，屯多了进去也摆不下。 */
export const SUPPLY_MAX = 4;

/** 聚宝符：金币掉落翻几倍。 */
export const FORTUNE_COIN_MULTIPLIER = 2;

/** 第 rank 级（从 1 数起）的价钱。买不起或者满了返回 null。 */
export function rootPrice(def: RootDef, owned: number): number | null {
  return owned >= ROOT_MAX_RANK ? null : def.prices[owned];
}

export function masteryPrice(owned: number): number | null {
  return owned >= MASTERY_MAX ? null : MASTERY_PRICES[owned];
}

/** 这一招买到 owned 级之后，它的起始等级是多少。 */
export const startLevelOf = (owned: number): number => 1 + Math.max(0, Math.min(MASTERY_MAX, owned));

/**
 * 师承能买的招：除了疾走以外全部。
 *
 * 从 Skills 表里现算而不是手写一份清单：加一个新招（比如分支上那两个），货架自己就长出来了。
 * 疾走不在里面 —— 它不分级，也不进牌库。
 */
export const masterySkills = (): SkillId[] =>
  Skills.filter((skill) => skill.id !== SPRINT_SKILL).map((skill) => skill.id);
