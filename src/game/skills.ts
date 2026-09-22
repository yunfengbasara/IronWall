/**
 * 攻击技能：同一套判定和特效，换几种形状。
 *
 * 割草类游戏的群体技能翻来覆去就是四种形状（查了 Dynasty Warriors 系列的招式表，
 * charge attack 那一栏几十个招式都落在这四类里）：
 *
 *   前方扇形   横着扫一刀，眼前一片倒。最基础的那一下。
 *   原地整圈   转一圈把贴身的人全掀开。人被围住时唯一有用的形状。
 *   飞出去的波 一道波沿着朝向跑出去，路过谁谁死。够得最远，但只有一条线。
 *   突进走廊   人自己冲出去，身体扫过的一路全死。位移和杀伤是同一件事。
 *
 * 这个文件描述的是**形状和节奏**：判定多远多宽、持续多久、冷却几秒。强度的大头不在这里 ——
 * 伤害由施放者的攻击力算（见 data/balance.ts 的 damageAfterDefense）。这里只有一个强度旋钮，
 * 就是 power："这一下比平砍重几档"，它同时决定伤害倍率和溅多少碎片。硬直仍然一个都没有。
 *
 * 被动技能是个例外：它没有形状，全部内容是一包属性加成，写在 data/passives.ts 上。这里只
 * 登记名字和类别。
 */

import type { HudTextKey } from '../ui/text/hudText.types';

export type SkillId =
  | 'sweep'
  | 'spin'
  | 'wave'
  | 'lunge'
  | 'aegis'
  | 'dharma'
  | 'heavenGuard'
  | 'heavenSplit'
  | 'skyArrow'
  | 'sprint'
  | 'ironBody'
  | 'bulwark'
  | 'mend'
  | 'berserk'
  | 'bloodthirst';

/**
 * 技能放进哪一种槽。类别只规定“能装备几个、由谁触发”，kind 继续规定具体怎么结算。
 * 新技能通常只要在 Skills 里选择一个 category，再实现自己的 kind；装备规则不需要跟着加分支。
 */
export type SkillCategory = 'attack' | 'projectile' | 'guard' | 'active';
export type SkillEquipMode = 'single' | 'multiple' | 'activeSlots';
export type SkillTrigger = 'attack' | 'automatic' | 'passive' | 'manual';

export interface SkillCategoryRule {
  nameKey: HudTextKey;
  equip: SkillEquipMode;
  trigger: SkillTrigger;
  maxSlots: number;
}

/** 所有类别的兼容规则集中在这里；后续增加类别时，菜单与装备器都会读同一张表。 */
export const SkillCategoryRules: Record<SkillCategory, SkillCategoryRule> = {
  attack: { nameKey: 'skillKindAttack', equip: 'single', trigger: 'attack', maxSlots: 1 },
  projectile: { nameKey: 'skillKindProjectile', equip: 'multiple', trigger: 'automatic', maxSlots: Number.POSITIVE_INFINITY },
  guard: { nameKey: 'skillKindGuard', equip: 'single', trigger: 'passive', maxSlots: 1 },
  active: { nameKey: 'skillKindActive', equip: 'activeSlots', trigger: 'manual', maxSlots: 4 },
};

/**
 * 判定怎么结算。这是三条不同的代码路径，不是三个参数。
 *
 *   instant  发招那一帧一次算清（和基础攻击同一条路，见 combat.ts 顶上那段）。
 *   wave     波跨帧向前推进，每帧结算它**这一帧扫过**的那圈人。
 *   lunge    人跨帧向前冲，每帧结算身体**这一帧碰到**的人。
 *   aura     一个罩子跟着人走，持续若干秒，每帧结算**碰到罩子**的人。
 *
 *   heavenGuard 几个**召出来的人**各自跨帧向前走，每人每帧按突进那条规则结算自己碰到的人
 *               （strikeAlongLunge）。它和 lunge 的分别是"走的不是玩家"：召出来的东西离开
 *               玩家之后自己往前推，所以它得有自己的一份状态、自己的模型、自己的收尾。
 */
export type SkillKind =
  | 'instant' | 'wave' | 'lunge' | 'aura' | 'dharma' | 'heavenGuard' | 'heavenSplit' | 'skyArrow'
  /** 按住才生效的状态技，松开就停。目前只有疾走。 */
  | 'sustained'
  /** 沿着时间回血，不碰任何人。目前只有回春。 */
  | 'mend'
  /** 一段有代价的增益：持续掉血、防御变弱、输出变高。目前只有狂暴。 */
  | 'berserk'
  | 'passive';

export interface SkillDef {
  id: SkillId;
  /** 菜单上显示的名字。 */
  nameKey: HudTextKey;
  /** 菜单上那行小字，说明它是什么形状。 */
  noteKey: HudTextKey;
  category: SkillCategory;
  kind: SkillKind;
  /**
   * 判定够多远，按施放者自己的 attackRange 的倍数。
   *
   * 用倍数而不是绝对值：范围本来就是兵种的属性（武将 34、杂兵 11），技能只说"比平时远
   * 多少"。这样换个兵种放同一个技能，远近关系仍然成立。
   *
   * **突进是唯一的例外**：它这一项是"冲刺速度是奔跑速度的几倍"。位移技的距离该跟着腿走，
   * 不该跟着武器长度走 —— 按 attackRange 折算的话，武将（34）冲得比骑士（16）远一倍多，
   * 而那两个数说的是两把武器有多长，和谁跑得快没有任何关系。
   */
  reach: number;
  /** 判定张角，弧度。null = 用兵种自己的 attackArc。 */
  arc: number | null;
  /** wave / lunge 持续多久，秒。instant 用不上。 */
  duration: number;
  /**
   * 这一招有多狠。1 = 平砍，2 = 技能档。**同时管两件事**：
   *
   *   画面 —— 打中时溅多少碎片（1 只飙血，2 血加甲片）。
   *   伤害 —— 每高一档乘一次 SKILL_DAMAGE_PER_POWER（2.2），见 rollDamage。
   *
   * 一个字段管两件事是有意的：看着更狠的那一下本来就该更疼，拆成两个字段迟早会调出"画面很炸
   * 但不疼"的招。所以它也是**分强弱唯一的旋钮** —— 一招在同伴里偏弱，就抬这个数，别去动
   * 施放者的攻击力（那是角色的属性，不是招式的）。
   *
   * 可以是小数：2.5 就是比技能档再贵半档（见回旋）。
   */
  power: number;
  /**
   * 这项技能再次可用前要等多久，秒。每个技能都有自己独立的运行时计时器。
   *
   * 自动攻击类会把它加在武器动作时长之后；自动发射和主动技则从发动时刻直接计时。
   * 位移大、覆盖广的招该等得久一点 —— 突进一下就跨过大半个屏幕，冷却太短等于一直在瞬移。
   */
  cooldown: number;
  /**
   * 发动一次要多少法力。
   *
   * 目前只有主动技（category 'active'）不为 0 —— 自动攻击和自动发射是一直在跑的底噪，给
   * 它们记账等于给"活着"记账。蓝不够时按键无效，HUD 上那一格和进冷却时一样置灰。
   */
  mpCost: number;
  /**
   * 按住时每秒扣多少法力。0 = 这一招按一下就是一下，没有"按住"这回事。
   *
   * 只有 kind 'sustained' 用得上。它是**这一版新加的**：疾走把"跑步"从一个免费的按键变成
   * 了一项要付账的能力，而付账的方式只能是持续的 —— 一次性扣费的跑步等于"点一下开始跑，
   * 然后永远免费"。
   */
  mpDrain: number;
  /**
   * 收招时在落点补一圈，半径按施放者 attackRange 的倍数。0 = 不补。
   *
   * 只有突进用。冲过去之后原地炸一圈，把冲刺走廊两侧漏掉的人一起带走 —— 冲锋本来就该以
   * "撞进人堆里停下"收尾，而不是穿过去就没事了。
   */
  finishRing: number;
}

export const Skills: SkillDef[] = [
  {
    id: 'sweep',
    nameKey: 'skillSweep',
    noteKey: 'skillSweepNote',
    category: 'attack',
    kind: 'instant',
    /*
     * 横扫要明显越过回旋（1.25），把外三内二的扇面充分展开；仍短于破空（4.0）。
     *
     * 1.8 太长了。双锤武将的攻击距离 34，乘完是 61 个单位，配上他 109° 的张角 ——
     * 出货视口的半宽才 155，于是"人物面前一切"真的就是一切。
     * 1.45 又短了一点：连满级（×1.16）都只有 1.68 倍，下苦功把一招练到顶也没换来更大的一片。
     * 1.6 是个分界：**满级正好回到以前那个 1.8（精确地说是 1.86），一级仍然比以前短一成。**
     * 配上张角从 109° 收到 80°，即使满级，扇面面积也比当初那个"扫到半屏"少二成。
     */
    reach: 1.6,
    arc: null,
    duration: 0,
    // 横扫虽然是自动攻击，但命中仍应有完整破坏反馈；与破空、回旋统一为技能级碎片量。
    power: 2,
    cooldown: 0,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'spin',
    nameKey: 'skillSpin',
    noteKey: 'skillSpinNote',
    category: 'attack',
    kind: 'instant',
    // 整圈换来的代价是够不远：同样一刀的力气摊到四面八方，只能覆盖贴身那一圈。
    //
    // 1.25 看着比"够不远"大，是因为它现在是**判定**半径，而画面上那圈会按 SKILL_HIT_MARGIN
    // 缩进去一点。修掉画面比判定大三成四那个 bug 之前，玩家看到的圈本来就是这么大。
    reach: 1.25,
    arc: Math.PI * 2,
    duration: 0,
    /*
     * 2.5，比别的招高半档。power 同时是伤害倍率（2.2^(power-1)，见 rollDamage），所以这是
     * ×1.48 —— 回旋每一下比横扫疼五成。
     *
     * 抬它是因为骑士**在两头都落后**：他的攻击力 95 是近战里最低的、出手 0.92 是最慢的，
     * 而回旋的圈只有 attackRange 16 × 1.25 = 20 个单位，武将那把扇面是 54。面积算下来武将
     * 还多六成，伤害还更高 —— 一个"清开贴身的人"的招，清不开。
     *
     * 一级打到杂兵（320 血、2 防）：原来 246，两下；现在 365，一下。持盾兵（850 血、16 防）
     * 从四下变三下。每一下更疼，但要疼到人得先让他们贴到脸上来 —— 那正是这个角色的形状。
     *
     * 顺带溅得更碎（power 也管碎片量）。这个耦合是有意的，见 SKILL_DAMAGE_PER_POWER：
     * 看着更狠的那一下本来就该更疼。
     */
    power: 2.5,
    cooldown: 0.25,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'wave',
    nameKey: 'skillWave',
    noteKey: 'skillWaveNote',
    category: 'attack',
    kind: 'wave',
    /*
     * 够得最远，但只有一条窄带。远近和宽窄是这一套技能里唯一真正的取舍。
     *
     * **4.5 时这个"最远"赢得太多了。** 披风剑士的攻击距离是 16，乘完是 72 个单位 ——
     * 出货视口的半宽才 155，也就是一招捧到半屏外的 47%，而同一级的横扫只有 40%。
     * 剑士手里是全场最短的兵器，放出来却是全场最长的一招，这个倍率在替他掩饰兵器长度。
     *
     * 3.3 看着不大，问题出在**满级**：×1.16 之后是 3.83 倍，一发捧到半屏外的四成三，
     * 而它还是一条**跑起来**的走廊、每秒能放两发 —— 读起来就是打满了半个屏幕。
     * 2.9 下来满级是 3.36 倍，仍然太远。2.4 下来满级是 2.78 倍，半屏的三成出头 ——
     * 一发捧不到屏幕边上了，要往前跑才推得进去。
     *
     * 这一次横扫往上、破空往下，于是横扫在两个等级上都比它长了 —— "够得最远"这块牌子
     * 交出去了，剑士剩下的身份是**窄而且会跑**：一条 52° 的走廊横穿人堆，而横扫只能扫到身前。
     */
    reach: 2.4,
    arc: 0.9,
    duration: 0.55,
    power: 2,
    cooldown: 0.45,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'lunge',
    nameKey: 'skillLunge',
    noteKey: 'skillLungeNote',
    category: 'active',
    kind: 'lunge',
    /*
     * lunge 的 reach 不是判定距离，而是**冲刺速度是奔跑的几倍**：判定跟着身体走，宽度就是
     * 人的宽度。
     *
     * 8.2 配 0.22 秒，算出来基准角色每秒 492、一下冲 108 个单位 —— 和这一招最早那一版
     * （攻击范围 34 × 3.2 ÷ 0.22）分毫不差。中间试过慢到三倍速、并且能按住一直冲的那一版，
     * 不好玩：这一招的爽点是"眼前一花人已经在那边了"，摊长了就什么都不是，而"按住"把一次
     * 果断的出手变成了一个要一直盯着蓝条的操作。现在回到按一下就是一下、然后进冷却。
     *
     * 换成按奔跑速度折算这一条留着，它改的不是快慢而是**四个角色之间的一致性**：老公式按
     * attackRange 折算，武将 34、骑士 16，同一招在两个人身上差出两倍多，而那两个数说的是
     * 武器有多长，和谁跑得快没关系。
     *
     * **以后技能升级动的就是这两个数**：reach 往上（冲得更远）、mpCost 往下（放得更勤）。
     * 冷却和 duration 不该跟着升 —— 那两个改的是节奏，而一招的节奏应该是它的身份。
     */
    reach: 8.2,
    arc: null,
    duration: 0.22,
    power: 2,
    // 一下跨过大半个屏幕，不该和平砍同一个频率 —— 那等于玩家一直在瞬移。
    cooldown: 1.5,
    /*
     * 放一次的开销。
     *
     * 25 点占基准角色蓝池的四分之一：放完还剩 75 点，金钟罩（26）和天地法相（32）都还放得
     * 起，所以"冲进去再开罩子"是一个放得出来的连招，而不是一按突进就什么都不剩。蓝不够时
     * 那一格和进冷却时一样置灰。
     *
     * 它和 1.5 秒的冷却是两条独立的闸：冷却管这一招自己多久能再放，蓝管它和另外几个主动技
     * 加起来能放多少。只有冷却的话，最优解永远是三个键轮着按。
     */
    mpCost: 25,
    mpDrain: 0,
    // 冲到头再炸一圈。
    finishRing: 0.95,
  },
  {
    /*
     * 回春。四个主动技里唯一一个不打人的。
     *
     * 为什么是**持续回**而不是当场回满：当场回满的版本把它变成了一张"死之前按一下"的免死金牌 ——
     * 玩家的最优打法会变成残血往人堆里钻，而那恰好把走位这件事抵消了。摊开十秒之后它是一个
     * **提前**的决定：得在还撑得住的时候按下去，按晚了就来不及了。
     *
     * reach 给 0：它不碰任何人，也就没有"作用距离"。升级改的是回多少（伤害倍率那一条顺手
     * 当回血量用，见 battle.ts 的 castSkill）和冷却。
     */
    id: 'mend',
    nameKey: 'skillMend',
    noteKey: 'skillMendNote',
    category: 'active',
    kind: 'mend',
    reach: 0,
    arc: null,
    duration: 10,
    power: 0,
    cooldown: 14,
    mpCost: 30,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    /*
     * 狂暴。唯一一个**有代价**的主动技。
     *
     * 别的招都只问"蓝够不够、冷却好没好"，按下去只有好处。狂暴问的是另一件事：
     * **你现在撑得住吗。** 同样一个键，开局按下去是找死，手里有饮血或者一身血的时候按下去
     * 是白赚 —— 一张牌的价值跟着整局的构筑走，而不是一个固定的数。
     *
     * 四件事一起发生，缺一件它就不成立：攻击高了、出手快了、防御低了、血一直在掉。只有前
     * 三件的话它只是"换一种数字"，加上第四件它才有一个能读出来的截止时间。
     *
     * 出手频率那一项是这四件里唯一**在画面上**的：狂暴期间人挥得肉眼可见地快，所以这八秒
     * 不用看数字也认得出来（见 balance.ts 的 BERSERK_ATTACK_SPEED）。
     *
     * reach 给 0：和回春一样，它不碰任何人。
     */
    id: 'berserk',
    nameKey: 'skillBerserk',
    noteKey: 'skillBerserkNote',
    category: 'active',
    kind: 'berserk',
    reach: 0,
    arc: null,
    duration: 8,
    power: 0,
    cooldown: 18,
    mpCost: 28,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    /*
     * 神兵天降。四个主动技里唯一一个**放出去之后不跟着玩家**的。
     *
     * 别的招都长在玩家身上：扇面从他手上甩出去、罩子扣在他头上、突进冲的是他自己。这一招按
     * 下去之后，一排金身重甲兵落在他身前、朝他当时面朝的方向自己推过去 —— 他可以站着看，
     * 也可以跟在后面捡人头。场上第一次出现"我放的东西在替我打架"。
     *
     * 借的是重甲兵那个形象（characters/unitDef 的 UnitPresets.bulwark）：全场唯一不挥武器的
     * 兵，一杆矛端在身前一动不动。一排这样的东西平推过去就是**一排平行的矛尖在平移**，那正是
     * "犁"的样子 —— 换成会挥刀的兵，画面读到的是一群人在打架，不是一堵墙在推。
     *
     * 三件事随等级长，都是**看得见**的：
     *   几个人 —— 等级就是人数，一级一个、满级五个（见 castSkill）。这是主线，因为多一个人
     *             在画面上是当场读得出来的，而"疼一点"只是数字变了。
     *   推多远 —— reach 走通用的 +10%/级，一级约 88 个单位、满级约 124。
     *   多疼   —— damageScale，和所有招一样。
     *
     * reach 2.6：满级 124 个单位，出货视口的半宽是 155，所以**即使满级也推不出画面**（还要
     * 再被 cappedReach 夹一道）。这一条对这一招格外要紧 —— 它的全部内容是看着那排人把眼前的
     * 人海推平，推出画面等于把最值钱的那一段演在玩家看不见的地方。
     */
    id: 'heavenGuard',
    nameKey: 'skillHeavenGuard',
    noteKey: 'skillHeavenGuardNote',
    category: 'active',
    kind: 'heavenGuard',
    reach: 2.6,
    arc: null,
    /*
     * 从天上落到地上那一段，秒。**不是这一招持续多久** —— 推多久由"推多远 ÷ 走多快"自己
     * 决定（见 advanceHeavenGuards），满级那一趟约四秒。
     *
     * 0.34 是一个看得清但不拖沓的下落：短于它，人像是直接出现在地上，那一下砸就没了；长于
     * 它，玩家按完键要干等，而这一招前摇已经够长了。
     */
    duration: 0.34,
    power: 2,
    /*
     * 12 秒，全场最长。
     *
     * 它推平的那一片是所有招里最大的（满级五个人 × 124 个单位，约 52×124 的一整块），而且
     * 推的过程中玩家完全空着手 —— 可以一边跑一边砍。冷却短了，最优解就变成"挂着这一排走路"。
     */
    cooldown: 12,
    /*
     * 32 点，一次扣清，没有 mpDrain。
     *
     * 这一招放出去之后就不归玩家管了，没有"按住"这回事 —— 持续扣费要有一个玩家能随时喊停的
     * 开关（法相和疾走都有），而这一排是收不回来的。按下去的那一刻价钱就定死，剩下的四秒里
     * 蓝在照常回，玩家跟在队列后面时手里正好攒出下一招。
     */
    mpCost: 32,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'aegis',
    nameKey: 'skillAegis',
    noteKey: 'skillAegisNote',
    category: 'active',
    kind: 'aura',
    // 贴身一圈。它换来的不是范围是**时间**：别的招是一瞬间的事，这个能顶几秒。
    reach: 0.95,
    arc: null,
    // 主动开启 2 秒，冷却从按键发动时开始独立计算。
    duration: 2,
    power: 2,
    cooldown: 3.3,
    // 顶两秒无敌一样的罩子，是这套技能里最值钱的一个，所以也最贵。
    mpCost: 26,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'dharma',
    nameKey: 'skillDharma',
    noteKey: 'skillDharmaNote',
    category: 'active',
    kind: 'dharma',
    reach: 1.2,
    arc: null,
    /*
     * **按住多久就开多久**，duration 只是松手之后收得多快。
     *
     * 原来是按一下开 2.8 秒、中途停不下来。那样它和金钟罩就成了同一件东西（两个都是"按一下
     * 罩几秒"），而且最难受的是收不回来：法相一展开就锁死那几秒，玩家明知道该走位也只能站着
     * 等它结束。改成按住之后，它变成一个**要一直付钱的姿态** —— 开多久、什么时候收，是玩家
     * 每一刻都在做的决定。
     *
     * 0.35 是松手之后那一小段收势，不是可控时长：法相是个实打实的大壳子，一帧之内凭空消失
     * 读作画面卡了一下。这一小段里判定照常有效，所以松手的瞬间不会漏掉已经贴上来的人。
     */
    duration: 0.35,
    power: 2,
    /*
     * 冷却 5 秒，但**只在蓝被榨干的时候才开始走**（见 Battle 的 dharma 收尾）。
     *
     * 这一条和常规的冷却不是一回事：主动松手不进冷却，蓝还有就随时能再开 —— 那一半仍然是
     * "有蓝就能放"。真正被罚的是把蓝用到空：那时候不光没蓝，还要再等五秒，于是"开到最后一滴"
     * 是一个有代价的选择，而不是永远的最优解。
     *
     * 不这么做的话，蓝空之后的行为是"回一点蓝就能再开半秒"，招式在开和停之间碎成一地 ——
     * 那是这一招最难看的状态。
     */
    cooldown: 5,
    /*
     * 起手 10 点，按住之后每秒 48。
     *
     * 没有冷却之后，**蓝是唯一的闸**，所以这个数比别的按住型技能都陡：基准角色满蓝只撑得住
     * 两秒，撑完蓝见底、突进和金钟罩都按不动，而回满要十一秒。于是它读作一个"开一下就得
     * 缓一会儿"的大招，而不是一个可以一直挂着的姿态。
     *
     * 起手价压到 10：按一下就松手是合法用法，而且既然没有冷却，起手价高就等于变相收了两次。
     *
     * 48 远高于任何角色的回蓝（最快的满级每秒 17.9），所以按住期间蓝一定是净掉的 —— 这一条
     * 是"开到蓝空自己停"能成立的前提。
     */
    mpCost: 10,
    mpDrain: 48,
    finishRing: 0,
  },
  {
    id: 'heavenSplit',
    nameKey: 'skillHeavenSplit',
    noteKey: 'skillHeavenSplitNote',
    category: 'projectile',
    kind: 'heavenSplit',
    reach: 3.8,
    arc: null,
    duration: 0.5,
    power: 2,
    cooldown: 1.7,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'skyArrow',
    nameKey: 'skillSkyArrow',
    noteKey: 'skillSkyArrowNote',
    category: 'projectile',
    kind: 'skyArrow',
    reach: 1.5,
    arc: null,
    duration: 0,
    power: 2,
    cooldown: 1.9,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    /*
     * 疾走：按住 R（或 Shift）就跑，松开就走，跑的时候一直扣蓝。
     *
     * 跑步最早是按住 Shift，不花任何代价，于是它根本不是一个决定 —— 没有人会在能跑的时候
     * 选择走。做成技能之后它和别的主动技抢同一份蓝：跑一段路，就少一次金钟罩。
     *
     * 键位后来搬回了 Shift（W 归了走路），**但代价留着**：它照样从这一份蓝里扣。这两件事
     * 本来就是分开的 —— 按哪个键是手的事，花不花蓝才是那个决定。
     *
     * **不占主动槽**，四个角色都一样，卸不掉（见 SPRINT_SKILL）。它是走位本身，不是一个
     * 配招选择；而且它必须永远在同一个键上 —— 跑步的键位跟着配招变，手就没法记。
     *
     * 它没有判定，所以 reach / arc / power / finishRing 全是 0：跑多快是全局的
     * RUN_MULTIPLIER（data/balance.ts），因为那个倍数同时还被突进的速度公式用着，写两份迟早
     * 会差出来。
     *
     * 每秒 30 点这个数是**按回蓝速度倒推**的，不是凭手感定的：回蓝最快的角色（骠骑将军，
     * 满级每秒 17.9）必须明显慢于它，否则按住跑步键就是净值为零甚至为正的免费移动 —— 一路跑
     * 下去，跑步又变回不用做的决定了。
     *
     * 差出去的那一截决定了满蓝能跑多久：一级各角色五到六秒、三百到四百五十个世界单位，
     * 大概是场地的四分之一。够你追上一队人或者脱开一次包围，不够你一路跑过去；跑完蓝见底，
     * 突进和罩子都得等回蓝。
     */
    id: 'sprint',
    nameKey: 'skillSprint',
    noteKey: 'skillSprintNote',
    category: 'active',
    kind: 'sustained',
    reach: 0,
    arc: null,
    duration: 0,
    power: 0,
    /*
     * 冷却 5 秒，和法相同一条规则：**只有把蓝跑空才进冷却**。
     *
     * 主动松手不进冷却，蓝还有就随时能再跑。被罚的是跑到脱力 —— 那之后要走五秒才能再跑起来，
     * 而在一个被人海追着的游戏里，那五秒是真的疼。
     */
    cooldown: 5,
    mpCost: 0,
    mpDrain: 30,
    finishRing: 0,
  },
  // ------------------------------------------------------------ 被动
  //
  // 四个被动，每个角色默认自带一个，卸不掉。它们在**画面上**什么也不做（只有铁布衫有那层
  // 呼吸提亮，见 scene.ts），真正的内容是一包属性加成，写在 data/passives.ts 上 —— 这里
  // 只登记"有这么一个技能、叫什么、归哪一类"。
  //
  // 加成随玩家等级一起长，所以一个被动在一级和三十级不是同一个东西。见 PassiveDef。
  {
    id: 'ironBody',
    nameKey: 'skillIronBody',
    noteKey: 'skillIronBodyNote',
    category: 'guard',
    kind: 'passive',
    reach: 0,
    arc: null,
    duration: 0,
    power: 0,
    cooldown: 0,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    id: 'bulwark',
    nameKey: 'skillBulwark',
    noteKey: 'skillBulwarkNote',
    category: 'guard',
    kind: 'passive',
    reach: 0,
    arc: null,
    duration: 0,
    power: 0,
    cooldown: 0,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
  {
    /*
     * 饮血。三张护身技里唯一一张**不是属性包**的。
     *
     * 原来有四张，而锋锐和疾锋只是铁布衫换了几个数字 —— 同一个形状摆三遍，玩家抽到哪一张
     * 都是"一包看不见的加成"，区别只在说明文字里。换成饮血之后三张各是一种活法：
     * 铁布衫硬、磐石硬且带输出（绕身的磐石）、饮血不硬但打得越狠回得越多。
     *
     * 它没有属性包（不在 passives.ts 里），效果写在结算那一步：每造成一点伤害回一点血。
     * 所以它在人堆里最值钱，而那正是玩家最容易死的地方。
     */
    id: 'bloodthirst',
    nameKey: 'skillBloodthirst',
    noteKey: 'skillBloodthirstNote',
    category: 'guard',
    kind: 'passive',
    reach: 0,
    arc: null,
    duration: 0,
    power: 0,
    cooldown: 0,
    mpCost: 0,
    mpDrain: 0,
    finishRing: 0,
  },
];

/**
 * 判定半径比画出来的那一圈大多少。
 *
 * 方向是**判定 > 画面**，不能反过来。反过来的后果刚被撞到过：回旋原来的特效同时吃了
 * power(1.34) 和 to(reach)，而推进曲线会把两者相乘 —— 画出来的圈比会杀人的圈大三成四，
 * 于是"环明明扫过去了，圈里还站着人"。
 *
 * 略宽一点是这个工程一贯的取向（见 combat.ts 顶上那段）："擦过去却没死"比"隔着一点空气
 * 死了"难受得多。
 */
export const SKILL_HIT_MARGIN = 1.15;

/**
 * 破空在近处的走廊半宽，世界单位。
 *
 * 敌人之间大约隔 11 个单位，所以 16 是"身前三排都清掉"。见 combat.ts 的 sweptBy。
 */
export const WAVE_NEAR_HALF_WIDTH = 16;


export const skillById = (id: SkillId): SkillDef => {
  const skill = Skills.find((entry) => entry.id === id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  return skill;
};

export const skillsInCategory = (category: SkillCategory): SkillDef[] =>
  Skills.filter((skill) => skill.category === category);

/** 一个轴对齐的框，世界坐标。就是 BattleView.spawn 那个出货视口。 */
export interface ViewBox {
  x: number;
  y: number;
  halfW: number;
  halfH: number;
}

/**
 * 从 (x, y) 朝 heading 走多远才会走出这个框。
 *
 * 标准的射线—轴对齐框求交，只算正方向那一侧。起点在框外时返回 0（贴着地图边缘时会发生：
 * 出货视口被夹在场地内，人可以站在框的边上）。
 */
export function exitDistance(x: number, y: number, heading: number, box: ViewBox): number {
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);

  let t = Infinity;
  if (Math.abs(dx) > 1e-6) {
    const edge = dx > 0 ? box.x + box.halfW : box.x - box.halfW;
    t = Math.min(t, (edge - x) / dx);
  }
  if (Math.abs(dy) > 1e-6) {
    const edge = dy > 0 ? box.y + box.halfH : box.y - box.halfH;
    t = Math.min(t, (edge - y) / dy);
  }
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/**
 * 发射类技能能打多远：名义射程，但**不许打出画面**。
 *
 * 为什么要这条规则：波的射程是按施放者的 attackRange 折算的，武将那一档能到一百六十多个
 * 世界单位，比半个视口还长。打出画面之后玩家看不到自己杀了谁，屏幕外一片人无声消失 ——
 * 那不是爽快，是茫然。而且波会一路飞过整张地图，把还没进过画面的人也清掉，跑步机那套
 * "背后回收、前方多刷"就白做了。
 *
 * 用**出货视口**而不是当前视野：滚轮缩放是调试旋钮，上线后视口固定，技能能打多远不该跟着
 * 调试视角变（和出怪用同一个框、同一个理由，见 BattleView 那段）。
 *
 * 按整个扇面取最小值，不只看正前方：一道斜着放的波，正前方还在画面里，扇面的边角早就出去了。
 *
 * 兜底是施放者自己的 attackRange —— 贴着地图边缘朝外放时，框只剩一点点，再往下夹会让这一招
 * 还不如平砍。打不出画面的前提下，至少得够得着眼前的人。
 */
export function cappedReach(
  x: number,
  y: number,
  heading: number,
  arc: number,
  reach: number,
  floor: number,
  box: ViewBox,
): number {
  const SAMPLES = 5;
  let limit = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const a = heading - arc * 0.5 + (arc * i) / SAMPLES;
    limit = Math.min(limit, exitDistance(x, y, a, box));
  }
  return Math.max(Math.min(reach, limit), Math.min(reach, floor));
}
