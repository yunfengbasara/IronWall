import { CharacterAnimator, attackDuration, attackImpact } from '../characters/animator';
import type { UnitStats } from '../data/types';
import { HorseAnimator, HorsePose, HorseSpec } from '../characters/horse';
import type { CharacterPalette } from '../characters/palette';
import { Pose, RigSpec } from '../characters/rig';
import type { UnitDef } from '../characters/unitDef';
import { clamp, type Vec3 } from '../core/math';

/**
 * 没有给属性时用的那一份，就是 data/units.ts 里杂兵的值。
 *
 * 存在的理由只有一个：tools/ 下的离线脚本经常只想看一段动画，为此先去结算一份属性是白绕。
 * 战斗里每一个人的属性都是 Battle 明确赋上去的，不会落到这一份上。
 */
const DEFAULT_STATS: UnitStats = {
  maxHp: 40,
  maxMp: 0,
  mpRegen: 0,
  crit: 0.09,
  attack: 12,
  defense: 4,
  moveSpeed: 26,
  attackRange: 11,
  attackArc: 1.6,
  attackSpeed: 1,
  pickupRange: 0,
};

/**
 * 场上一个活的单位：位置、朝向，加上它自己那一份姿势和动画状态。
 *
 * 姿势和动画器必须每人一份 —— 步态相位、呼吸、倒地进度都是各自独立的状态。而 UnitDef
 * 和调色板是共享的只读数据，一百个杂兵指向同一个 def 就够了。
 */

/** 倒地动作的长度，秒。 */
const COLLAPSE_TIME = 0.42;
/** 尸体躺在地上多久之后开始沉下去。 */
const CORPSE_HOLD = 1.8;
/** 沉入地面的时长。用压扁高度代替淡出 —— 渲染器没有整体透明度，而沉下去也更像回事。 */
const SINK_TIME = 0.5;

/**
 * 击飞。人死了不是原地软倒，是被打飞出去、翻一圈、砸在地上。
 *
 * 为什么选这个而不是原地倒地：这个尺寸下一个人只有二十来个像素高，几百人挤在一起时，
 * 一次原地的姿势变化几乎读不出来 —— 眼睛能在人堆里捕捉到的只有**位移**。击飞还顺带把
 * 技能的形状变成了看得见的事件：回旋放出去是一圈人向外飞，破空是一条走廊的人被推着走，
 * 不用看特效就知道自己刚打出了什么形状。
 *
 * 三个数一起定了一次击飞的样子：
 *   LAUNCH_OUT   水平速度。乘上滞空时间就是飞多远。
 *   LAUNCH_UP    起跳速度，决定飞多高、也决定滞空多久。
 *   GRAVITY      往下拽的加速度。这三个数只服务观感，和物理正确无关 —— 真实重力
 *                （按一个人 19 单位高折算）会让人像块砖一样砸下去，滞空短到看不清翻滚。
 *
 * **每个人各掷一次，不是所有人一个样。** 一排人被同一道波扫中，如果飞的高度和距离完全一致，
 * 看着像一块整体翻过去的板子；各飞各的高度才有炸开的感觉。
 *
 * 当前档位（**这是满级的数**，一级只有 0.55 倍，见 balance.ts 的 LAUNCH_LEVEL_FLOOR）：
 * 最高点 **11.6～22 个世界单位**（人高 19，所以最矮的一下也弹过半个身位，最高的
 * 那下整个人离地一人多高），滞空 0.61～0.84 秒，飞出 38～79 单位 —— 敌人间距约 11，也就是
 * 掀翻三到七排。一级是 17～35 单位，一到三排。
 *
 * force 只线性放大水平速度，竖直速度按 force^0.35 放。竖直全额放大的话滞空跟着线性变长
 * （T = 2·UP/G），力度翻倍就在天上飘两倍久，读作被气流托着而不是被撞飞。指数压到 0.35 之后，
 * 2.2 倍的力只把竖直放大 1.3 倍：最高点从 11~22 涨到 18~35 个单位（人高 19，也就是一到两个
 * 身位），够读出"被撞上天"，又不至于像被防空炮打飞。
 *
 * 抬高度时必须**同时抬重力**。只抬起跳速度的话滞空跟着变长（T = 2·UP/G），人在空中飘的
 * 时间和飞出去的距离一起涨，读起来是"被吹走了"而不是"被炸起来了"。把 G 从 150 提到 250
 * 之后，抛物线又高又急：起得猛、落得快，那才是爆炸。
 */
const LAUNCH_OUT_MIN = 62;
const LAUNCH_OUT_MAX = 94;
const LAUNCH_UP_MIN = 76;
const LAUNCH_UP_MAX = 105;
const GRAVITY = 250;

/**
 * 滞空期间翻多少圈。
 *
 * 整数是关键：翻滚角按滞空进度线性推到 turns × 2π，落地那一刻正好是整圈的倍数，
 * 身体自然是平的。用"每秒转多少度"那种自由旋转的话，落地时身体停在一个随机角度上，
 * 得再补一段"转正"的过渡，而那段过渡在二十像素下看着就是尸体自己抽了一下。
 */
/**
 * 受击定格：中刀的那一下，**只有挨打的这个人**定住多久。
 *
 * 顿帧本来是把整个世界停住，那在别的类型里是标准做法，在割草里不行 —— 玩家每秒钟都在挥，
 * 世界每秒钟都要停几次，读起来就是掉帧。而顿帧真正想给的是"这一刀有重量"，那个重量只需要
 * 挨打的人来表达：他在中刀的姿势上定住几帧再被掀飞，玩家一帧都不停。
 *
 * 定格期间**什么都不推进** —— 姿势、弹道、倒地计时全停。所以他保持的是"活着的最后一帧"
 * 那个姿势（走到一半、或者正挥到一半），不是倒地动画的第一帧。这一点很重要：倒地动画的
 * 第一帧是个站直的待机姿势，定在那儿等于中刀先立正再飞出去。
 *
 * 70 毫秒，四帧上下。它不占玩家的时间，所以可以比世界顿帧给得大方一点。
 */
const HIT_FREEZE = 0.07;

const TUMBLE_TURNS_MIN = 1;
const TUMBLE_TURNS_MAX = 2;

/**
 * 步态最多按步行速度的几倍来演。超过就夹住 —— 见 advance 里那段。
 *
 * 3.2 是按"跑步之下不受影响、突进被夹住"挑的：跑步是 1.875 倍，而突进接近步行速度的十五倍。
 */
const MAX_GAIT_PACE = 3.2;

/** 轨迹线：留几个点、隔多久取一个。8 × 0.045 秒盖住约 0.36 秒，够画出弧线的形状。 */
const TRAIL_POINTS = 8;
const TRAIL_STEP = 0.045;

export class Character {
  readonly pose = new Pose();
  private readonly animator = new CharacterAnimator();

  /**
   * 坐骑的姿势和步态。步兵是 null。
   *
   * 按需建、并且只建一次：换 def 时（setPreset、备战界面换角色）如果新的 def 是骑兵就补上，
   * 换回步兵**不销毁** —— 一个 HorsePose 就是二十来个 Vec3，留着比来回 new 便宜，而且换回
   * 骑兵时步态相位还接得上。真正决定画不画马的是 def.mounted，不是这两个字段在不在。
   */
  private horsePose: HorsePose | null = null;
  private horseAnimator: HorseAnimator | null = null;

  /** 这一帧马的姿势；不骑马时是 null。渲染那边按它决定要不要先画一匹马。 */
  get mount(): HorsePose | null {
    return this.ensureMount();
  }

  /** def 换成骑兵时把坐骑补出来。不是骑兵就返回 null，什么都不建。 */
  private ensureMount(): HorsePose | null {
    if (!this.def.mounted) return null;
    if (!this.horsePose) {
      this.horsePose = new HorsePose();
      this.horseAnimator = new HorseAnimator();
    }
    return this.horsePose;
  }

  x = 0;
  y = 0;
  /** 地面平面上的朝向角，和 Projector 用同一套。 */
  facing = 0;
  /**
   * 往哪儿走。null = 和 facing 是同一个数。
   *
   * 除了玩家，场上每个人朝哪儿就往哪儿走，所以这一格一直是 null。玩家用方向键之后这两件事
   * 分开了：facing 归准星（判定和模型都读它），走归这里。谁问的是"他往哪边挪"（脚下溅起的
   * 水往哪边飞、以后下半身的步态朝哪边迈）就读 moveDir。
   */
  moveAngle: number | null = null;
  /** 往哪儿走。没单独指定就是朝向本身。 */
  get moveDir(): number {
    return this.moveAngle ?? this.facing;
  }
  /** 当前移动速度，世界单位/秒。动画靠它决定走还是站。 */
  speed = 0;

  /** 攻击动作已经走过的秒数；负数表示没在攻击。 */
  attack = -1;
  /** 倒地已经走过的秒数；负数表示还活着。 */
  death = -1;
  /** 刚挨打的白光，0..1。 */
  hurt = 0;

  /**
   * 上一次被环绕流星（磐石）撞到是什么时候，单位是这一局的秒数。负数 = 还没被撞过。
   *
   * 流星贴着人转，一秒能从同一个人身上扫过好几次。没有这一条的话，站在轨道上的人会在一帧
   * 之内被同一颗流星连撞若干次，读作"碰一下就蒸发" —— 而这一招的定位是持续的、绕着身边
   * 收割，不是一个贴身秒杀。记在人身上而不是记在流星身上：五颗流星共用同一份免疫窗口，
   * 否则五颗一起扫过去仍然是五倍伤害。
   */
  orbHitAt = -Infinity;

  /**
   * 金钟罩和天地法相上一次打到他是什么时候。和 orbHitAt 同一个道理，只是各记各的。
   *
   * 两个壳子可以同时开着，共用一个钟的话叠在一起的伤害会凭空少一半 —— 那不是平衡，是算错。
   */
  domeHitAt = -Infinity;
  aspectHitAt = -Infinity;

  /**
   * 上一次被"犁"过是什么时候。目前只有神兵天降那一排金身重甲兵会写它。
   *
   * 和 orbHitAt 同一个道理，但更要紧：那一排要推三四秒，没有窗口的话，一个没被一下打死的人
   * 会贴在盾前面每帧挨一下 —— 伤害于是跟着帧率走。窗口长度见 HEAVEN_GUARD_HIT_GAP。
   *
   * 记在**人**身上而不是记在每个重甲兵身上：一排五个人扫过来，共用同一份免疫窗口，否则
   * 队列一密就成了五倍伤害。
   */
  plowHitAt = -Infinity;

  /** 击飞的速度，世界单位/秒。落地清零。 */
  private velX = 0;
  private velY = 0;
  private velZ = 0;
  /** 离地高度，世界单位。0 = 已经落地。 */
  private airZ = 0;
  /** 在空中待了多久。躺够了要沉下去，那个计时得把滞空这段减掉，否则人还在天上就开始陷进地里。 */
  private airTime = 0;
  /** 这一次预计滞空多久。翻滚角按它归一化，才能落地正好是整圈。 */
  private flightSpan = 0;
  /** 这一次翻几圈。整数，落地才是平的。 */
  private turns = 1;
  /** 受击定格还剩多久。见 HIT_FREEZE。 */
  private hitFreeze = 0;

  /**
   * 击飞轨迹上最近的几个点，(x, y, z) 依次存放的环形缓冲。
   *
   * 定长的 Float32Array 而不是数组推入：场上随时有几百具尸体，每帧 push/shift 出来的垃圾
   * 比轨迹本身贵得多。画它的是 Scene —— 轨迹要跨世界坐标画，而人物渲染只认身体局部空间。
   */
  readonly trail = new Float32Array(TRAIL_POINTS * 3);
  /** 离地多高，世界单位。0 = 在地上。渲染器按它缩影子。 */
  get lift(): number {
    return this.airZ;
  }

  /** 已经存了几个点，最多 TRAIL_POINTS。 */
  trailCount = 0;
  /** 下一个写到哪儿（点的下标，不是浮点下标）。 */
  trailHead = 0;
  private trailClock = 0;

  /**
   * 这个人有多强。血、攻、防、速度、范围、频率、拾取全在这一份里。
   *
   * 它是**结算好的**那一份，不是表里那一份：玩家的已经把等级成长、被动和本局加成都摊进去
   * 了，敌人的已经乘过波次曲线和地图加成。谁来算见 game/stats.ts，Character 只负责带着它。
   *
   * 默认给一份基准杂兵的值，这样 tools/ 下那些只想看动画的离线脚本不必先造一份属性。
   */
  stats: UnitStats = { ...DEFAULT_STATS };

  /**
   * 杀掉这个人给玩家多少经验。出生时按兵种和当时的波次算好，之后不再变。
   *
   * 存一个算好的数而不是回头去查兵种表：一个第一波出生的杂兵走出画面又走回来时，仍然该是
   * 第一波那个杂兵 —— 他只是走出过画面，不是重生。同理见 Reservation 上那段。
   */
  expValue = 0;

  /**
   * 他是不是首领。
   *
   * 存一个标志而不是拿血量去猜：末波的枪骑兵血过两千，和首领的起步值重叠 —— 按血量分的话，
   * 一整队枪骑兵会难不回收、脚下全是光圈、小地图上铺满骷髅头，连输赢都跟着算错。
   */
  boss = false;

  /**
   * 挺尸还剩多久，秒。只有首领用得上（见 battle.ts 的 BOSS_HIT_STUN）。
   *
   * 挺尸期间**只停脚，不停手**：他站在那儿挨刀但该挥还是挥。连手也停了的话，玩家贴上去一顿砍
   * 就把他锁死了，一个打不还手的首领没有任何压迫感可言。
   */
  stun = 0;

  maxHp = 1;
  hp = 1;
  /** 距离下一次可以出手还有多少秒。 */
  attackCooldown = 0;

  /**
   * 绕路时习惯往哪边让，+1 左 / -1 右。出生时掷一次，之后不变。
   *
   * 存在的理由是**别让方向每帧翻**：挡路的人正对着自己时，"往远离他的那边绕"没有答案 ——
   * 横向偏移在零附近抖，方向就一帧一个样，人在原地左右抽搐。给每个人一个固定的习惯，
   * 正面撞上时照着它走，看着也更像人：有人爱往左让，有人爱往右。
   */
  readonly sideBias: 1 | -1;

  /**
   * 人群里"想走多快"的平滑值，0..1。由 Battle 每帧推进。
   *
   * 存在的理由是**前面那个人也在动**。挡路者自己的微动会让"我还能直着走多远"一进一出地翻，
   * 而直行和绕行的速度差了近十倍 —— 于是后排会出现每两三帧一次的 0.06↔0.25 步态跳变，
   * 看着就是个别人在原地抽搐。这类抖动来自邻居的位置噪声，调阈值消不掉，只能给意图加一个
   * 时间常数：认准要走多快之后，用零点几秒滑过去。
   */
  crowdPace = 0;

  // 倒向哪边，身体局部地面坐标。
  private fallX = 0;
  private fallY = -1;

  def: UnitDef;
  palette: CharacterPalette;
  /** 这个单位的标准步行速度，用来把 speed 归一化成步态。 */
  walkSpeed: number;

  constructor(def: UnitDef, palette: CharacterPalette, walkSpeed = 16, sideBias: 1 | -1 = Math.random() < 0.5 ? -1 : 1) {
    this.def = def;
    this.palette = palette;
    this.walkSpeed = walkSpeed;
    this.sideBias = sideBias;
  }

  get alive(): boolean {
    return this.death < 0;
  }

  /** 步态循环位置，0..1。脚步特效靠它的跨越判断触地。 */
  get gaitPhase(): number {
    return this.animator.phase;
  }

  /** 已经该从场上清掉了。 */
  get gone(): boolean {
    return this.death - this.airTime >= COLLAPSE_TIME + CORPSE_HOLD + SINK_TIME;
  }

  /**
   * 命中和撞树用的半径。
   *
   * 用胯宽是对的：它判的是"够不够得着这个人"和"能不能从树旁边挤过去"，两件事都该按身体最
   * 窄处算，宽了会让人卡在明明过得去的缝里、也会让攻击白白变长。
   */
  get radius(): number {
    // 骑兵按马的躯干半宽算。拿骑手的胯宽当半径的话，两匹马能贴到肚子叠在一起。
    if (this.def.mounted) return HorseSpec.barrelHalfWidth * this.def.bulk;
    return RigSpec.hipHalfWidth * this.def.bulk * 1.15;
  }

  /**
   * 挤开旁人时的半径 —— 这个人在地上占掉多大一圈。
   *
   * 和 radius 分开是因为它们量的是两件事。radius 走的是胯宽（2.05），身上最窄的一处；拿它
   * 当人群间距的话，两个杂兵贴到 4.7 个单位就算"不重叠"了，而躯干光半宽就有 3.95、肩宽
   * 3.5，画出来是结结实实叠在一起的两个人 —— 人堆读不出数量，正是这个原因。
   *
   * 所以站位按躯干算。这不是把碰撞"调大一点"，是本来就该用另一个数。
   */
  get spacing(): number {
    // 骑兵在地上占的那一圈按马来。马是长条的（十三个单位长、五个多宽），而人群分离用的是
    // 一个圆 —— 取长宽之间偏宽的一档：按长度给会让骑兵之间空出一大片，按宽度给则前后叠住。
    if (this.def.mounted) return HorseSpec.barrelHalfWidth * 1.7 * this.def.bulk;
    return RigSpec.torsoHalfWidth * this.def.bulk;
  }

  /** 开始一次攻击。已经在挥了、还在冷却、或者已经死了都忽略。 */
  swing(cooldown = 0): boolean {
    if (this.attack >= 0 || !this.alive || this.attackCooldown > 0) return false;
    this.attack = 0;
    this.attackCooldown = cooldown;
    return true;
  }

  /**
   * 挨一下。掉血、闪白光；血空了就倒。
   * @returns 这一下是否致命。
   */
  takeHit(
    fromX: number,
    fromY: number,
    damage = 1,
    launch: { force?: number; freeze?: number } = {},
  ): boolean {
    if (!this.alive) return false;
    this.hp -= damage;
    // 没死也要闪一下白光。这是"这一下打在他身上了"唯一的反馈 —— 加了血量之后场上会第一次
    // 出现"挨了一下但还站着"的人，没有这层反馈，玩家会以为自己打空了。
    this.hurt = 1;
    if (this.hp <= 0) {
      this.kill(fromX, fromY, launch);
      return true;
    }
    return false;
  }

  /**
   * @param fromX/fromY 打击来自世界坐标的哪一点，决定往哪边倒。
   * @param options.force  击飞力度倍率。1 是站着挨一刀；被高速冲过来的人撞上该给得更大。
   * @param options.freeze 受击定格时长，秒。默认 HIT_FREEZE。
   *
   * 这两个参数是为**突进**开的。撞飞本身一直是有的，但在冲刺里读不出来：尸体初速 78 单位/秒，
   * 而冲刺中的玩家（也就是镜头）是 495 —— 相对屏幕，被撞的人是往后退的，不是被撞飞的。
   * 再加上定格那 70 毫秒占掉整段冲刺的三分之一，人在镜头飞走的时候钉在原地不动。
   *
   * 所以撞人要给更大的力、更短的定格。被车撞和被刀砍本来就不是一回事。
   */
  kill(fromX: number, fromY: number, options: { force?: number; freeze?: number } = {}): void {
    if (!this.alive) return;
    this.death = 0;
    this.attack = -1;
    this.speed = 0;
    this.hitFreeze = options.freeze ?? HIT_FREEZE;
    // 定格的这几帧盖一层白光。定住的姿势说明"这一下打在他身上"，白光说明"是他"——四十个人
    // 挤在一起时，只靠一个定住不动的人是挑不出来的。
    this.hurt = 1;

    // 背对打击方向倒下。转成身体局部坐标：y 是朝向，x 是右手边。
    let awayX = this.x - fromX;
    let awayY = this.y - fromY;
    const len = Math.hypot(awayX, awayY);
    if (len < 1e-4) {
      awayX = Math.cos(this.facing);
      awayY = Math.sin(this.facing);
    } else {
      awayX /= len;
      awayY /= len;
    }

    // 击飞速度存世界系（away 就是世界方向）；底下那组 fall 是身体局部系，给姿势用的。
    const force = options.force ?? 1;
    const out = (LAUNCH_OUT_MIN + Math.random() * (LAUNCH_OUT_MAX - LAUNCH_OUT_MIN)) * force;
    const up = (LAUNCH_UP_MIN + Math.random() * (LAUNCH_UP_MAX - LAUNCH_UP_MIN)) * Math.pow(force, 0.35);
    this.turns = TUMBLE_TURNS_MIN + Math.floor(Math.random() * (TUMBLE_TURNS_MAX - TUMBLE_TURNS_MIN + 1));
    this.velX = awayX * out;
    this.velY = awayY * out;
    this.velZ = up;
    // 立刻离地一点点，否则第一帧 airZ 还是 0，会被判成已经落地。
    this.airZ = 0.001;
    this.airTime = 0;
    this.flightSpan = (2 * up) / GRAVITY;
    this.trailCount = 0;
    this.trailHead = 0;
    this.trailClock = 0;

    const sin = Math.sin(this.facing);
    const cos = Math.cos(this.facing);
    // forward = (cos, sin)，right = (sin, -cos)，和 Projector.ground 是同一组基。
    this.fallY = awayX * cos + awayY * sin;
    this.fallX = awayX * sin - awayY * cos;
    const fl = Math.hypot(this.fallX, this.fallY);
    if (fl > 1e-4) {
      this.fallX /= fl;
      this.fallY /= fl;
    } else {
      this.fallX = 0;
      this.fallY = -1;
    }
  }

  /**
   * 整具身体绕胯翻一下、再整个抬离地面。
   *
   * 转轴取"垂直于倒地方向的那条水平轴" —— 绕着侧向轴翻跟头，不是原地打转。原地打转（绕 z）
   * 在俯视角下几乎看不出来，人只是转了个身；俯仰翻滚会让头和脚在屏幕上上下交换位置，这才是
   * "被打飞"读得出来的那个动作。
   *
   * 翻滚和抬升合成一趟：两件事都要遍历全部关节，分开走等于把最贵的那部分做两遍。
   *
   * **不分配任何东西。** 这条路每帧要为画面里的每一具尸体跑一次，几百具就是几百次；用
   * `for (const j of [...])` 或者 Set 去重都会每帧扔掉一堆临时对象，而这个工程为了避开
   * 分配连 Graphics 那条路都拆了。所以关节是一个一个点名的，别名那两个单独判。
   */
  private flingPose(angle: number, height: number): void {
    const p = this.pose;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hip = p.hip;
    const hx = hip.x;
    const hy = hip.y;
    const hz = hip.z;

    const move = (j: Vec3): void => {
      const dx = j.x - hx;
      const dy = j.y - hy;
      const dz = j.z - hz;
      // 拆成"沿倒地方向"和"垂直于它"两份，只转前者和 z。
      const along = dx * this.fallX + dy * this.fallY;
      const sideX = dx - along * this.fallX;
      const sideY = dy - along * this.fallY;
      const along2 = along * cos - dz * sin;
      j.x = hx + sideX + this.fallX * along2;
      j.y = hy + sideY + this.fallY * along2;
      j.z = hz + along * sin + dz * cos + height;
    };

    // 马跟着一起翻。不带上它的话，骑手在空中翻跟头而马平平地滑出去，读起来像两件不相干
    // 的东西被同一阵风吹走。多这十九个点只发生在**正在飞的骑兵尸体**上，场上不会有几个。
    const horse = this.horsePose;
    if (horse && this.def.mounted) {
      move(horse.chest);
      move(horse.croup);
      move(horse.withers);
      move(horse.poll);
      move(horse.muzzle);
      move(horse.saddle);
      for (const j of horse.hoof) move(j);
      for (const j of horse.knee) move(j);
      for (const j of horse.tail) move(j);
    }

    // 十一个规范关节两两互不相同，可以放心逐个走。
    move(p.chest);
    move(p.head);
    move(p.footL);
    move(p.footR);
    move(p.kneeL);
    move(p.kneeR);
    move(p.handL);
    move(p.handR);
    move(p.elbowL);
    move(p.elbowR);

    // 握点通常和某只手指向**同一个** Vec3 对象（这是从 C# 移植过来时的老坑，animator.ts 里
    // applyStature 上面那段写了原委）。转两次的话角度和高度都会翻倍，所以只处理不是别名的。
    if (p.weaponGrip !== p.handR && p.weaponGrip !== p.handL) move(p.weaponGrip);
    if (p.offhandGrip !== p.handR && p.offhandGrip !== p.handL && p.offhandGrip !== p.weaponGrip) {
      move(p.offhandGrip);
    }

    // 胯自己：转不动（它是转轴原点），但要跟着抬。放在最后，前面所有人都以它的原位为基准。
    hip.z += height;

    // 武器指向是方向不是位置，只转不平移、也不抬 —— 否则身体翻过去了，剑还平躺着。
    const turn = (d: Vec3): void => {
      const along = d.x * this.fallX + d.y * this.fallY;
      const sideX = d.x - along * this.fallX;
      const sideY = d.y - along * this.fallY;
      const along2 = along * cos - d.z * sin;
      d.x = sideX + this.fallX * along2;
      d.y = sideY + this.fallY * along2;
      d.z = along * sin + d.z * cos;
    };
    turn(p.weaponDir);
    if (p.offhandDir !== p.weaponDir) turn(p.offhandDir);
  }

  /**
   * 推进这一帧的动画。
   *
   * @param animate 画面外的单位传 false：计时（攻击、倒地、冷却）照常走，但跳过搭姿势
   *                和 IK —— 那是每个单位每帧最贵的一块，而且没人看得见。回到画面里时
   *                下一帧就重新算出正确的姿势，看不出接缝。
   * @returns 这一帧是否跨过了攻击的落点（也就是"这一下打出去了"）。
   */
  update(dt: number, animate = true): boolean {
    if (this.stun > 0) this.stun = Math.max(0, this.stun - dt);
    if (this.death >= 0) {
      // 受击定格：姿势、弹道、倒地计时一概不动，只有白光在褪。
      if (this.hitFreeze > 0) {
        this.hitFreeze -= dt;
        this.hurt = Math.max(0, this.hurt - dt * 5);
        return false;
      }
      // 死人身上的白光也得褪。这条以前漏在活人分支里，而那一支在死亡时就 return 了 ——
      // 于是被打死的人会顶着一层白到沉进地里。
      this.hurt = Math.max(0, this.hurt - dt * 5);
      this.death += dt;

      // 弹道。走在 animate 之外：画面外的人也得飞完这一程，否则镜头转回去时尸体还杵在
      // 原地，而它本该已经躺在三十个单位以外了。
      if (this.airZ > 0) {
        this.airTime += dt;
        this.velZ -= GRAVITY * dt;
        this.airZ += this.velZ * dt;
        this.x += this.velX * dt;
        this.y += this.velY * dt;

        // 隔一小段记一个点。每帧都记的话，帧率一变轨迹的疏密就跟着变。
        this.trailClock += dt;
        if (this.trailClock >= TRAIL_STEP) {
          this.trailClock = 0;
          const i = this.trailHead * 3;
          this.trail[i] = this.x;
          this.trail[i + 1] = this.y;
          this.trail[i + 2] = Math.max(0, this.airZ);
          this.trailHead = (this.trailHead + 1) % TRAIL_POINTS;
          if (this.trailCount < TRAIL_POINTS) this.trailCount++;
        }

        if (this.airZ <= 0) {
          this.airZ = 0;
          this.velX = 0;
          this.velY = 0;
          this.velZ = 0;
        }
      } else if (this.trailCount > 0) {
        // 落地之后轨迹一节一节褪掉，不是啪一下消失。
        this.trailClock += dt;
        if (this.trailClock >= TRAIL_STEP) {
          this.trailClock = 0;
          this.trailCount--;
        }
      }

      if (!animate) return false;
      this.animator.collapse(
        this.pose,
        this.def,
        clamp(this.death / COLLAPSE_TIME, 0, 1),
        this.fallX,
        this.fallY,
        this.ensureMount(),
      );

      // 翻滚 + 抬到空中。两件事都发生在 collapse 搭完姿势之后：collapse 给的是"躺平的
      // 那个样子"，这里把整具身体当成一个刚体去转、去抬。
      if (this.airZ > 0) {
        const spin =
          this.flightSpan > 0
            ? (this.turns * 2 * Math.PI * Math.min(this.airTime, this.flightSpan)) / this.flightSpan
            : 0;
        this.flingPose(spin, this.airZ);
      }

      // 躺够了就沉下去。压扁 z 而不是调透明度：渲染器没有整体 alpha，而且一具慢慢陷进
      // 草里的尸体比一具凭空消失的更像回事。
      //
      // 计时要扣掉滞空：不扣的话，一个飞得久的人还在天上就开始往下压扁。
      const sinking = this.death - this.airTime - COLLAPSE_TIME - CORPSE_HOLD;
      if (sinking > 0) {
        const k = 1 - clamp(sinking / SINK_TIME, 0, 1);
        for (const j of [
          this.pose.hip, this.pose.chest, this.pose.head,
          this.pose.footL, this.pose.footR, this.pose.kneeL, this.pose.kneeR,
          this.pose.handL, this.pose.handR, this.pose.elbowL, this.pose.elbowR,
        ]) {
          j.z *= k;
        }
        // 马也得一起沉。漏了它，骑手陷进草里之后地上还剩一匹凭空停住的马。
        const horse = this.horsePose;
        if (horse && this.def.mounted) {
          for (const j of [horse.chest, horse.croup, horse.withers, horse.poll, horse.muzzle, horse.saddle]) {
            j.z *= k;
          }
          for (const j of horse.hoof) j.z *= k;
          for (const j of horse.knee) j.z *= k;
          for (const j of horse.tail) j.z *= k;
        }
      }
      return false;
    }

    this.hurt = Math.max(0, this.hurt - dt * 4);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    let landed = false;
    let attackT = -1;
    if (this.attack >= 0) {
      const duration = attackDuration(this.def);
      const before = this.attack / duration;
      this.attack += dt;
      attackT = this.attack / duration;

      // 跨越检测，不是阈值比较：后者在落点之后的每一帧都为真，会连着触发一整串。
      const impact = attackImpact(this.def);
      if (before < impact && attackT >= impact) landed = true;

      if (attackT >= 1) {
        this.attack = -1;
        attackT = -1;
      }
    }

    if (animate) {
      /*
       * 喂给步态的速度要夹一下，**不是**真实速度。
       *
       * 步态那一套公式（步幅、起伏、横摆、相位推进）是按 10~70 这一档速度写的，而突进接近
       * 600。两样一起崩：起伏的幅度是 `0.3 + 速度 × 0.022`，到 600 就是十三个单位 —— 比马
       * 本身还高；相位每帧推进半个循环，正好踩在采样极限上，四条腿每帧反着跳。那 0.22 秒
       * 里马不是在冲，是在抽，长条的身子完全读不出指着哪儿 —— 而人在同一档只是"腿有点花"，
       * 所以这个毛病是骑兵先暴露出来的。
       *
       * 夹在步行速度的 3.2 倍：跑步（1.875 倍）以下一切照旧，只有突进这一档会被夹住。夹完
       * 仍然比跑步更快更大步，读作"冲出去"，只是不再散架。
       *
       * 夹的只有步态。位移、判定、特效继承的速度全走真实值 —— 人确实是以那个速度飞出去的。
       */
      const gaitSpeed = Math.min(this.speed, this.walkSpeed * MAX_GAIT_PACE);
      // 正着走还是倒着走，先定下来：人和马要用同一个答案。moveAngle 是空的（除了玩家，
      // 所有人都是）时差值就是 0，永远正着走。
      this.animator.syncStepDirection(dt, this.moveAngle === null ? 0 : this.moveAngle - this.facing);
      // 马先走一步：骑手的胯是坐在鞍上的，鞍的位置这一帧得先算出来。
      const horse = this.ensureMount();
      if (horse) this.horseAnimator?.update(dt, gaitSpeed, horse, this.animator.backward);
      this.animator.update(dt, gaitSpeed, this.walkSpeed, this.def, attackT, this.pose, horse);
    }
    return landed;
  }
}
