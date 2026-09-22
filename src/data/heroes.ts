/**
 * 备战界面上能选的出战角色，以及他们各自有多强。
 *
 * 这张表接替了 game/roster.ts。搬过来顺手砍掉了两件事：
 *
 *   对 battle.ts 的依赖 —— 原来 HeroDef 用一个下标指 PlayerPresets，于是一张纯数据表反向
 *   依赖了两千五百行的战斗引擎，备战界面只想读一个角色名也得把整个引擎拖进来。而且那张表
 *   "只能往后加"，中间插一条就会把所有角色悄悄换成别人。现在直接写形象的名字。
 *
 *   "一个数值都没有" —— 原来那张表的注释里写着这句，等级、生命、法力在界面上一律显示破折号。
 *   现在每个角色有完整的基础属性和一张成长表。
 *
 * 加一个角色就是往下面这个数组里再加一条：起个 id、挑一份形象、写六项基础属性、挑一种成长
 * 类型、给一个被动，界面和存档会自己长出来（存档按 id 记等级，见 game/profile.ts）。
 */

import type { HudTextKey } from '../ui/text/hudText.types';
import type { HeroDef, UnitStats } from './types';

/**
 * 基础属性的基准线，也就是接数据层之前那个写死的玩家。
 *
 * 保留它不只是省字：**双锤武将一级时的手感必须和以前一模一样**。移动速度 32 是原来的
 * PLAYER_SPEED，攻击范围 34 和张角 1.9 是原来挂在 UnitDef 上的武将那两项，攻击频率 1 就是
 * 武器动作本身的节奏（原来的 PLAYER_SWING_GAP 是 0）。加了一层数据不该偷偷改掉基准。
 *
 * 生命是唯一一个大改的：原来是 100 点、敌人每下扣 1 点，也就是能挨一百下。现在伤害是真的
 * 算出来的（杂兵一下打掉八九点），所以上限得抬到一千出头，"能挨一百下"这件事才不变。
 */
const baseline: UnitStats = {
  maxHp: 1200,
  /*
   * 法力。这是这一版新加的一条闸。
   *
   * 100 上限配每秒 3.4 点回复，等于**三十秒回满**。按这个基准，三个主动技连着放一轮要等二十多秒 ——
   * 比任何单个技能的冷却都长得多。于是"下一招什么时候能放"有两条独立的闸：冷却管单个技能的
   * 间隔，蓝管几个技能加起来的总量。只有冷却的话，玩家最优解永远是"三个键轮着按"。
   *
   * **为什么从每秒 9 压到 3.4：为了让蓝药有分量。** 一颗回蓝丹给四成上限，而回复每秒 9 的时候
   * 那相当于**站着不动五秒** —— 一件要占快捷栏一格、要跑去砸篝火才能拿到的东西，不能只值五秒。
   * 蓝的水位不是靠加耗蓝的地方压住的，是靠这一个数 —— 回得快的话，加多少开销都只是把均值压低
   * 一截，那颗丹仍然只值五秒。
   */
  maxMp: 100,
  mpRegen: 3.4,
  attack: 120,
  defense: 40,
  /*
   * 暴击率。基准就是以前那个写死的全局值，所以双锤武将的手感一点没变。
   *
   * 它是四个角色里最好拉开的一项：别的五项都直接改手感（跑多快、挥多快、撑多久），
   * 而暴击改的是**节奏的起伏** —— 高暴击的人均伤不一定高，但他的画面上一直在跳大数字。
   */
  crit: 0.09,
  moveSpeed: 32,
  attackRange: 34,
  /*
   * 挥出去有多宽，弧度。1.9 是 109°，那已经是"身前一切"了 —— 配上横扫的距离倍率，
   * 玩家看到的是一把刷子从屏幕这头刷到那头，不是一道挥击。
   *
   * 1.4 是 80°：仍然是全场最宽的一招（骑士 1.7 是回旋的整圈、不走这一项，剑士 1.7，
   * 骠骑 0.95），但两侧重新有了空档 —— 玩家绕到供侧面这件事才重新有意义。
   */
  attackArc: 1.4,
  attackSpeed: 1,
  // 原来写死在 collectibles.ts 里的 MAGNET_RADIUS。
  pickupRange: 68,
};

const stats = (overrides: Partial<UnitStats>): UnitStats => ({ ...baseline, ...overrides });

/*
 * 关于成长表里的 attackRange：**它比看上去重得多。**
 *
 * 每一招的作用半径都是 `attackRange × skill.reach`（见 battle.ts 的 castSkill），而横扫的
 * reach 是 1.8 —— 攻击距离每涨一点，扫出去的扇面就涨两点一，而扇面的**面积**涨得更快（平方）。
 * 双锤武将原来每级 0.35，到 27 级扫出的半径是 78 个单位 —— 而出货视口的半宽才 155，
 * 一招就盖出去半个屏幕。那不是"练得更强"，那是整局没有距离可言了。
 *
 * 所以这一项压到原来的四分之一：十几二十级下来长一两个单位，能感觉到但不改变局面。
 * **攻击力和出手频率那两项一动不动** —— 等级该换来的是"打得更疼、挥得更快"，
 * 不是"站在原地就能够到屏幕边上"。
 */

export const Heroes: readonly HeroDef[] = [
  {
    id: 'warlord',
    nameKey: 'heroWarlordName',
    taglineKey: 'heroWarlordTagline',
    blurbKey: 'heroWarlordBlurb',
    archetype: 'balanced',
    appearance: 'warlord',
    // 基准角色：全部落在基线上，别的角色和他比。
    base: stats({}),
    growth: {
      maxHp: 26,
      maxMp: 2.4,
      mpRegen: 0.04,
      attack: 9,
      defense: 1.2,
      moveSpeed: 0.15,
      attackRange: 0.08,
      attackSpeed: 0.012,
      pickupRange: 0.8,
    },
    attackSkill: 'sweep',
  },
  {
    id: 'knight',
    nameKey: 'heroKnightName',
    taglineKey: 'heroKnightTagline',
    blurbKey: 'heroKnightBlurb',
    archetype: 'defense',
    appearance: 'knight',
    // 防御型：血最厚、防御最高，代价是够不远（16 是原来挂在 knight 预设上的那个数）也打不快。
    base: stats({ crit: 0.05, maxHp: 1600, attack: 95, defense: 60, moveSpeed: 30, attackRange: 16, attackArc: 1.7, attackSpeed: 0.92, maxMp: 120, mpRegen: 3 }),
    growth: {
      maxHp: 42,
      maxMp: 3,
      mpRegen: 0.034,
      attack: 6,
      defense: 2.4,
      moveSpeed: 0.1,
      attackRange: 0.04,
      attackSpeed: 0.008,
      pickupRange: 0.8,
    },
    attackSkill: 'spin',
    // 四人里只有他开局就戴着护身技，见 HeroDef.startGuard。他是唯一一个"扛得住才打得
    // 出来"的角色，而护身技现在是谁都能抽的，所以这一行只是把他的开局提前到手。
    startGuard: 'bulwark',
  },
  {
    id: 'swordsman',
    nameKey: 'heroBladeName',
    taglineKey: 'heroBladeTagline',
    blurbKey: 'heroBladeBlurb',
    archetype: 'offense',
    appearance: 'hero',
    /*
     * 进攻型：打得最疼、暴击最高，血和防御最薄。他本来也不该挤进人堆。
     *
     * **attackRange 从 16 抬到 22，这是这条记录里最要紧的一次改动。** 那一项身兼两职：
     * 它既是近战兵器的长度（一个风味设定 —— "短剑，得贴身"），又是**每一招**作用半径的
     * 乘数（reach = attackRange × skill.reach，见 battle.ts 的 castSkill）。于是给他配一把
     * 短剑，等于把他这辈子放的每一招的半径砍掉一半、面积砍掉四分之三 —— 不只是破空，横扫、
     * 罩子、磐石的流星轨道、神兵天降，全都乘这个数。
     *
     * 症状是"任何技能在他身上都感觉很水"，而那是字面上成立的。离线横着量，他的清场速度是
     * 武将的 40%，四个角色垫底。这个坑代码里撞过一次：骑士也是 16，回旋那条注释写着"骑士在
     * 两头都落后……圈只有 20 个单位，武将那把扇面是 54"，当时的补救是把 power 抬到 2.5。
     * 剑士没拿到那个补丁，而且 **power 对他也不管用** —— 他本来就一刀一个杂兵，再加伤害一个
     * 人都多杀不了，瓶颈纯粹是面积。
     *
     * 22 之后他所有的招一起变大，而**仍然全部短于武将**（他的乘数 22 对 34），所以他不会变成
     * 场上范围最大的那个。真要干净应该把"兵器长度"和"技能范围"拆成两项，让短剑角色可以是
     * "剑短但招式大" —— 那是个动四个角色十五招的结构改动，先把人救回来。
     *
     * 另外两项是把他的身份**兑现**：
     *
     *   暴击 0.16 → 0.2   全场最高，而且技能命中还要再乘一次（CRIT_SKILL_MULTIPLIER），
     *                      所以他放招时实际是四成暴击 —— 画面上一直在跳大数字，那是这个
     *                      角色最好认的那件事。
     *   攻击成长 12 → 14   原来虽然是全场最快，但他的**底数比武将低**（105 对 120），十级时
     *                      才领先 6% —— "攻击力涨得最快"在前十级是读不出来的。14 之后十级
     *                      领先 17%、三十级领先 34%，这条线才真的存在。
     *
     * 代价一个没动：900 血 / 30 防仍然是全场最薄，有效血量只有武将的七成。他是玻璃炮 ——
     * 清得比谁都快，也死得比谁都快。
     */
    base: stats({ crit: 0.2, maxHp: 900, attack: 105, defense: 30, moveSpeed: 33, attackRange: 22, attackArc: 1.7, pickupRange: 76, maxMp: 110, mpRegen: 4.2 }),
    growth: {
      maxHp: 20,
      maxMp: 2.8,
      mpRegen: 0.049,
      attack: 14,
      defense: 0.9,
      moveSpeed: 0.18,
      attackRange: 0.05,
      attackSpeed: 0.016,
      pickupRange: 1,
    },
    attackSkill: 'wave',
  },
  {
    id: 'rider',
    nameKey: 'heroLancerName',
    taglineKey: 'heroLancerTagline',
    blurbKey: 'heroLancerBlurb',
    archetype: 'speed',
    appearance: 'lancer',
    // 速度型：移动速度长得最快，攻击范围 30 是原来挂在 lancer 预设上的那个数（坐在鞍上，
    // 手离地面本来就远）。
    // 蓝池最小、回得最快：他的打法是冲进去扎一下再冲出来，一局里按突进的次数比谁都多，
    // 吃的是**回复速度**而不是池子大小 —— 池子再大也只是多冲一次，回得快才跟得上这个节奏。
    base: stats({ crit: 0.12, maxHp: 1000, attack: 110, defense: 35, moveSpeed: 38, attackRange: 30, attackArc: 0.95, attackSpeed: 1.05, pickupRange: 72, maxMp: 90, mpRegen: 5.7 }),
    growth: {
      maxHp: 22,
      maxMp: 2,
      mpRegen: 0.038,
      attack: 8,
      defense: 1,
      // 三十级是 38 + 0.42 × 29 = 50.2，仍然低于他自己的冲刺（× 1.875 = 71）。速度型是
      // "跑得比别人快"，不是"不需要冲刺"。
      moveSpeed: 0.42,
      attackRange: 0.07,
      attackSpeed: 0.02,
      pickupRange: 1.2,
    },
    attackSkill: 'sweep',
  },
];

export function heroById(id: string): HeroDef {
  return Heroes.find((hero) => hero.id === id) ?? Heroes[0];
}

/** 成长类型在界面上显示成什么。 */
export const ARCHETYPE_LABEL: Record<HeroDef['archetype'], HudTextKey> = {
  offense: 'archetypeOffense',
  defense: 'archetypeDefense',
  speed: 'archetypeSpeed',
  balanced: 'archetypeBalanced',
};
