import {
  SkillCategoryRules,
  Skills,
  skillById,
  skillsInCategory,
  type SkillDef,
  type SkillId,
} from './skills';
import { SKILL_MAX_LEVEL, skillDamageScale, skillMpScale, skillRateScale, skillReachScale } from '../data/balance';

/**
 * 主动槽与键位一一对应；UI、输入和战斗逻辑都从这里读，避免各写一份顺序。
 *
 * **Q/W/E 三个连着的键**，加上 R 那一格钉死的疾走，正好是键盘上 QWER 那一片。走路搬到方向
 * 键之后 W 就腾出来了 —— 在那之前它归 WASD，所以三个槽只能是 Q/E/R，中间空一格，按起来要
 * 跳一下。现在三格是挨着的。
 */
export const ACTIVE_SKILL_KEYS = ['Q', 'W', 'E'] as const;
export const ACTIVE_SKILL_CODES = ['KeyQ', 'KeyW', 'KeyE'] as const;
export type ActiveSkillSlot = 0 | 1 | 2;

/**
 * 疾走。**不占主动槽**，键位是 R（Shift 也照样管用），四个角色都一样，装不上也卸不掉。
 *
 * 它是走位本身，不是一个配招选择。而且跑步的键位必须永远是同一个 —— 跟着配招变的话，手就
 * 没法记。所以它既不进牌库，也不进 Q/W/E 那三格：一直都在，一直在 R 上。
 *
 * 两个键并存的理由见 ui/controls.ts 的 sprintHeld：R 挨着那三个技能键，Shift 是这一类游戏
 * 几十年的肌肉记忆。
 */
export const SPRINT_SKILL: SkillId = 'sprint';

export interface SkillLoadoutSnapshot {
  attack: SkillId;
  projectiles: SkillId[];
  guard: SkillId | null;
  active: (SkillId | null)[];
  equipped: SkillId[];
  cooldowns: Record<SkillId, number>;
  levels: Record<SkillId, number>;
}

const cooldownTable = (): Record<SkillId, number> =>
  Object.fromEntries(Skills.map((skill) => [skill.id, 0])) as Record<SkillId, number>;

const levelTable = (): Record<SkillId, number> =>
  Object.fromEntries(Skills.map((skill) => [skill.id, 1])) as Record<SkillId, number>;

/**
 * 技能装备与独立冷却。
 *
 * - attack / guard 由类别规则保证单选；选择新的会替换旧的。
 * - projectile 是集合，可同时装备并各走自己的冷却。
 * - active 放进四个有顺序的主动槽，由 Q/W/E/R 触发。
 *
 * Battle 只问“这一项是否装备、是否冷却完”，不再自己维护互斥规则。以后加新技能时，通常只需
 * 在 skills.ts 登记 category 与 cooldown；只在出现全新结算形状时才需要扩展 Battle.castSkill。
 */
/**
 * 一局之内能抽到的招。自动攻击技和疾走不在里面 —— 那两样开局就带着。
 *
 * 从 Skills 表里现算而不是手写一份：加一个新的招，牌库自己就长出来了，不用再记得回来改
 * 一张清单。
 *
 * **护身技也在里面，四张谁都抽得到。** 以前是一人一张、写死在角色表上的，于是用双锤打就
 * 永远看不到磐石 —— 而它们本来就只是四包不同的属性加成（见 data/passives.ts），没有任何理由
 * 挂在某一个人名下。骑士仍然开局就戴着磐石，那是给他补的一块底（见 HeroDef.startGuard），
 * 不是对牌库的限制。
 */
export function runSkillPool(): SkillId[] {
  return Skills
    .filter((skill) => skill.id !== SPRINT_SKILL)
    .filter((skill) => skill.category !== 'attack')
    .map((skill) => skill.id);
}

/**
 * 玩家这一局带着哪些招、各自练到几级、各自冷却到哪儿。
 *
 * **开局是空的**：一个自动攻击技，加一双钉死在 Shift 上的靴子，别的全靠场上收灵石抽牌拿（见
 * startRun）。以前这几个字段的初值是一整套配好的招 —— 那是**调试**用的，调试菜单一开就能
 * 把每一招都摆出来看。把调试的方便当成开局状态，玩家第一分钟就拿着满配，一局里再没有"我
 * 变强了"这回事。
 */
export class SkillLoadout {
  attackSkill: SkillId = 'sweep';
  guardSkill: SkillId | null = null;
  readonly projectileSkills = new Set<SkillId>();
  readonly activeSkillSlots: (SkillId | null)[] = [null, null, null];

  private readonly cooldowns = cooldownTable();

  /**
   * 每个技能这一局练到了几级，1 起步。
   *
   * **一局之内的东西**，和灵石一样：等级是靠场上收灵石抽牌攒起来的，打完就清零。跨局留下来
   * 的是角色等级和已经学会的招（存档，见 game/profile.ts），不是这一局堆出来的强度。
   */
  private readonly levels = levelTable();

  snapshot(): SkillLoadoutSnapshot {
    return {
      attack: this.attackSkill,
      projectiles: [...this.projectileSkills],
      guard: this.guardSkill,
      active: [...this.activeSkillSlots],
      equipped: Skills.filter((skill) => this.isEquipped(skill.id)).map((skill) => skill.id),
      cooldowns: { ...this.cooldowns },
      levels: { ...this.levels },
    };
  }

  level(id: SkillId): number {
    return this.levels[id];
  }

  maxed(id: SkillId): boolean {
    return this.levels[id] >= SKILL_MAX_LEVEL;
  }

  /**
   * 直接把一招设到某一级。**调试用**，正常局里的升级只走 raiseLevel（三选一）。
   *
   * 夹在 1 到 SKILL_MAX_LEVEL 之间；越界的值会让所有倍率（伤害、距离、出手频率、
   * 碎片量、掀飞距离）一起跑到表外，那测的就不是游戏里真实存在的东西了。
   */
  setLevel(id: SkillId, level: number): void {
    this.levels[id] = Math.max(1, Math.min(SKILL_MAX_LEVEL, Math.floor(level)));
  }

  /** 升一级。已经满级返回 false。 */
  raiseLevel(id: SkillId): boolean {
    if (this.maxed(id)) return false;
    this.levels[id]++;
    return true;
  }

  /** 这一局还能升级的技能：装备着、而且没满级。三选一的货架就是它。 */
  upgradable(): SkillDef[] {
    return Skills.filter((skill) => this.isEquipped(skill.id) && !this.maxed(skill.id));
  }

  /** 这一招练到现在，作用距离是表里那个数的几倍。 */
  reachScale(id: SkillId): number {
    // 破空有自己那条更陡的成长，别的招全用全局那一档。见 SkillDef.reachGrowth。
    return skillReachScale(this.levels[id], skillById(id).reachGrowth);
  }

  /** 这一招练到现在，法力开销是表里那个数的几倍。 */
  /** 这一招现在打多疼，倍率。一级是 1。 */
  damageScale(id: SkillId): number {
    return skillDamageScale(this.levels[id]);
  }

  /** 这一招的冷却乘多少。升级就是出手更密。 */
  rateScale(id: SkillId): number {
    return skillRateScale(this.levels[id]);
  }

  mpScale(id: SkillId): number {
    return skillMpScale(this.levels[id]);
  }

  /**
   * 每一招的起始等级。默认全是 1，商店买了师承的那几招高一截（见 data/shop.ts）。
   *
   * 存在 SkillLoadout 上而不是每次 startRun 传进来：重开一局（X 键）走的也是 startRun，
   * 而那一条路上没有 profile。
   */
  startLevels: Partial<Record<SkillId, number>> = {};

  resetLevels(): void {
    for (const skill of Skills) {
      this.levels[skill.id] = Math.max(1, Math.min(SKILL_MAX_LEVEL, this.startLevels[skill.id] ?? 1));
    }
  }

  isEquipped(id: SkillId): boolean {
    const skill = skillById(id);
    switch (skill.category) {
      case 'attack':
        return this.attackSkill === id;
      case 'projectile':
        return this.projectileSkills.has(id);
      case 'guard':
        return this.guardSkill === id;
      case 'active':
        // 疾走不在那三格里，可它一直都装着（Shift 永远能按）。不特判的话，它会被读作"没装"
        // —— 于是抽牌时它算成一张可抽的新牌，调试菜单里也显示成卸掉了。
        return id === SPRINT_SKILL || this.activeSkillSlots.includes(id);
    }
  }

  /** 明确设置装备状态；返回 false 表示类别规则不允许（例如卸下唯一的自动攻击或主动槽已满）。 */
  setEquipped(id: SkillId, enabled: boolean): boolean {
    const skill = skillById(id);
    switch (skill.category) {
      case 'attack':
        if (!enabled) return false;
        this.attackSkill = id;
        return true;

      case 'projectile':
        if (enabled) this.projectileSkills.add(id);
        else this.projectileSkills.delete(id);
        return true;

      case 'guard':
        if (enabled) this.guardSkill = id;
        else if (this.guardSkill === id) this.guardSkill = null;
        return true;

      case 'active': {
        // 疾走谁也动不了：它不是配招的一部分，见 SPRINT_SKILL。
        if (id === SPRINT_SKILL) return enabled;
        const current = this.activeSkillSlots.indexOf(id);
        if (!enabled) {
          if (current >= 0) this.activeSkillSlots[current] = null;
          return true;
        }
        if (current >= 0) return true;
        const empty = this.activeSkillSlots.indexOf(null, 0);
        if (empty < 0) return false;
        this.activeSkillSlots[empty] = id;
        return true;
      }
    }
  }

  /**
   * 开一局：清空一切，只留这个角色的自动攻击技和 Shift 上的疾走。
   *
   * 清空是必须的，不是保险 —— 上一局抽到的发射技和主动槽还在的话，装出来的会是两局的并集，
   * 而这一局的全部乐趣就是从零再堆一套。等级和冷却一起归零，理由相同。
   *
   * @param attack 这个角色的自动攻击技。**自动攻击那一栏不许为空**（见 setEquipped），它是
   *               玩家手上唯一一件一直能用的东西。
   * @param guard  开局就戴着的护身技，没有就传 null。目前只有骑士有一张，见
   *               HeroDef.startGuard。
   */
  startRun(attack: SkillId, guard: SkillId | null = null): void {
    this.projectileSkills.clear();
    this.guardSkill = null;
    for (let i = 0; i < this.activeSkillSlots.length; i++) this.activeSkillSlots[i] = null;
    this.setEquipped(attack, true);
    if (guard) this.setEquipped(guard, true);
    // 疾走不用装：它不在这三格里，也不参与抽牌 —— 换谁上场、抽到什么，跑步都在 Shift 上。
    this.resetCooldowns();
    this.resetLevels();
  }

  toggle(id: SkillId): boolean {
    const skill = skillById(id);
    if (skill.category === 'attack') return this.setEquipped(id, true);
    return this.setEquipped(id, !this.isEquipped(id));
  }
  cycleAttack(): void {
    const attacks = skillsInCategory('attack');
    const current = attacks.findIndex((skill) => skill.id === this.attackSkill);
    this.attackSkill = attacks[(current + 1 + attacks.length) % attacks.length].id;
  }

  automaticSkills(): SkillDef[] {
    return Skills.filter(
      (skill) =>
        SkillCategoryRules[skill.category].trigger === 'automatic' && this.isEquipped(skill.id),
    );
  }

  tick(dt: number): void {
    for (const skill of Skills) {
      this.cooldowns[skill.id] = Math.max(0, this.cooldowns[skill.id] - dt);
    }
  }

  ready(id: SkillId): boolean {
    return this.cooldowns[id] <= 0;
  }

  consume(id: SkillId): void {
    // 升级压冷却（见 SKILL_LEVEL_RATE）。自动攻击那一条另外走：它的间隔还包含挥击动作本身，
    // 而动作长度是角色属性，不该跟着技能等级缩（见 battle.ts 的 startPlayerAttack）。
    this.cooldowns[id] = skillById(id).cooldown * this.rateScale(id);
  }

  cooldownOf(id: SkillId): number {
    return this.cooldowns[id];
  }

  resetCooldowns(): void {
    for (const skill of Skills) this.cooldowns[skill.id] = 0;
  }
}
