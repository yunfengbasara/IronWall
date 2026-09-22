/**
 * 属性结算：把几张表上的数变成"这个人这一刻有多强"的那一份。
 *
 * 数据层（src/data/）只放**不变的定义**，这里做**一次性的运算**，Character 上带的才是
 * 运行时会变的那一份。三者的分工：
 *
 *   data/heroes.ts   一级的双锤武将攻击力 120，每级 +9
 *   这里             十二级、带着铁布衫、拿了两张攻击卡的他，攻击力是 240
 *   Character.stats  他现在身上挂的就是那个 240
 *
 * 结算只在**变的时候**做一次（换角色、升级、拿卡、开新一局、换波次），不是每帧做 —— 场上
 * 七百个敌人，每帧给每个人跑一遍乘法是白扔的。
 */

import {
  CARD_PICKS_FOR_FULL_BUILD,
  FULL_BUILD_WAVES_EARLY,
  GEMS_PER_SPAWN,
  cardCostTotalUnits,
  MAX_ENEMY_SPEED,
  WAVE_ATTACK_PER_WAVE,
  WAVE_ATTACK_SPEED_PER_WAVE,
  WAVE_DEFENSE_PER_WAVE,
  WAVE_EXP_PER_WAVE,
  BOSS_ATTACK_PER_WAVE_EARLY,
  BOSS_ATTACK_PER_WAVE_LATE,
  BOSS_ATTACK_SPEED_PER_WAVE,
  BOSS_DEFENSE_PER_WAVE_EARLY,
  BOSS_DEFENSE_PER_WAVE_LATE,
  BOSS_HP_PER_WAVE_EARLY,
  BOSS_HP_PER_WAVE_LATE,
  WAVE_ATTACK_SPEED_PER_WAVE_LATE,
  WAVE_HP_PER_WAVE,
  WAVE_HP_PER_WAVE_LATE,
  WAVE_EARLY_ATTACK_EASE,
  WAVE_EARLY_SPEED_EASE,
  WAVE_EASE_ATTACK_UNTIL,
  WAVE_RAMP_FROM,
  WAVE_SPEED_PER_WAVE,
  earlyWaveEase,
  lateWaveSteps,
  applyBonuses,
  applyGrowth,
  scaleBonus,
  skillPassiveScale,
} from '../data/balance';
import { passiveById } from '../data/passives';
import type { SkillId } from './skills';
import { NEUTRAL_MODIFIER, type HeroDef, type MapModifier, type StatBonus, type UnitStats } from '../data/types';
import type { ResolvedUnitKind } from '../data/types';
import { spawnsThroughWave, type SpawnTemplate } from '../data/waves';

// ---------------------------------------------------------------- 玩家

/**
 * 一个角色在某个等级上的最终属性。
 *
 * 三层叠加，顺序是有讲究的：先按等级把**绝对**成长摊进基础属性，再把**乘算**的加成乘上去。
 * 反过来的话，被动那一成半会在低等级放大得离谱、在高等级几乎看不见。
 *
 * @param runBonus 这一局里临时拿到的加成（灵石三选一的属性卡）。跨局不保留，所以它是参数
 *                 而不是存档里的字段。以后商店买的永久属性会是第四层，从 profile 里取。
 */
export function resolveHeroStats(
  hero: HeroDef,
  level: number,
  runBonus: StatBonus = {},
  /** 手上那张护身技。四张谁都抽得到，所以它是参数而不是从角色表上读。 */
  guard: SkillId | null = null,
  passiveLevel = 0,
): UnitStats {
  const grown = applyGrowth(hero.base, hero.growth, level);
  // 0 = 这一局还没抽到护身技。开局是没有的 —— 一局从一个自动攻击技加一双靴子起步。
  const passive = guard && passiveLevel >= 1 ? passiveById(guard) : null;
  // 被动跟着**两个**等级长，两者管的不是一回事：
  //
  //   角色等级   跨局的、练出来的。一个一级时 +12% 的被动到三十级还是 +12% 的话，练级越久
  //              它越不值钱。
  //   技能等级   这一局用灵石抽牌堆出来的，打完就清。护身技占着八分之一的升级预算，不给它
  //              一条能涨的路，升到五级就是个什么都没变的技能。
  const base = passive ? scaleBonus(passive.bonus, passive.perLevel, level) : {};
  const shelf = skillPassiveScale(passiveLevel);
  const passiveBonus: StatBonus = {};
  for (const key of Object.keys(base) as (keyof UnitStats)[]) {
    passiveBonus[key] = (base[key] ?? 0) * shelf;
  }
  return applyBonuses(grown, passiveBonus, runBonus);
}

// ---------------------------------------------------------------- 敌人

/**
 * 一个兵种在第 wave 波、这张图上的最终属性。
 *
 * 两层乘算：全局的波次曲线（balance.ts），再乘这张图自己的加成（MapModifier）。地图那一层
 * 还能给"每多一波再加多少"，所以隘口不只是一开始更硬，而是越往后越硬。
 *
 * **首领不吃普通那条波次曲线**，走自己的一组（BOSS_*_PER_WAVE）。他们在 units.ts 里那一档
 * 已经把强度写死了，再乘一遍末波的杂兵曲线会得到一个谁也打不动的东西。但"不吃"不等于"不长"——
 * 以前他们除了血什么都不长，于是末波的首领和第一波的首领打起来一模一样，而玩家涨了六倍。
 * 地图那一层两边照样吃 —— 那才几成的事。
 *
 * 普通兵在 WAVE_RAMP_FROM 波之后还叠一段更陡的（血和出手频率两项），见 balance.ts。
 */
export function resolveEnemyStats(
  kind: ResolvedUnitKind,
  wave: number,
  modifier: MapModifier = NEUTRAL_MODIFIER,
): UnitStats {
  const steps = Math.max(0, wave - 1);
  // 第三波之后的那一段陡坡，只有普通兵吃 —— 首领自己那组斜坡本来就比它陡。
  const late = lateWaveSteps(wave);
  const base = kind.stats;
  const waveHp = kind.boss
    ? 1 + BOSS_HP_PER_WAVE_EARLY * steps + BOSS_HP_PER_WAVE_LATE * late
    : 1 + WAVE_HP_PER_WAVE * steps + WAVE_HP_PER_WAVE_LATE * late;
  /*
   * 前三波的减免，只有普通兵吃 —— 首领自己那两段斜坡已经把开头压软了（底数就是第 1 波
   * 的值）。乘在整条曲线上，见 balance.ts 的 earlyWaveEase。
   */
  // 两条窗口不一样长：攻击拖到第 6 波（新手的缺口在第 4 波），速度只有三波（它有设计合约）。
  const easeAttack = kind.boss ? 1 : earlyWaveEase(wave, WAVE_EARLY_ATTACK_EASE, WAVE_EASE_ATTACK_UNTIL);
  const easeSpeed = kind.boss ? 1 : earlyWaveEase(wave, WAVE_EARLY_SPEED_EASE, WAVE_RAMP_FROM);
  const waveAttack = kind.boss
    ? 1 + BOSS_ATTACK_PER_WAVE_EARLY * steps + BOSS_ATTACK_PER_WAVE_LATE * late
    : (1 + WAVE_ATTACK_PER_WAVE * steps) * easeAttack;
  const waveDefense = kind.boss
    ? 1 + BOSS_DEFENSE_PER_WAVE_EARLY * steps + BOSS_DEFENSE_PER_WAVE_LATE * late
    : 1 + WAVE_DEFENSE_PER_WAVE * steps;
  // 速度那一条首领仍然不吃：他要能被绕开，见 MAX_ENEMY_SPEED 上面那段。
  const waveSpeed = kind.boss ? 1 : (1 + WAVE_SPEED_PER_WAVE * steps) * easeSpeed;
  const waveAttackSpeed = kind.boss
    ? 1 + BOSS_ATTACK_SPEED_PER_WAVE * steps
    : 1 + WAVE_ATTACK_SPEED_PER_WAVE * steps + WAVE_ATTACK_SPEED_PER_WAVE_LATE * late;

  return {
    maxHp: base.maxHp * (waveHp + modifier.hpPerWave * steps) * modifier.enemyHp,
    // 敌人身上没有主动技，所以蓝一直是 0，也不跟着波次涨。
    maxMp: 0,
    mpRegen: 0,
    attack: base.attack * waveAttack * modifier.enemyAttack,
    defense: base.defense * (waveDefense + modifier.defensePerWave * steps) * modifier.enemyDefense,
    // 速度是唯一一个有硬上限的：整套走位设计建立在"走路甩不掉、冲刺能甩掉"上，敌人一旦追过
    // 玩家的冲刺，冲刺这张脱身牌就废了。见 balance.ts 的 MAX_ENEMY_SPEED。
    moveSpeed: Math.min(MAX_ENEMY_SPEED, base.moveSpeed * waveSpeed * modifier.enemySpeed),
    // 不跟波次长：敌人暴击只是给玩家的飘字加一点起伏，让它随波次涨是把一个看不见的难度旋钮写进去。
    crit: base.crit,
    attackRange: base.attackRange,
    attackArc: base.attackArc,
    attackSpeed: base.attackSpeed * waveAttackSpeed,
    pickupRange: 0,
  };
}

/**
 * 这张图上**第一张**三选一要攒多少灵石。往后每张按 CARD_COST_GROWTH 递增。
 *
 * 以前是写死的 100，于是同一个数要同时伺候八波四万六的演武荒原和六波三万三的黑石隘口 ——
 * 短的那张图一局下来只够弹十几次，技能永远练不满。现在按这张图自己的出兵表倒推。
 *
 * 倒推的式子只有一行，三个输入各自回答一个问题：
 *
 *   打到第几波该满配   模板的波数减 FULL_BUILD_WAVES_EARLY。留出最后两波是有意的：那是一局
 *                      的高潮，得让玩家**用**上自己攒了二十分钟的那套东西，而不是在最后一帧
 *                      才凑齐。
 *   那时候有多少灵石   spawnsThroughWave 乘 GEMS_PER_SPAWN。前者是纯数据，后者是离线量出来
 *                      的换算，见 balance.ts。
 *   要抽多少次牌       CARD_PICKS_FOR_FULL_BUILD：八个技能各从 1 级顶到 5 级，三十二次。
 *
 * 加一张图、改一张出兵表、或者以后主动槽从四个开到五个，这个数都会自己跟着走，不用再调。
 */
export function gemsPerCard(template: SpawnTemplate): number {
  const target = Math.max(1, template.waves.length - FULL_BUILD_WAVES_EARLY);
  const gems = spawnsThroughWave(template, target) * GEMS_PER_SPAWN;
  // 除的不是张数而是"张数折算成多少个 base"：门槛是往上走的，见 CARD_COST_GROWTH。
  return Math.max(1, Math.round(gems / cardCostTotalUnits(CARD_PICKS_FOR_FULL_BUILD)));
}

/** 杀掉这个兵给多少经验。波次越高给得越多，难的图再乘一层。 */
export function expFromKill(kind: ResolvedUnitKind, wave: number, modifier: MapModifier = NEUTRAL_MODIFIER): number {
  const steps = Math.max(0, wave - 1);
  return kind.exp * (1 + WAVE_EXP_PER_WAVE * steps) * modifier.expRate;
}
