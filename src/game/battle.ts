import { attackDuration } from '../characters/animator';
import { RigSpec } from '../characters/rig';
import { PALETTE_HERO, type CharacterPalette } from '../characters/palette';
import { type UnitDef, type UnitPresetId, UnitPresets, unitAppearance } from '../characters/unitDef';
import { clamp, turnToward } from '../core/math';
import { DamageNumbers, type DamageNumberLabel } from '../effects/damageNumbers';
import {
  CRIT_CHANCE_BASIC,
  CRIT_SKILL_MULTIPLIER,
  CRIT_MULTIPLIER,
  DAMAGE_VARIANCE,
  MIN_DAMAGE,
  MAX_LEVEL,
  BLAST_PER_ENEMY,
  LIFESTEAL_PER_LEVEL,
  BERSERK_ATTACK,
  BERSERK_ATTACK_SPEED,
  BERSERK_DEFENSE,
  BERSERK_HP_DRAIN,
  MEND_HP_PER_TICK,
  SIGNATURE_DAMAGE_BONUS,
  SKILL_MAX_LEVEL,
  debrisReach,
  launchForce,
  ORB_ORBIT_REACH,
  ORB_SPIN,
  ORB_HIT_RADIUS,
  ORB_HIT_GAP,
  AURA_HIT_GAP,
  HEAVEN_GUARD_PACE,
  HEAVEN_GUARD_BODY_MARGIN,
  HEAVEN_GUARD_HIT_GAP,
  HEAVEN_GUARD_FADE,
  FINAL_BOSS_LIMIT,
  ORB_POWER,
  expToNextLevel,
  RUN_MULTIPLIER,
  SKILL_DAMAGE_PER_POWER,
  COIN_DROP_CHANCE,
  CAMPFIRE_DROP_SPREAD,
  damageAfterDefense,
} from '../data/balance';
import { ITEM_SLOT_COUNT, ITEM_STACK_MAX, REGEN_TICK, pickupById, rollBossPickup, rollPickup } from '../data/pickups';
import { FORTUNE_COIN_MULTIPLIER } from '../data/shop';
import { Heroes } from '../data/heroes';
import { NEUTRAL_MODIFIER, type HeroDef, type MapModifier, type StatBonus, type UnitStats } from '../data/types';
import type { ResolvedUnitKind } from '../data/types';
import { resolveKind } from '../data/units';
import { expFromKill, resolveEnemyStats, resolveHeroStats } from './stats';
import { Debris } from '../effects/debris';
import { WarpField } from '../effects/warpField';
import { ImpactEffects, frontRadius, weaponImpactPoint, type ShockwaveOptions } from '../effects/impact';
import { SKY_BLADE_LENGTH, SKY_BLADE_WIDTH } from '../effects/skyBlade';
import { HEAVEN_GUARD_LEAD, HEAVEN_GUARD_PALETTE, heavenGuardOffset } from '../effects/heavenGuard';
import { Character } from './character';
import { isFreeSpot, moveWithCollision } from './collision';
import { inSector, sweptBy } from './combat';
import type { Field } from './field';
import { rgb } from '../render/color';
import { SpatialGrid } from './grid';
import { WorldPopulation } from './worldPopulation';
import { DistantMotion } from './distantMotion';
import { SkillLoadout, SPRINT_SKILL, runSkillPool, type ActiveSkillSlot } from './skillLoadout';
import {
  DEFAULT_SPAWN_TEMPLATE,
  WaveDirector,
  type SpawnTemplate,
} from './waves';
import { Collectibles } from '../world/collectibles';
import {
  SKILL_HIT_MARGIN,
  WAVE_NEAR_HALF_WIDTH,
  cappedReach,
  exitDistance,
  skillById,
  type SkillDef,
  type SkillId,
} from './skills';

/**
 * 一局割草：场上的所有人，以及他们之间发生的事。
 *
 * 这里是接下来长肉的地方 —— 波次、技能、掉落、经验，全部往这个文件加。它不认识 Pixi，也不
 * 认识相机：外面每帧告诉它"玩家想朝哪儿走"和"视野有多大"，它回一个推进过的世界。想验证
 * 一条规则不用开浏览器，把这个类拿到 node 里空跑几分钟就行。
 */

/**
 * 人的写实步行速度，世界单位/秒（一个人大约 19 单位高）。
 *
 * 只用来给动画做归一化：动画器拿它判断"这个速度算走还是算跑"，从而决定步态混合、摆臂幅度
 * 和斗篷的甩动。它描述的是身体，不是游戏手感，所以调玩家速度时不要动它 —— 移动速度翻倍
 * 之后，人相对这个基准就是在跑，斗篷和步幅会自己跟上去。
 */
export const HUMAN_PACE = 16;

/**
 * 突进撞人判定在身体半径之外再放宽多少。
 *
 * 冲多快现在由**奔跑速度**折算，不再是一个时间常量除出来的（见 castSkill 的 lunge 分支）。
 * 原来是"距离 = reach × attackRange，除以 0.22 得到速度"，那条换算有两个毛病：一是冲刺
 * 的快慢跟着**武器长度**走，武将的攻击范围 34、骑士 16，同一招在两个人身上差出两倍多；
 * 二是 0.22 秒那一档根本看不清，一帧跨过八个单位，玩家看到的是人瞬间出现在别处，撞飞的人
 * 和犁开的道全糊在镜头飞走的过程里。现在冲刺速度是这个角色奔跑速度的固定倍数，四个人的
 * 冲刺读起来是同一招。
 *
 * 13 不是"放宽一点"，是**犁出一条看得见的道**。原来给 2.5，加上体宽总半宽才 8 个单位，而
 * 人群互相分离的间距是 11 —— 一次冲刺只扫掉正中一列人，人群立刻合拢，画面上什么都没发生。
 * 实测玩家正前方 110 单位内有 184 人，半宽 8 只罩得住 9 个，半宽 16 罩得住 24 个。
 *
 * 这一条是"撞飞看不见"的真正原因，而不是力度或方向：尸体确实以 170 单位/秒横着甩出去，
 * 但它从一团人飞进另一团人，没有空地做参照就读不出位移。先有道，才看得见飞。
 */

/**
 * 冲刺撞人时的击飞力度和定格时长。
 *
 * 冲刺中的玩家（也就是镜头）跑 495 单位/秒，而普通击飞初速只有 78 —— 相对屏幕，被撞的人
 * 是往后退的。实测：尸体飞 55 个单位的同时玩家跑了 74 个，所以"撞飞"在画面上根本读不出来。
 *
 * 力度给到 2.2 倍，定格压到 25 毫秒（普通是 70）：被车撞和被刀砍不是一回事，而定格那段时间
 * 里镜头正在飞走，人钉在原地反而最像"没打中"。
 */
// 1.8 不是 2.2：改成横着甩之后，整份力气都用在"离开冲刺线"上了，不再有一半浪费在追着
// 镜头跑的前向分量上。2.2 时横向中位到 138 个单位，而视口半高才 109 —— 一半的尸体直接
// 飞出画面，看不到落地就是白飞。
const LUNGE_FORCE = 1.8;
const LUNGE_FREEZE = 0.025;

/**
 * 撞飞的方向里，"顺着冲刺方向"那一份占多少（横向那一份固定是 1）。
 *
 * 一开始把撞飞做成了朝正前方 —— 那是错的，而且错得很隐蔽：**朝前正是镜头追着跑的方向**。
 * 尸体以 170 单位/秒往前飞，玩家以 495 追上去，相对屏幕它几乎没动，看着就是被推着走的一堆
 * 东西，不是被撞开的人。
 *
 * 真正让人"飞出去"的是**垂直于路径**那一份：只有横向位移才能让尸体离开冲刺线，从镜头旁边
 * 甩出去。前向留一点（0.35）是为了不显得诡异 —— 被高速撞上的人当然会带一点前冲，但那只是
 * 佐料，主菜是横着掀开。
 */
const LUNGE_SIDE_FORWARD = 0.35;
const LUNGE_BODY_MARGIN = 13;

/*
 * 不要在这里加"打击顿帧"（砍中就把整个世界停几十毫秒）。试过一版，是错的。
 *
 * 它在别的类型里是标准做法，在割草里是原则性错误：玩家每 0.7 秒自动挥一次、每次都杀到人，
 * 于是世界每 0.7 秒停一下，占空比接近一成。那不读作"有力"，读作掉帧 —— 而割草的核心体验
 * 恰恰是**不停地**推进，任何周期性的停顿都在跟这件事对着干。
 *
 * 顿帧真正想给的重量，由受击者自己表达就够了：他在中刀的姿势上定住几帧再被掀飞（见
 * Character 的 HIT_FREEZE）。同样的冲击感，一分钱不从玩家的时间里出。
 */

/**
 * 基准角色的走路和奔跑速度。
 *
 * 战斗里**不读这两个常量** —— 玩家真正走多快看 player.stats.moveSpeed，那是按角色、等级和
 * 被动算出来的（见 game/stats.ts），跑是它乘 RUN_MULTIPLIER。留着这两个数是因为备战界面
 * 那个转圈的小人也要走路，而它身上没有属性。
 *
 * 两个数正好是基准角色（双锤武将，一级）算出来的结果：32 和 32 × 1.875 = 60。
 */
export const PLAYER_SPEED = 32;
export const PLAYER_RUN_SPEED = 60;
/**
 * 找空位时往前看多远（按两人该有的间距的倍数），以及绕行时切向分量给到多少。
 *
 * 敌人围住玩家之后要**站定**，不能继续往里挤 —— 挤是塌陷的唯一来源。但光"挡住就停"不够：
 * 那样人只会沿半径方向一层层堆叠，内圈那一环永远填不满，玩家周围反而空。所以挡住之后要
 * 沿切线**绕行**去找空位，绕不到就停在外面（哪怕在屏幕外）。
 *
 * SIDESTEP 是绕行时切向占的权重。给满 1 会让人绕着玩家转圈永远不进来；太小又绕不开。
 *
 * SIDESTEP_SPEED 是绕行时的速度，按步速的几成算；SIDESTEP_NEAR 让它**随着离玩家变远再衰减**。
 * 围满之后那一圈没有缺口，全速绕行就是几百个人贴着人堆原地转圈 —— 整个画面一直在闪，而没有
 * 一个人真的挪到了更好的位置。
 *
 * 两段式而不是一刀切，是因为前后排要的东西不一样：贴着玩家那一圈得继续抢位置，人一死立刻
 * 有人补上，不然清场速度会塌；而后排怎么挪都轮不到他们，那点动作纯粹是噪声。所以近处保留
 * 绕行、远处按 SIDESTEP_NEAR/dist 衰减下去 —— 屏幕上绝大多数人属于后排，画面因此静下来。
 *
 * 真正在闪的是**步态**，不是位移：动画器按 speed/walkSpeed 混合走路循环，全速绕行时后排的
 * 幅度有 0.45，几百个人一起走就是满屏在晃。0.12 这一档把它压到 0.15，前排还留着 0.26 在补位。
 * 扫过 0.3 / 0.2 / 0.12 / 0.06：再往下清场速度开始塌（站桩测法下从 3.6 掉到 2.9），收益却
 * 只剩零点几。想让人群更活就往上调，更静就往下。
 *
 * 试过两条"干脆让他停住"的路，都失败了，记在这儿免得再走一遍：
 *
 *   左右也堵住就停 —— 密集场里每个人旁边都有人，整片人冻成一块，连该进攻的前排都不动。
 *   排在站定的人后面就站定 —— 会死锁。人群冻成刚体之后，玩家把正面扇区清空，空出来的地方
 *     再没人流进去（边上的人被站定的邻居锁着，而那些邻居不在攻击弧里永远不死），二十秒里
 *     一个都杀不掉。
 *
 * 教训是一样的：人群必须保持能流动，"减少移动"只能靠**压低速度**，不能靠禁止移动。
 */
const SLOT_LOOKAHEAD = 1.5;
const SIDESTEP = 0.9;
const SIDESTEP_SPEED = 0.12;
const SIDESTEP_NEAR = 45;

/** 大到打不完，当"无敌"用。不使用 Infinity：省得血量参与运算的地方冒出 NaN。 */
export const INVINCIBLE_HP = 999999;

/**
 * 生命上限的调试倍率档位。菜单里那个 [− 生命 N +] 在这张表上走。
 *
 * 以前这是一张绝对血量的梯子（5 / 10 / 20 … 1000）。现在血量上限由角色和等级算出来，
 * 一个写死的绝对值会把那份结算整个覆盖掉，所以改成**倍率**：1 就是这个角色本来的血量，
 * 往下调用来测"被打死是什么样"，往上调用来长时间挂机看人海。
 *
 * 顶格那一档是无敌（面板上就显示成"无敌"），走的仍然是 INVINCIBLE_HP 那条老路。
 */
const HP_SCALE_LADDER = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, Number.POSITIVE_INFINITY];

/**
 * 攻击频率现在是玩家的一项基础属性（UnitStats.attackSpeed），不再是这里的一个常量。
 *
 * 它是**倍率**而不是"再等几秒"：每种武器的动作时长本来就不一样（锤子 0.72 秒一下、拳头
 * 0.38 秒），一个绝对的秒数没法同时作用在它们身上，而且减到 0 就到顶了。一刀接一刀（原来
 * 那个 PLAYER_SWING_GAP = 0）对应的就是 attackSpeed = 1。
 */
const playerSwingTime = (player: Character): number =>
  attackDuration(player.def) / Math.max(0.2, player.stats.attackSpeed);

/**
 * 出怪间隔。玩家清场的速度约每秒三个，所以这个值定得比它快不少，场面才会一直是满的 ——
 * 割草游戏的压迫感来自"杀不完"，出怪率一旦低于清场速度，画面就空了。
 */
const SPAWN_INTERVAL = 0.18;

/**
 * 开局先在**视口外**铺这么多。
 *
 * 以前是从脚边到视野边缘直接撒，开场第一帧玩家周围就凭空围了一圈人 —— 那不是"战场上有敌人"，
 * 是"敌人是刚才生出来的"，穿帮得很明显。现在这一批和之后每一个都走同一条路（spawn），
 * 全部生在看不见的地方再走进来。
 *
 * 代价是开局有几秒钟画面偏空。这是对的：割草的压迫感来自人越涌越多，而不是一上来就满屏。
 */
// 掉金币的概率搬到 data/balance.ts 了 —— 金币现在是跨局的货币，它的产出率和商店那一侧的
// 定价是同一件事，不该留在战斗引擎里。

const SEED_COUNT = 30;

/**
 * 开局那一批往视口外再多撒多远。
 *
 * 光走 spawn 的话三十个人全贴在视口边缘上，会读作一个同时收缩的圆环 —— 整整齐齐，一眼假。
 * 多给一段随机纵深，他们就分批到达：近的几秒内就打上来，远的还在路上。
 */
const SEED_DEPTH = 150;

/**
 * 出兵旋钮的档数，菜单里那个 [− 出兵 xN +]。
 *
 * 出兵的快慢现在由模板定（waves.ts 的 density 和 surge），这个旋钮退成一个**倍率**：
 * 顶满（xN = 12）就是模板原速，往下调是按比例放慢，用来在调别的东西时把人海压下去。
 * 它不再直接等于"一批放几个"，所以调到 x1 不会像以前那样把节奏卡成一个一个挪进来，
 * 而是整条曲线按 1/12 缩放。
 */
const MAX_SPAWN_BATCH = 12;

/**
 * 出怪点落在视口外多远，以及随机抖动的幅度。
 *
 * 只要出了视口就看不见，所以这个数不用大 —— 它决定的是"敌人从看不见的地方走进来要多久"。
 * 给得太大，玩家清完一波要等上好几秒；太小，缩放拉远的那一帧可能刚好把人露出来。
 *
 * 它同时是 DESPAWN_MARGIN 的下限：出怪点必须落在回收框里面，否则人一生出来就被抹掉。
 */
const SPAWN_MARGIN = 12;
const SPAWN_JITTER = 24;

/**
 * 视野外多远开始回收，按视口半宽/半高的倍数。
 *
 * 跑步机模型的另一半：出怪只管往前补，回收负责把身后跟不上的人抹掉。少了它，玩家一路跑
 * 过去会拖着一条越来越长的尾巴 —— 那些人永远追不上，只是在白烧 CPU。
 *
 * 下限由出怪点定：出怪最远落在视口外 SPAWN_MARGIN + SPAWN_JITTER（36 个单位），而 0.3 个
 * 视口有 49，生出来不会当场被回收掉。
 *
 * 这个数直接决定场上养多少人，而屏幕上看到的几乎不受影响 —— 多出来的全是屏幕外排队的。
 * 实测站桩：0.5 时场上 1043、屏内 451、逻辑 3.1ms；0.3 时场上 702、屏内 381、逻辑 2.0ms。
 * 场上少了三分之一，屏内只少 15%，逻辑省了 35% —— 那部分人纯粹是在屏幕外白烧 CPU。
 */
const DESPAWN_MARGIN = 0.3;

/** 全图初始散布及持续补怪的目标间距（世界单位），调小会增加远处怪物密度。 */
export const WORLD_ENEMY_SPACING = 28;
/** 完整怪物和移动数据共享的 CPU/内存兜底；常规新增及远处名额调配优先遵守更低的日常预算。 */
export const MAX_WORLD_ENEMIES = 4000;
/**
 * 日常总量预算。远处预留名额不能把玩家附近的跑步机刷怪永久关掉。
 *
 * 这个数决定的是**屏幕外那片人海有多厚**，而整条人群模拟严格线性跟着它走：邻居让路、
 * 分离、移动、建网格加起来占整帧自耗时约两成，而那两成里绝大多数花在一个都画不出来的人
 * 身上。稳态下 2400 的预算里有 1848 个是预留数据（无骨架），屏幕上只画 359 个。
 *
 * 2400 → 1200 实测（离线基准，跑到第 60 秒稳态，各 300 帧）：
 *
 *              预留    场上   画   一帧 CPU   其中 battle.update
 *   2400       1848    552   359   14.11 ms      5.44 ms
 *   1200        723    477   332   12.27 ms      3.63 ms
 *
 * 屏幕上少了 7%（359 → 332），逻辑省了三分之一。少掉的那部分主要是远处排队的：小地图上
 * 红点密度大约减半，人海补上来的节奏也稀一档。附近的进攻者仍由这一波的 crowd 保底。
 *
 * 开局铺怪也守这条线：seedWorld 曾经只夹 MAX_WORLD_ENEMIES，实测一铺就是 1538 个（1200
 * 见方的图除以 28 的间距是 42×42 格，一格一个），要玩家杀上十几秒才掉回预算之内，而那十几
 * 秒恰好是每条命最吃紧的开头。
 */
export const TARGET_WORLD_ENEMIES = 1200;

const WORLD_REFILL_RESERVE = 600;

/**
 * "重新获得视线"的判定框，同样按出货视口半宽/半高的倍数。
 *
 * 必须**小于** DESPAWN_MARGIN，两者之间那条带子就是迟滞区。少了它，恰好卡在回收线上的位置
 * 会每帧"恢复—回收—恢复"地抖，白白搅动人数。
 *
 * 0.15：恢复线落在视口外 0.15 × 120 = 18 个单位，人是在**画面外**放回去的，看不到凭空出现；
 * 而离回收线还有 18 个单位，冲刺也要 0.3 秒才穿过，抖不起来。
 */
const RESTORE_MARGIN = 0.15;

/**
 * 玩家在动时，出怪往前方偏多少。0 是四面八方，1 是正后方完全不出。
 *
 * 理由是物理性的：玩家跑起来（60）比每一种敌人都快，生在身后的人永远追不上，走两步就被
 * 回收了 —— 那是纯粹的浪费。偏移量按"玩家跑得多快"缩放，站着不动时自然退回四面八方，
 * 也就是围杀的那个形态。
 */
const FORWARD_BIAS = 0.85;

/**
 * 自动锁敌的搜索半径，世界单位。
 *
 * 出货那一档的视口大约 400 × 218 个单位，所以 240 差不多就是"屏幕上还看得见的那一圈"。再远
 * 的人锁上没有意义 —— 朝着一个还要跑两秒才够得着的人站定，既打不到他，也看不出身体在指谁。
 *
 * 它**不跟着滚轮缩放走**，和出怪用出货视口是同一个道理：缩放是调试旋钮，玩家的手感不该跟着
 * 一个调试旋钮变。
 */
const AIM_RANGE = 240;

/**
 * 转身的角速度，弧度/秒 —— 三个数，因为它不是匀速的。
 *
 * 匀速转身有两个毛病，而且都出在**收尾**那一下：转到位的那一帧角速度还是满的，然后戛然而
 * 止，看着像卡了一下；而小角度的目标切换（人堆里换个人，二三十度）在满速下一两帧就走完了，
 * 根本看不见转身这回事 —— 读作瞬移。
 *
 * 所以角速度跟着**还差多少**走：EASE 是那个比例，转得越近越慢，自己就带出一条缓出曲线。
 * MAX 压住大角度（背后那个人倒下、要转回正面）起步时的速度，MIN 是个地板，免得最后那几度
 * 拖出一条看不见尽头的尾巴。
 *
 * 这一组下来：转身后那个人（半圈）约 0.54 秒，人堆里换个人（三十度）约 0.22 秒、十几帧。
 * 之前是匀速 14，同样这两件事分别是 0.22 秒和**两帧** —— 后者就是"基本上没有帧"的由来。
 *
 * 想再慢就调小 EASE（整条曲线一起慢），想让大角度起步更利落就调大 MAX。
 */
const AIM_TURN_EASE = 8;
const AIM_TURN_MAX = 9;
const AIM_TURN_MIN = 2;

/**
 * 换目标的粘性：新的人要近到旧目标的这个比例（对距离平方，所以 0.64 = 八成距离）才换。
 *
 * 人堆里永远有两三个人距离几乎相等，谁近谁远每帧都在变。没有这一条，身体就在他们之间来回
 * 抖 —— 而那几个人站在哪个方向其实根本不重要，他们都在同一片。
 */
const AIM_SWITCH_STICK = 0.64;

/**
 * "算不算在画面里"的余量，世界单位。
 *
 * 画面外的人只走计时：不搭姿势（那是每人每帧最贵的一块，而没人看得见），也不找空位。留一点
 * 余量是为了让人在真正露头之前就已经在正常行事，边界上看不出切换。
 */
const SCREEN_SLACK = 40;

/**
 * 允许在地图外多远的地方出怪。
 *
 * 图外**是可以出人的**，而且必须可以：玩家贴到边界时，四周有大半个方向在图外，只在图内找
 * 位置的话那些方向一个人也生不出来 —— 于是人只从场内一侧涌来，包围感直接没了。相机被夹在
 * 场内，图外永远不会出现在画面上，所以那里生出来的人是从视野外走进来的，和场内没有区别。
 *
 * 留一个上限只是为了兜住"缩放拉到全景"那种情形：那时视口比整张图还大，射线要跑很远才出得
 * 去，不夹一下会把人扔到几千个单位以外，走一分钟都到不了。
 */
const SPAWN_OUTSIDE = 300;

/**
 * 人群间距的倍率，乘在 Character.spacing（躯干半宽）上。可运行时调，用来对比手感。
 */
/**
 * 人群间距的倍率，乘在 Character.spacing（躯干半宽）上。
 *
 * 1 是"两个人的躯干圆刚好相切"。但相切**还不够看**：描边是整层一次的合成通道（见
 * PixelSurface），不是逐人描的，所以挨在一起的两个人会融成一个带一圈边的团，读不出是两个。
 * 胳膊还会再往外伸一点，把那点缝也填掉。
 *
 * 量出来的：贴身那圈人的中位间距，x1.0 是 7.4 个单位 —— 躯干边缘差 2 个像素才分开，也就是
 * 还在重叠；x1.5 是 10.5，躯干之间空出 3.1 个世界单位（出货那一档是 12 个像素），而贴身 25
 * 单位内的人数只从
 * 13 掉到 12。再往上到 x1.6 空隙 11 像素，但贴身圈就掉到 9 人了，密度开始真的变稀。
 */
const CROWD_SPACING = 1.5;
/** 允许调到的上限。 */
const MAX_CROWD_SPACING = 2.2;

/** 场上最胖的人。格子边长和探测半径都按他算最坏情况。 */
const MAX_BULK = 1.34;
/** 最胖那位的站位半径。 */
const MAX_SPACING = RigSpec.torsoHalfWidth * MAX_BULK;

/** 当前间距下，分离的最大交互距离 —— 也就是格子边长的下限。 */
const cellSizeFor = (spacing: number): number =>
  Math.ceil(RigSpec.torsoHalfWidth * MAX_BULK * 2 * spacing);



/**
 * 追击提速的两头和倍率。见下面敌人 AI 里那段注释。
 *
 * 近的一头（45）要落在贴身那圈人之外：围着玩家的那一坨是被互相推开撑出来的，让他们跟着
 * 提速只会把人堆挤得更紧，看不出是在追。
 */
const CHASE_NEAR = 45;
const CHASE_FAR = 75;
const CHASE_BOOST = 1.8;

/** 敌人两次出手之间的间隙，秒。给一段随机量，免得一圈人整齐划一地同时挥。 */
/**
 * 每一波到点放的那个首领是谁。
 *
 * 先只用精锐统领一种：玩家要能一眼认出"这是首领"，而认出一种比认出两种容易。以后要按波次
 * 换人的话，这里改成一张按波次查的表就行。
 */
const BOSS_KIND = 'elite' as const;

/** 首领挨一下定在原地多久，秒。只停脚不停手（见 Character.stun）。 */
const BOSS_HIT_STUN = 0.14;

/** 玩家头顶那几串字从多高冒出来。比头再高一截，别和身边满地的伤害数字混在一起。 */
const PLAYER_FLOAT_Z = 34;

/**
 * 横扫的三层扇面。side 是占张角的几成（±0.5 就是扇区的两条边）。
 *
 * 最外那两片停在 ±0.46 而不是 ±0.5：刀光本身有宽度，贴着边画会有半片在判定外，
 * 玩家会反复遇到"扫到了却没死"。
 */
const SWEEP_LAYERS = [
  { bit: 1, sides: [-0.46, 0, 0.46], distance: 1, weight: 2.35 },
  { bit: 2, sides: [-0.24, 0.24], distance: 0.82, weight: 2.1 },
  { bit: 4, sides: [0], distance: 0.62, weight: 1.85 },
] as const;

/**
 * 哪一级点亮哪几层（位与 SWEEP_LAYERS.bit 对应：1 = 外三，2 = 中二，4 = 内一）。
 *
 * 片数 1/2/3/5/6 —— **满级是三层都在，六片**。每一级都是几整层的组合，所以任何一级都
 * 左右对称 —— 敲出一个偏向一边的扇面读起来像没画完。下标 0 空着，让等级直接当下标用。
 */
const SWEEP_FAN_BY_LEVEL = [0, 4, 2, 1, 1 | 2, 1 | 2 | 4] as const;

/**
 * 他够不够得着对方。**只看距离，不看角度，也不看碰撞。**
 *
 * 两个人的身体半径都算进去：攻击距离说的是"武器从我身上伸出去多远"，而两个人是脸对脸站着的。
 * 不加这两副身体的后果是：人堆把杂兵顶在 12 个单位外（见 crowdSpacing），而杂兵的射程只有 11 ——
 * 于是围了一圈人却没一个动手，只有长枪兵（射程 20）在戳。
 *
 * 不判角度也是故意的：敌人每一帧都面向玩家，角度判定只会在挥到一半玩家绕到侧边时偷掉一下，
 * 而那一下在画面上看不出来 —— 玩家只会觉得"它明明砍到我了"。
 */
function reachable(
  attacker: { x: number; y: number; radius: number; stats: UnitStats },
  target: { x: number; y: number; radius: number },
): boolean {
  const dx = target.x - attacker.x;
  const dy = target.y - attacker.y;
  const reach = attacker.stats.attackRange + attacker.radius + target.radius;
  return dx * dx + dy * dy <= reach * reach;
}

/** 属性加成在头顶飘字里挂哪个牌子。 */
const BONUS_LABEL: Partial<Record<keyof StatBonus, DamageNumberLabel>> = {
  maxHp: 'HP', maxMp: 'MP', mpRegen: 'MP', attack: 'ATK', defense: 'ATK',
  moveSpeed: 'SPD', attackRange: 'ATK', attackSpeed: 'ATK', pickupRange: 'SPD',
};

const ENEMY_SWING_GAP = 0.6;
const ENEMY_SWING_JITTER = 0.35;
/** 弓手单独放慢到约每 2.8～3.8 秒一箭，避免落地箭很快铺满画面。 */
const ENEMY_ARCHER_SHOT_GAP = 2.8;
const ENEMY_ARCHER_SHOT_JITTER = 1;

/** 敌军箭矢：速度决定玩家看见箭后有多少反应时间；落点半径只比玩家身体略宽。 */
const ENEMY_ARROW_SPEED = 105;
const ENEMY_ARROW_MIN_TIME = 0.35;
const ENEMY_ARROW_MAX_TIME = 1.1;
const ENEMY_ARROW_HIT_MARGIN = 1.2;
const ENEMY_ARROW_GROUND_TIME = 3.5;
const ENEMY_ARROW_FADE_TIME = 0.9;

/**
 * 停步之前多长一段距离用来减速，世界单位。
 *
 * 不加这一段的话，"走"和"到位站定"之间是个硬开关：停在这个距离上的人每帧都在全速走路循环和
 * 站姿之间翻，几十个人一起翻就是那种特别刺眼的闪。实测走↔站的跳变占到 5% 的帧。
 * 有了这段缓冲，人是滑进位置的，速度连续到零。
 */
const APPROACH_BAND = 6;

/**
 * "想走多快"跟随目标值的时间常数，秒。见 Character.crowdPace。
 *
 * 0.18 秒：足够把每两三帧一次的抖动抹平，又不至于让人在前排腾出位置时反应迟钝（那会掉清场
 * 速度）。用 1 - exp(-dt/τ) 而不是定值系数，掉帧时行为才不变。
 */
const PACE_TAU = 0.18;

/** 玩家倒下之后躺多久重开。 */
/**
 * 用掉一件药或符之后，身上那层发光持续多久，秒。
 *
 * 短：它要读作"按下去的那一下"，不是一个状态。长一点就会和铁布衫那层一直在呼吸的提亮混成
 * 一件事，而那两件事玩家必须分得开。
 *
 * 0.42 试过，太快了 —— 在一屏几百个人都在动的画面里，那一下还没被注意到就退完了。0.62 仍然
 * 是"一下"，但看得见。
 */
const ITEM_FLASH_TIME = 0.62;

/**
 * 按住型的技能要**还剩得住这么多秒**才算开得起，秒。
 *
 * 只看"这一帧扣得动吗"是不够的：蓝快空时每帧扣一点、回一点，隔几帧就又攒够一帧的开销，于是
 * 疾走在走和跑之间抖、法相在开和收之间闪。要求留出四分之一秒的余量，见底那一下就是干净的
 * 一次停止，而不是一段抽搐。
 */
const SUSTAIN_RESERVE = 0.25;

const RESPAWN_DELAY = 1.2;

/**
 * 可选的玩家形象。**调试菜单**上那一排按钮就是这张表。
 *
 * 每一条现在都带着形象自己的名字（id）。原来只有 name 和 make，于是备战界面那张角色表只能
 * 按**下标**引它，那张表因此"只能往后加"，中间插一条会把所有角色悄悄换成别人。现在角色表
 * 写的是形象名（HeroDef.appearance），这张表怎么排都不影响它。
 *
 * 顺序仍然有意义，但只对调试菜单有意义：数字键 1~9 按下标选形象。
 */
export const PlayerPresets: { id: UnitPresetId; name: string; make: () => UnitDef }[] = [
  { id: 'warlord', name: 'warlord 武将 双锤', make: UnitPresets.warlord },
  { id: 'hero', name: 'hero 披风剑士', make: UnitPresets.hero },
  { id: 'thug', name: 'thug 杂兵', make: UnitPresets.thug },
  { id: 'shieldman', name: 'shieldman 持盾兵', make: UnitPresets.shieldman },
  { id: 'spearman', name: 'spearman 长枪兵', make: UnitPresets.spearman },
  { id: 'archer', name: 'archer 弓手', make: UnitPresets.archer },
  { id: 'elite', name: 'elite 精英', make: UnitPresets.elite },
  { id: 'knight', name: 'knight 骑士', make: UnitPresets.knight },
  { id: 'halberdier', name: 'halberdier 戟兵', make: UnitPresets.halberdier },
  { id: 'bulwark', name: 'bulwark 重甲兵', make: UnitPresets.bulwark },
  { id: 'cavalry', name: 'cavalry 骑兵', make: UnitPresets.cavalry },
  { id: 'lancer', name: 'lancer 枪骑兵', make: UnitPresets.lancer },
  { id: 'horseArcher', name: 'horseArcher 骑射', make: UnitPresets.horseArcher },
];

/** 菜单和 HUD 共用的角色显示名，英文部分只是内部预设代号。 */
export function playerPresetDisplayName(index: number): string {
  return PlayerPresets[index]?.name.replace(/^[a-z]+\s*/, '') ?? '';
}

/**
 * 敌人的种类和每一波出什么，都搬到 waves.ts 了：那边是纯数据，换地图就换一张表，而这里
 * 只负责把配额变成场上真实的人。
 */

/**
 * 一个召出来的金身重甲兵。
 *
 * 他不进 Battle.enemies，也不进人群分离和碰撞：他是**玩家放出去的一段判定**，只是长着一个
 * 人的样子。走直线、穿过所有东西、走完就散。真让他走一遍寻路和挤人，一排五个会当场挤成一
 * 堆，而"一排平行的矛推过来"正是这一招的全部内容。
 */
export interface HeavenGuard {
  /** 模型和步态。位置也存在他身上（x/y/facing），画的时候直接喂给 drawHeavenGuard。 */
  actor: Character;
  heading: number;
  /** 推进速度，世界单位/秒。见 HEAVEN_GUARD_PACE。 */
  speed: number;
  /** 还要往前推多远，世界单位。归零就开始收。 */
  left: number;
  /** 还在天上的剩余时间，秒。> 0 时不结算也不推进，只往下掉。 */
  drop: number;
  /** 下落总时长，秒。drop / dropTotal 就是"还有多高"，见 heavenGuardFall。 */
  dropTotal: number;
  /** 收尾倒计时，1 → 0。推完才开始走。 */
  fade: number;
  power: number;
  /** 发招那一刻的技能等级倍率。落地之后再升级不追加到已经放出去的这一排。 */
  scale: number;
}

/**
 * 一道正在往外跑的技能波。
 *
 * 这是**游戏状态**，不是特效：它每帧都要结算杀伤。同名的东西在 effects/impact.ts 里也有
 * 一份，那份是画出来的样子，这份是判定，两者用同一条推进曲线（frontRadius）所以永远对得上。
 * 分成两份是因为它们的生命周期不一样：特效可以在玩家死了、重开了之后继续跑完，判定不行。
 */
interface SkillWave {
  x: number;
  y: number;
  /** 施放瞬间从玩家继承的世界速度；判定和画面必须一起平移。 */
  vx: number;
  vy: number;
  heading: number;
  age: number;
  life: number;
  from: number;
  to: number;
  arc: number;
  /** 打中时溅多少碎片，见 SkillDef.power。 */
  power: number;
  /** 发招那一刻的技能等级倍率（见 SkillLoadout.damageScale）。 */
  scale: number;
  /**
   * 这一道波已经砍过谁。**一个人一道波只挺一下。**
   *
   * 没这一张表的时候它是每帧结算的：判定写的是"波前越过他了没有"（dist <= radius），
   * 而 radius 一路涨到头 —— 早早被包进去的人在接下来的三十多帧里会被反复结算。
   * 那条判定写的时候敌人还是"碰到就死"，重复结算看不出来；接上血量之后它就成了
   * 一招打三十下，而且帧率越高打得越疼。和金钟罩、天地法相那两个壳子是同一类错（见 AURA_HIT_GAP），
   * 只是壳子是持续的、用免疫窗口，而波只扫一遍、用一张名单。
   */
  hit: Set<Character>;
}

/**
 * 一支已经离弦的敌军箭。targetX/Y 在撒放瞬间写死，之后绝不读取玩家位置来修正弹道。
 * current/previous 给渲染器画出有长度的箭体，判定只在抵达固定落点时发生。
 */
export interface EnemyArrow {
  /**
   * 射出这支箭的人攻击力多少。
   *
   * 存在箭上而不是命中时回头去问弓手：箭飞一秒多，这期间射他的那个人经常已经死了，而且就算
   * 还活着，弓手站在屏幕外时也未必还是同一个对象（远处的人会被回收成无骨架的数据）。
   */
  attack: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  z: number;
  previousX: number;
  previousY: number;
  previousZ: number;
  startZ: number;
  arcHeight: number;
  age: number;
  total: number;
  landed: boolean;
  groundLeft: number;
  opacity: number;
}

/** 取敌军箭在固定弹道某一时刻的位置；逻辑推进和渲染尾迹共用，避免两条弧线错位。 */
export function enemyArrowPosition(arrow: EnemyArrow, age = arrow.age): { x: number; y: number; z: number } {
  const t = clamp(age / arrow.total, 0, 1);
  return {
    x: arrow.fromX + (arrow.targetX - arrow.fromX) * t,
    y: arrow.fromY + (arrow.targetY - arrow.fromY) * t,
    z: arrow.startZ * (1 - t) + 0.7 * t + Math.sin(Math.PI * t) * arrow.arcHeight,
  };
}

/** 这一帧玩家想干什么。由输入层翻译好再交进来，Battle 不认识鼠标和键盘。 */
export interface BattleInput {
  /**
   * 朝向的**外部指定**，弧度。不给就自动锁最近的敌人（见 aimPlayer）——**游戏里从不给**。
   *
   * 留这个口子只为 tools/ 下那些离线出图的脚本：那些图要的是一个定死的角度（"这一招朝正
   * 右边放出来长什么样"），而自动锁敌会让人跟着人堆转，同一个脚本每次跑出来的图都不一样。
   */
  facing?: number;
  /**
   * 想往哪儿走：世界坐标下的方向，长度 0 或 1。(0, 0) = 站着不动。
   *
   * 以前这里是一个 moving 布尔，因为走路只有"朝着准星往前"这一种 —— 方向根本不用问。方向键
   * 之后这是两个独立的答案：朝哪儿由 facing 说（准星），往哪儿挪由这里说。
   *
   * 可选：tools/ 下那些离线脚本不给方向时人就站着。
   */
  move?: { x: number; y: number };
  /** 疾走这一帧按着没有（R 或 Shift）。它不占主动槽，所以单独一条，见 skillLoadout。 */
  sprintHeld?: boolean;
  /**
   * 三个主动键位这一帧还按着没有，按 Q/W/E 的顺序。
   *
   * 按键的**按下**走的是另一条路（onKey → triggerActiveSkill），这里报的是**按住**。做成
   * 一个每帧刷新的数组而不是让 Battle 去记按键状态，是因为"键盘现在什么样"本来就是 Controls
   * 的事。
   *
   * 可选：tools/ 下那些离线脚本没有键盘，它们只想让世界跑起来。不给就等于一个都没按。
   */
  heldSlots?: readonly boolean[];
}

/**
 * 朝着 facing 一直往前走的一帧输入。
 *
 * 给 tools/ 下那些离线脚本用：它们要的是"让人朝着一个定死的角度走起来"，好让同一个脚本每次
 * 跑出来的是同一张图。玩家走不出这种输入 —— 他的朝向是自动锁敌锁出来的，走向才归他管。
 */
export function walkInput(facing: number): BattleInput {
  return { facing, move: { x: Math.cos(facing), y: Math.sin(facing) } };
}

/**
 * 这一帧的视野。两个框，各管各的事。
 *
 * 出怪用 spawn 那个框，它按**出货那一档**缩放算，和运行时的滚轮无关 —— 缩放是调试旋钮，
 * 上线后视口固定，出怪的节奏不该跟着调试视角变。而 x/y/radius 是**当前真实**的视野，用来
 * 判断谁远到不必搭姿势：那是纯性能优化，看得见的人就得搭，跟出货尺寸没关系。
 *
 * 出怪框给的是**矩形**而不是一个半径。用绕玩家的圆有个隐蔽的毛病：玩家贴到地图边缘时镜头
 * 被夹住，人就偏出了画面中心，这时以玩家为心、半径等于视口对角线的圆**盖不住整个视口**
 * —— 偏出去的那一侧会有敌人当着面刷出来。
 */
export interface BattleView {
  /** 当前镜头中心的世界坐标。 */
  x: number;
  y: number;
  /** 当前视口对角线的一半。只用来判断谁远到不必搭姿势。 */
  radius: number;
  /** 实际可见矩形。省略时使用 spawn，兼容离线战斗模拟。 */
  visible?: { x: number; y: number; halfW: number; halfH: number };
  /** 出怪框：出货那一档缩放下的视口，中心也按那一档夹过。 */
  spawn: { x: number; y: number; halfW: number; halfH: number };
}

/** 波次面板和调试面板读的那一份快照。数据都来自出兵模板，见 waves.ts。 */
export interface WaveStatus {
  /** 第几波，从 1 数起。 */
  wave: number;
  /** 模板一共几波。 */
  waves: number;
  /** 距下一波还有几秒。同时就是本波还剩多久。停在最后一波时是 0。 */
  countdown: number;
  /** 已经打完几波。面板上点亮这么多个节点。 */
  cleared: number;
  /** 本波允许场上同时有多少完整敌人。 */
  crowd: number;
  /** 整张模板的首领总数，暂定 0。 */
  bosses: number;
  /** 最后一波已经打完，正按它的密度续着出。 */
  holding: boolean;
  /** 调试钉住的波次，0 是不钉。见 Battle.pinnedWave。 */
  pinned: number;
}

const smooth = (prev: number, now: number): number => prev * 0.9 + now * 0.1;

/**
 * 一个被回收掉的敌人留下的**位置**。
 *
 * 存的是重建一个一模一样的人所需的全部东西。def、palette 和 stats 都是兵种表里那份共享的
 * 只读数据，直接引用即可，不用记下标 —— 一千条预留指向同五份。
 *
 * **属性也得带上。** 它们是按出生那一波算出来的，回来的时候可能已经是第六波了；重新算一遍
 * 会让一个第一波就存在的杂兵在被玩家跑回去看一眼的瞬间变强。他只是走出过画面，不是重生。
 *
 * 只存活人；远处照常移动、避障和推进冷却，但不创建骨架或动画器。
 */
type EnemyMover = Pick<Character,
  'x' | 'y' | 'facing' | 'def' | 'speed' | 'walkSpeed' | 'crowdPace' |
  'sideBias' | 'radius' | 'spacing' | 'alive' | 'stats' | 'expValue' | 'boss' | 'stun'
>;

/** 只缓存邻居让路决策；朝向、速度、移动和碰撞仍逐帧计算。 */
interface CrowdDecision {
  group: number;
  /** 下次问到必须重算：刚建的，以及站定过又重新起步的。 */
  stale: boolean;
  dirX: number;
  dirY: number;
  crowdSpacing: number;
  room: number;
  side: number;
}

/**
 * 近处的邻居让路决策分几组轮流做，一帧只做其中一组。
 *
 * 分组本身就是陈旧度的上限：最多隔三帧。**不要再叠一道按游戏时间算的上限** —— dt 被夹在
 * 1/20 秒（见 main.ts 主循环那段），所以掉到二十帧以下时，任何 50 毫秒量级的时间上限每帧
 * 都正好到期，缓存命中率直接归零。实测命中率 60Hz 66%、30Hz 33%、20Hz 0%、15Hz 0%：那道
 * 上限让这条优化在最需要它的机器上关掉了自己。
 *
 * 这和 collisionSteps 曾经按 moveDt 分子步是同一类错：按时间定的规则，掉帧时会反过来加重
 * 下一帧，而那正是掉帧的机器承受不起的。
 */
const CROWD_DECISION_GROUPS = 3;

interface Reservation extends EnemyMover {
  motion: DistantMotion;
  palette: CharacterPalette;
  /** 出手冷却。连这个也带上，回来的那一群才不会整齐划一地同时挥。 */
  cooldown: number;
  hp: number;
  maxHp: number;
}

/**
 * 一次打击掉多少血。
 *
 * 这个函数以前叫 rollDamage，掷出来的数**只是给飘字看的** —— 场上是碰到就死，掉血量根本
 * 不存在。现在它是真的：攻击力经防御递减，按技能档翻倍，再掷一次浮动和暴击，得到的数既
 * 进敌人的血条，也就是屏幕上飘起来的那个。
 *
 * power 一个字段管两件事（画面上溅多少碎片、伤害翻几倍）是有意的：看着更狠的那一下本来就
 * 该更疼，拆成两个字段迟早会调出"画面很炸但不疼"的招。见 SKILL_DAMAGE_PER_POWER。
 */
function rollDamage(
  attack: number,
  defense: number,
  power: number,
  /** 出手这一方的暴击率。技能命中算双倍 —— 以前那两个全局常量就是 0.09 和它的两倍。 */
  crit = CRIT_CHANCE_BASIC,
): { value: number; crit: boolean } {
  const skill = power >= 2;
  const struck = Math.random() < Math.min(1, crit * (skill ? CRIT_SKILL_MULTIPLIER : 1));
  const scaled = damageAfterDefense(attack, defense) * SKILL_DAMAGE_PER_POWER ** Math.max(0, power - 1);
  // 完全固定的伤害数字看久了像是假的，所以每一下都掷一次小浮动。
  const jitter = 1 + (Math.random() * 2 - 1) * DAMAGE_VARIANCE;
  const value = scaled * jitter * (struck ? CRIT_MULTIPLIER : 1);
  return { value: Math.max(MIN_DAMAGE, Math.round(value)), crit: struck };
}

/**
 * 战斗层只认这些语义，不认文件、AudioContext 或声部。浏览器入口把它们翻译成真正的音效。
 * count 让队列即使在极端割草场面触顶，也能把同类事件压进一条记录而不无限长。
 *
 * **只有两个：挥出去，和砍中了。** 暴击、拾取、升级、首领出场都撤了 —— 那几件事画面上
 * 本来就各有自己的说法（金色的大数字、飞向玩家的掉落、弹出来的卡牌、屏幕上的首领血条），
 * 再各配一个音效只是在割草的噪音里多抢一个声部。这两个留下来是因为它们是**唯一没有画面
 * 替身的反馈**：挥空的时候什么都没有，而砍中的那一下手感全在声音里。
 */
export type BattleSoundEventId = 'attack' | 'hit';

export interface BattleSoundEvent {
  id: BattleSoundEventId;
  count: number;
}

const MAX_SOUND_EVENTS = 256;

export class Battle {
  readonly player: Character;
  readonly enemies: Character[] = [];
  /** 冲击弧。由挥击的落点放出，所以归战斗管；画它的是 Scene。 */
  readonly effects = new ImpactEffects();
  /** 打碎溅出来的血珠和甲片。同上：谁放出来的归战斗管，画它的是 Scene。 */
  readonly debris = new Debris();
  /**
   * 砸在地上的扭曲。和上面两个一样是"招式放出来的东西"，只是画它的不是 ShapeBatch 而是
   * 合成阶段的一道滤镜（见 effects/warpField.ts）。
   */
  readonly warp = new WarpField();
  /** 头顶飘起来的扣血数字。数值还没接上，见 rollDamage。 */
  readonly damageNumbers = new DamageNumbers();
  /** 地图上的掉落物。数值结算尚未接入，目前只负责生成、落地和吸附。 */
  readonly collectibles = new Collectibles();
  /** 纯数据音效队列。只准由 main 抽干；Battle 永远不接触浏览器音频 API。 */
  private readonly soundEvents: BattleSoundEvent[] = [];
  /** 当前一局实际拾取的宝石数，HUD 用于循环进度；暂不参与升级或奖励。 */
  collectedGems = 0;
  collectedCoins = 0;
  /** 弓箭手已经射出的箭。公开只供 Scene 读取并绘制。 */
  readonly enemyArrows: EnemyArrow[] = [];

  /**
   * 交给 Collectibles 的吸附目标。每帧从玩家身上刷一遍，不是每帧新建一个对象 —— 这条路
   * 一秒钟跑六十次，而它只有三个数。
   */
  private readonly pickupTarget: {
    x: number; y: number; pickupRange: number; accepts?: (id: string) => boolean;
  } = { x: 0, y: 0, pickupRange: 0 };

  /** 绑好的那一份，免得每帧现造一个闭包。 */
  private readonly acceptsPickup = (id: string): boolean => this.acceptsItem(id);

  /**
   * 取走这一帧积下来的声音语义。返回新数组，Battle 不再持有它，main 可以就地合并。
   */
  drainSoundEvents(): BattleSoundEvent[] {
    return this.soundEvents.splice(0);
  }

  private emitSound(id: BattleSoundEventId, count = 1): void {
    if (count <= 0) return;
    if (this.soundEvents.length < MAX_SOUND_EVENTS) {
      this.soundEvents.push({ id, count });
      return;
    }
    // 离线 bench 不会有 main 来抽队列。触顶后只合并同类，内存仍有硬上限。
    const same = this.soundEvents.find((event) => event.id === id);
    if (same) same.count += count;
  }

  kills = 0;
  deaths = 0;
  /** 这一局砍掉几个首领。和总击杀分开记：它才是"打到哪了"的度量。 */
  bossKills = 0;
  /**
   * 这一局一共挺了多少伤害。结算画面上写一行。
   *
   * 和阵亡数是两回事：阵亡只能说"有没有撑住"，而这个数能说"差多少没撑住"。
   * 同样是无伤通关，挺了两万和挺了两千是两种打法。记的是**减免之后真正掉的血**，
   * 不是敌人的攻击力总和 —— 防御提上去了这一行就该降，否则它度量不了任何东西。
   */
  damageTaken = 0;
  presetIndex = 0;

  /**
   * 玩家倒下之后自动清场重开。
   *
   * 默认关掉：正经的流程是"倒下 → 结算画面 → 回选人"（见 defeated）。留着这个开关是给压力
   * 测试用的 —— 测末波必然要死很多次，每死一次弹一屏结算就测不下去了，所以调试菜单里能把
   * 它打开，那时的行为就是接结算流程之前的样子。
   */
  autoRespawn = false;
  /**
   * 玩家已经倒下、并且没有自动重开。外面读到它就切到结算画面。
   *
   * 用一个标志而不是回调：Battle 不认识界面，也不该认识 —— 它只负责把"这一局结束了"这件
   * 事记下来，怎么表现是 main 的事。reset 会清掉。
   */
  defeated = false;

  /**
   * 这一局打了多久，秒。结算画面要读。
   *
   * 和 clock 分开：那个是从进程启动就一直在涨的战斗时钟，DistantMotion 拿它当相位基准，
   * 重开时把它清零会让全图那批远处的人整齐地跳一下。这个只服务结算，清零没有副作用。
   */
  runTime = 0;

  /**
   * 完整 Character 的性能上限，含尚未清理的尸体，运行时用逗号/句号调整。
   * 只约束近处激活和近处补兵；远处按区域密度补充轻量数据，不消耗这些槽位。
   * 全图移动/碰撞开销另由 MAX_WORLD_ENEMIES 兜底，区域补怪也必须遵守它。
   */
  maxEnemies = 1500;
  autoAttack = true;

  /** 玩家这一帧真正走出的速度；撞墙时会小于 player.speed。 */
  private playerVelocityX = 0;
  private playerVelocityY = 0;

  /**
   * 招式特效该继承多少玩家速度。冲刺期间是零。
   *
   * 继承速度是为了让**贴在身上**的那些形状跟着人走：一边走一边挥，弧要是钉在原地，半秒
   * 之内人就走出去半个身位，弧读起来像是从背后掉下来的。按走路那个速度给，两者一直贴合。
   *
   * 但冲刺不能算进来。冲刺接近 500 单位/秒、只持续零点几秒，而一道弧活半秒 —— 继承下来
   * 就是"冲刺早停了，招式还在以冲刺的速度往前飞"。回旋最明显：那一圈本该罩在脚下，结果
   * 顺着冲刺方向飞出屏幕。冲刺期间的招式是发生在**某一个地方**的一件事，不跟着人跑。
   */
  private get effectDriftX(): number {
    return this.lunge ? 0 : this.playerVelocityX;
  }
  /**
   * 朝 heading 打出去的招该继承多少玩家速度 —— **只减不加**。
   *
   * 直接继承整个速度向量有一个毛病，它在这次改操作之前根本露不出来：速度里逆着 heading 的
   * 那一份会把招式往回拖。以前玩家只能朝着准星走，逆行分量恒为零；现在朝向自动锁敌、走位
   * 完全自由，一边后退一边放招是每一局都要做几十次的事。
   *
   * 破空最明显：它的判定和画面都挂在这个原点上（见 advanceSkills 里的 `w.x += w.vx * dt`），
   * 于是后退着放出去的那一道波是真的飞得更近 —— 一招的射程跟着走位缩水，而玩家并没有做任何
   * 换取这个代价的选择。
   *
   * 砍掉的只是逆行那一份，横向那一份留着：横向不改变招式沿 heading 走多快，而它正是继承速度
   * 的本意 —— 让贴在身上的形状跟着人走（见 effectDriftX）。顺着走的时候一切照旧，招式仍然
   * 借到那一份速度。
   */
  private driftAlong(heading: number): { x: number; y: number } {
    const x = this.effectDriftX;
    const y = this.effectDriftY;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const along = x * cos + y * sin;
    if (along >= 0) return { x, y };
    return { x: x - along * cos, y: y - along * sin };
  }

  private get effectDriftY(): number {
    return this.lunge ? 0 : this.playerVelocityY;
  }

  /**
   * 玩家当前拥有的技能、互斥槽与每项独立冷却。敌人仍只使用自己的基础攻击。
   * 装备规则全部收在 SkillLoadout，Battle 只负责到了触发时刻之后具体发生什么。
   */
  readonly skillLoadout = new SkillLoadout();

  /** 一次挥击起手时锁定的自动攻击；中途改菜单不会把已经挥出的招偷换掉。 */
  private pendingAttackSkill: SkillId = this.skillLoadout.attackSkill;

  /** 正在往外跑的技能波。只有"破空"会往这里放东西。 */
  private readonly skillWaves: SkillWave[] = [];

  /** 正在冲刺。Scene 拿它把玩家点亮 —— 高速位移得有个"我在冲"的信号。 */
  get dashing(): boolean {
    return this.lunge !== null;
  }

  /**
   * 这一帧在跑（按住 R 或 Shift 且蓝还够）。
   *
   * 跑步最早是按住 Shift、不花任何代价，所以它根本不是一个决定。后来做成技能（见 skills.ts
   * 的 sprint），按住就扣蓝，蓝空了自己落回走路。现在键位是 R（Shift 也留着），**代价也留着** ——
   * 免费的跑步是一个没人会拒绝的选项，而没有代价的选项不是决定。
   */
  sprinting = false;

  /**
   * 这一帧疾走还撑着（键按着、没进冷却、蓝也够）。
   *
   * 和 `sprinting` 分开是因为站着不动的时候这两件事不一样：姿态还撑着（松手才算结束），
   * 但人没在跑 —— 跑步买的是位移，原地按着不该烧蓝，也不该把自动攻击停下来。
   * 不分开的话还会多一个坑：跑着跑着松一下方向键就读作"技能结束"，当场挂上五秒冷却。
   */
  private sprintEngaged = false;

  /**
   * 这一帧朝向锁着谁。null = 附近没人。
   *
   * 记住它只为一件事：粘性（见 AIM_SWITCH_STICK）。持有的是一个可能已经被回收成无骨架数据
   * 的 Character，但那不会出问题 —— 被回收的人早就在画面之外，下一帧的距离判定自然把他扔掉。
   */
  private aimTarget: Character | null = null;

  /**
   * 这一帧还开着的按住型技能。冷却从它们的**下降沿**起算（见 trackSustain）。
   */
  private readonly sustainOpen = new Set<SkillId>();

  /**
   * 按住型技能的冷却：**从它释放完毕那一帧起算**，和键弹没弹无关。
   *
   * 盯的是下降沿而不是某一个具体原因：松手是这招结束了，蓝用完也是这招结束了，死了、
   * 被突进打断同理。对玩家来说就是一件事 —— "这招收了"，收了就开始数秒。分成几种情况各算
   * 各的，玩家只会觉得那个数字时有时无。
   */
  /**
   * 这一帧正按着某个持续型技能（法相、疾走）。
   *
   * 给 HUD 看：**这期间不弹牌**。三选一一弹就接管键盘、停住战斗，而按住型的招正是靠"手一直按着"
   * 维持的 —— 弹在脸上就是把他正在放的招提前结束掉。牌记下来等就行了，行情不会因为晚两秒而变；
   * 撑到一半被提前提断则是玩家真会意识到的一下。
   *
   * 不用担心卡死：两招都在持续扣蓝，按不了多久就会自己断。
   */
  get sustaining(): boolean {
    return this.sustainOpen.size > 0;
  }

  private trackSustain(id: SkillId, open: boolean): void {
    if (open) {
      this.sustainOpen.add(id);
      return;
    }
    if (this.sustainOpen.delete(id)) this.skillLoadout.consume(id);
  }

  /**
   * 这一招正放着。
   *
   * HUD 拿它决定这一格怎么画：**置灰但没有数字可数**。放着的时候数字本来就不存在 ——
   * 能再撑多久只看蓝条，写一个不动的 5.0 在那儿是假消息。收招之后数字才出现并开始跑。
   */
  skillHolding(id: SkillId): boolean {
    return this.sustainOpen.has(id);
  }

  /** 突进：还剩多久、朝哪个方向冲。null = 没在冲。 */
  private lunge: {
    left: number;
    heading: number;
    speed: number;
    power: number;
    /** 发招那一刻的技能等级倍率（见 SkillLoadout.damageScale）。 */
    scale: number;
    /** 收招时补的那一圈的半径，世界单位。0 = 不补。 */
    finishRing: number;
    /** 这一帧移动**之前**在哪儿。判定要按走过的那一整段算，不是按落点。 */
    fromX: number;
    fromY: number;
  } | null = null;

  /**
   * 金钟罩：一个跟着玩家走的罩子，碰到的人全飞。
   *
   * 公开是给 Scene 画的 —— 它和别的技能不一样，不是一瞬间的事件而是一段**持续的状态**，
   * 特效系统里"放出去就不管了"的冲击弧表达不了它，得每帧跟着人重画。
   */
  aegis: { left: number; total: number; radius: number; power: number; scale: number } | null = null;

  /**
   * 天地法相：持续判定跟着玩家走；公开状态只供 Scene 同步上半身外壳。
   *
   * `held` 是这一招和金钟罩的分水岭：按着就一直续命（每帧把 left 顶回满并扣蓝），松手立刻
   * 转成收势，`left` 自己走完那零点三五秒。Scene 拿 left/total 画收放，所以按住时那个壳
   * 一直是满的，松手才缩回去。
   */
  dharma: {
    left: number; total: number; radius: number; power: number; scale: number;
    held: boolean;
    /**
     * 已经在收了，再也续不回来。
     *
     * 这一条是为了**让它真的会停**。没有它的时候，蓝见底那一刻会发生一件很蠢的事：扣不动了
     * 就走收势，可收势那零点三五秒里回蓝仍然在涨，攒够一帧的开销又续回满 —— 于是法相钉在
     * 一点蓝上，一边闪一边永远不结束。闩上之后，收势一开始就是单程的；想再开就是重新按一次，
     * 重新付起手价。
     */
    fading: boolean;
  } | null = null;

  /**
   * 神兵天降：召出来的那一排金身重甲兵，一个一条。
   *
   * 和别的技能状态不一样，这里存的是**真的 Character**：同一份骨架、同一套步态、同一杆锁死
   * 的长矛（UnitPresets.bulwark）。不另做一个"金色的形状"有两个理由 —— 玩家在人堆里已经认得
   * 这个轮廓，而且步态、朝向、盾的转向这些东西照抄一遍迟早会和真正的重甲兵长得不一样。
   *
   * 数组而不是单个状态：一次放出去一到五个，各自走各自的直线、各自结算、各自收尾。公开给
   * Scene 画（drawHeavenGuard）。
   */
  readonly heavenGuards: HeavenGuard[] = [];

  /**
   * 磐石那几颗绕着人转的流星：转到哪个角度了，一共几颗。
   *
   * 公开给 Scene 画。只存一个角度而不是每颗一份坐标：它们是**等分**在同一条轨道上的，第 i
   * 颗的角度就是 angle + i × 2π / count，位置每帧现算。存一份状态就没有"画出来的和打人的
   * 差半个身位"这种事 —— 两边读的是同一个数。
   *
   * count 为 0 表示这一局还没拿到磐石。
   */
  readonly orbit = { angle: 0, count: 0, radius: 0 };

  /** 开天：柄的位置沿施放时的行走朝向推进；Scene 用同一状态画穿云剑模型。 */
  heavenSplit: {
    age: number;
    left: number;
    total: number;
    x: number;
    y: number;
    heading: number;
    speed: number;
    power: number;
    /** 发招那一刻的技能等级倍率（见 SkillLoadout.damageScale）。 */
    scale: number;
  } | null = null;

  /** 穿云箭：升空后在第 0.8 秒选定当前视口内的落点，再从天而降。Scene 只读这个状态来画箭。 */
  skyArrow: {
    age: number;
    targetX: number;
    targetY: number;
    radius: number;
    power: number;
    scale: number;
  } | null = null;

  /**
   * 场上还活着的首领在哪儿。小地图拿它标骷髅头。
   *
   * 每帧现筛而不是另外维一份名单：场上最多十几个首领，而维一份名单就要处理死亡、回收、重开三条路。
   */
  /**
   * 这一局的结果。'none' = 还在打。
   *
   * 和 `defeated`（人倒了）分开：那一条是玩家死了，这一条是任务成不成。两者都会把一局收掉，
   * 但结算画面上该写的话不一样。
   */
  outcome: 'none' | 'won' | 'lost' = 'none';

  /** 场上这批首领要在这个时刻之前清完。0 = 没有在计时。 */
  private bossDeadline = 0;
  /** 这一秒里共扣了多少蓝，攒满一秒飘一个数（见 advanceMpFloat）。 */
  private spentMp = 0;
  /**
   * 上一秒掉了多少血，留给屏幕四周那一下红。读一次就清（takeHurtPulse）。
   *
   * 和头顶那个数字同一个时机、同一个节奏：两边说的本来就是同一件事，分开跑会错开成两件。
   */
  private hurtPulse = 0;
  /** 饮血这一秒回了多少血。和掉血扣蓝同一个节奏飘字。 */
  private drainedHp = 0;
  /** 同理，这一秒里挨了多少伤害。 */
  private tookHp = 0;
  private floatSince = 0;

  /**
   * 清完场上这批首领还剩多少秒。0 = 没在倒数。
   *
   * HUD 拿它画那一行红字。只在真的有首领站在场上时才给数 —— 一个倒数着却不知道在催什么的
   * 钟比没有铟更糟。
   */
  get bossCountdown(): number {
    if (this.outcome !== 'none' || this.bossDeadline <= 0 || !this.bossAlive) return 0;
    return Math.max(0, this.bossDeadline - this.runTime);
  }

  /** 倒数的是最后一批吗。最后那一批才值得把字排大、变红。 */
  get finalStand(): boolean {
    return this.waves.lastWaveOver;
  }

  /** 场上还有活着的首领。 */
  get bossAlive(): boolean {
    return this.enemies.some((e) => e.alive && e.boss);
  }

  get bossPositions(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const e of this.enemies) {
      if (e.alive && e.boss) out.push({ x: e.x, y: e.y });
    }
    return out;
  }

  /** 生命上限顶到了"无敌"那一档没有。面板要显示成文字，不是一串九。 */
  get invincible(): boolean {
    return this.player.maxHp >= INVINCIBLE_HP;
  }

  /**
   * 调生命上限，沿 HP_SCALE_LADDER 走一格，并把血补满。
   *
   * 调的是**倍率**不是绝对值：血量上限由角色和等级算出来（见 game/stats.ts），写死一个
   * 绝对值会把那份结算整个盖掉，换个角色进来还是那个数。
   *
   * 补满是有意的：调血量只在调试时用，留着半管血继续打没有意义，还会让"改完之后到底死没死"
   * 变成两个变量的事。
   */
  nudgeMaxHp(delta: number): void {
    let at = HP_SCALE_LADDER.indexOf(this.hpScale);
    if (at < 0) {
      at = HP_SCALE_LADDER.findIndex((v) => v >= this.hpScale);
      if (at < 0) at = HP_SCALE_LADDER.length - 1;
    }
    this.hpScale = HP_SCALE_LADDER[clamp(at + delta, 0, HP_SCALE_LADDER.length - 1)];
    this.applyPlayerStats();
    this.player.hp = this.player.maxHp;
  }

  // ---------------------------------------------------------------- 属性

  /**
   * 玩家现在是谁、几级、这一局又临时拿了什么。
   *
   * 这三样是玩家属性的全部输入，任何一样变了都要重算一次（applyPlayerStats）。等级和角色
   * 由 main 从存档里取（game/profile.ts），局内加成由灵石三选一给。
   */
  private hero: HeroDef = Heroes[0];
  private heroLevel = 1;
  private runBonus: StatBonus = {};

  /** 生命上限的调试倍率。见 nudgeMaxHp。 */
  private hpScale = 1;

  /**
   * 刚用过药或符之后的那一下发光还剩多久，秒。
   *
   * 公开给 Scene：它把这一下画成玩家身上一层短暂的提亮和更厚的轮廓光。和铁布衫那层呼吸是
   * 两回事 —— 那个是"我一直带着这个护身技"，这个是"我刚才按了一下"，所以它必须快、必须一闪
   * 就过去，否则两者会读成同一件事。
   */
  itemFlash = 0;

  /**
   * 正在生效的符，以及各自还剩几秒。
   *
   * 和 runBonus 分开：那一份是抽牌拿的，一局之内不会走；这些是**会过期**的，所以每次有一条
   * 到期都得把属性整个重算一遍。做成数组而不是把加成合并进一个值，是因为同一张符可以叠两次，
   * 而到期是分开到期的 —— 合并之后就没法把先到期的那一份减回去了。
   */
  private readonly timedBonuses: { bonus: StatBonus; left: number }[] = [];
  /**
   * 正开着的符都有哪几张。
   *
   * 单独记一份而不是去翻 timedBonuses：那一排里只有一包包属性，早就不知道自己是从哪张符
   * 来的了。而聚宝符这种改**规则**的符必须能被按名字问到。
   */
  private readonly timedCharms = new Map<string, number>();

  /**
   * 正在慢慢回的那几口药，以及各自还剩几秒、离下一跳还差多久。
   *
   * 和 timedBonuses 分开：那一份改的是属性，到期要重算；这一份只是每隔一秒往血蓝里加一笔，
   * 到期什么也不用收拾。可以同时喝好几口，各回各的 —— 合并成一个速率会让先喝的那口提前结束。
   */
  private readonly regens: { hp: number; mp: number; left: number; since: number }[] = [];

  /**
   * 快捷栏那几格：每格装的是哪一件、装了几个。**格位按先后顺序占，不是按物品表钉死的。**
   *
   * 先捡到的先占前面的格子。钉死格位在只有四件东西时还行，可东西会越加越多（以后还有别的
   * 药和别的符），钉死就意味着永远只有前四种能被拿到，后面的全是摆设。按先后排之后，四格
   * 装的就是"这一局你身上有什么"。
   *
   * **放在这里而不是 HUD 里**：它和血、蓝、技能等级一样是这一局的状态，HUD 只是每帧把它画
   * 出来。放在界面里的后果是"还收不收得下"这件事战斗那边问不到。
   */
  private readonly itemSlots: ({ id: string; count: number } | null)[] =
    new Array(ITEM_SLOT_COUNT).fill(null);

  /** 第 n 格装的是哪一件。空格返回 null。 */
  itemAt(slot: number): { id: string; count: number } | null {
    return this.itemSlots[slot] ?? null;
  }

  /**
   * 这一件现在收不收得下。
   *
   * 三种情况：已经有这一件而且没摞满 —— 收；没有这一件但还有空格 —— 收，占一个新格子；
   * 格子全被别的东西占着 —— **不收**，让它留在草地上。
   *
   * 让它留着而不是收下来再丢掉：后者玩家完全不知道刚才发生了什么，只看到一件东西凭空消失。
   */
  acceptsItem(id: string): boolean {
    const held = this.itemSlots.find((entry) => entry?.id === id);
    if (held) return held.count < ITEM_STACK_MAX;
    return this.itemSlots.some((entry) => entry === null);
  }

  /**
   * 把一批补给发到快捷栏里。进图那一刻调一次（见 main 的 enterMap）。
   *
   * 走 takeItem 而不是直接写格子：摧满、格子不够那几条规矩只应该存在一份。
   */
  grantItems(items: { id: string; count: number }[]): void {
    for (const entry of items) {
      for (let i = 0; i < entry.count; i++) this.takeItem(entry.id);
    }
  }

  private takeItem(id: string): void {
    const held = this.itemSlots.find((entry) => entry?.id === id);
    if (held) {
      held.count = Math.min(ITEM_STACK_MAX, held.count + 1);
      return;
    }
    const free = this.itemSlots.indexOf(null);
    if (free < 0) return;
    this.itemSlots[free] = { id, count: 1 };
  }

  /**
   * 用掉第 n 格里的一件。
   *
   * 先看有没有、再看用不用得上，两条都过了才扣 —— 反过来的话按一下就少一个，而什么都没发生。
   * 用完最后一件，这一格**空出来**：它本来就不属于哪一件东西，下一件捡到的可以占。
   */
  useItemAt(slot: number): boolean {
    const held = this.itemSlots[slot];
    if (!held || held.count <= 0) return false;
    if (!this.applyPickup(held.id)) return false;
    held.count--;
    if (held.count <= 0) this.itemSlots[slot] = null;
    return true;
  }

  /**
   * 当前法力。主动技能的开销从这里出，自己按 stats.mpRegen 每秒回一点。
   *
   * 公开只读：HUD 要画那条蓝条，而按键能不能按得动由 Battle 自己说了算（canAfford）——
   * 界面读到的是"够不够"这个结论，不是自己拿两个数去比。
   */
  private currentMp = 0;

  get mp(): number {
    return this.currentMp;
  }

  get maxMp(): number {
    return this.player.stats.maxMp;
  }

  /**
   * 这一招的蓝够不够。HUD 用它决定要不要把那一格置灰，和冷却是同一种置灰。
   *
   * 不耗蓝的技能（自动攻击、自动发射、被动）永远返回 true —— 它们的 mpCost 是 0。
   */
  canAfford(id: SkillId): boolean {
    const skill = skillById(id);
    // 按住型的技能没有起手价，只有每秒的开销。"够不够"对它的意思是"还撑不撑得住一下"——
    // 这里按四分之一秒算，蓝低于那个数就置灰，玩家按下去也只会跑一眨眼。
    const scale = this.skillLoadout.mpScale(id);
    if (skill.kind === 'sustained') return this.currentMp >= skill.mpDrain * scale * 0.25;
    return this.currentMp >= skill.mpCost * scale;
  }

  /** 扣蓝。不够就一点都不扣，返回 false —— 扣一半是最糟的那种结果。 */
  private spendMp(amount: number): boolean {
    if (amount <= 0) return true;
    if (this.currentMp < amount) return false;
    this.currentMp -= amount;
    this.spentMp += amount;
    return true;
  }

  /**
   * 玩家这一秒里掉了多少血、扣了多少蓝，各飘一个数。
   *
   * **不能一下一个。** 疾走和法相是按帧扣的，末波挨打也是每秒十几下 —— 那不是反馈是噪声，
   * 而且会把全局九十六个的数字池吃光；
   * 而一秒一个恰好和慢回的丹那边是同一个节奏（见 REGEN_TICK），两边读起来是一件事。
   */
  private advancePlayerFloats(dt: number): void {
    this.floatSince += dt;
    if (this.floatSince < REGEN_TICK) return;
    this.floatSince = 0;
    const hp = Math.round(this.tookHp);
    const mp = Math.round(this.spentMp);
    const drained = Math.round(this.drainedHp);
    this.tookHp = 0;
    this.spentMp = 0;
    this.drainedHp = 0;
    // 饮血回的血走 heal 那一档加号，和喝药同一个形状 —— 对玩家来说它们本来就是同一件事。
    if (drained >= 1) this.floatGain(drained, 'heal', 'plus', 'HP');
    /*
     * 和吃药那两串用**同一档颜色**，只是符号相反：回血是血+120，掉血就是血-120。
     *
     * 先把掉血接到了 damage 那一档的白转橙，换掉了：白转橙是**满地都是的那种数字**，
     * 让玩家得先分辨“这一个是从我头上冒的”再读它。而血量只有一个颜色的话，颜色直接就是
     * “这说的是我的血”，剩下只要看一眼符号就知道是加是减。蓝同理。
     */
    if (hp >= 1) {
      this.floatGain(hp, 'heal', 'minus', 'HP');
      this.hurtPulse = hp;
    }
    if (mp >= 1) {
      this.floatGain(mp, 'mana', 'minus', 'MP');
    }
  }

  /**
   * 这一秒掉了多少血。读一次就清 —— 屏幕四周那一下红只该为一次扣血闪一遍。
   */
  takeHurtPulse(): number {
    const pulse = this.hurtPulse;
    this.hurtPulse = 0;
    return pulse;
  }

  /**
   * 这张图对敌人的加成。换图时由 main 传进来，出兵那一侧每算一个敌人都要乘它。
   *
   * 默认中性（全是 1），所以离线脚本不设置它也能跑。
   */
  private modifier: MapModifier = NEUTRAL_MODIFIER;

  /**
   * 商店买的根基，属性的**第四层**。由 main 从存档里取一份交进来。
   *
   * 和局内那些加成分开放：那些打完就清（runBonus、timedBonuses），这一包是带着进来的。
   * 混在一起的话，重开一局清局内加成那一下会把玩家买的东西一起清掉。
   */
  rootBonus: StatBonus = {};

  /**
   * 这一局挣到的经验。一局打完由 main 一次性结进存档。
   *
   * 局内也在用它升级（见 gainExp），两者不冲突：存档那一侧拿到的是**总数**，重放一遍会得到
   * 同一个等级。分开记是因为打到一半退出去不该白打，而存档不该每杀一个人写一次磁盘。
   */
  earnedExp = 0;

  /** 当前这一级已经攒了多少经验。HUD 的经验条画的就是它。 */
  private levelExp = 0;

  get expIntoLevel(): number {
    return this.levelExp;
  }

  /** 这一级还要多少经验才升。满级时给 1，让经验条停在满格而不是除以无穷。 */
  get expForLevel(): number {
    const need = expToNextLevel(this.heroLevel);
    return Number.isFinite(need) ? need : 1;
  }

  /** 这一局在打的那个角色。三选一那边要拿它画牌面上的台子。 */
  get heroDef(): HeroDef {
    return this.hero;
  }

  get heroId(): string {
    return this.hero.id;
  }

  get level(): number {
    return this.heroLevel;
  }

  /**
   * 换角色，并开一局：形象、属性、技能一起换。
   *
   * **技能只给一个自动攻击技和 R 上的疾走**，别的全靠局内抽牌拿。这是这一版定下来的开局
   * 状态：主动技三个空槽、发射技零个、护身技零个。
   *
   * @param level        这个角色在存档里的等级。每个角色各记各的，见 Profile。
   * @param expIntoLevel 当前这一级已经攒了多少经验，HUD 的经验条要画它。
   */
  setHero(hero: HeroDef, level: number, expIntoLevel = 0): void {
    this.hero = hero;
    this.heroLevel = Math.max(1, Math.floor(level));
    this.levelExp = Math.max(0, expIntoLevel);
    this.runBonus = {};
    this.player.def = unitAppearance(hero.appearance);
    this.presetIndex = PlayerPresets.findIndex((preset) => preset.id === hero.appearance);
    if (this.presetIndex < 0) this.presetIndex = 0;
    this.skillLoadout.startRun(hero.attackSkill, hero.startGuard ?? null);
    this.applyPlayerStats();
    this.player.hp = this.player.maxHp;
    this.currentMp = this.player.stats.maxMp;
  }

  /**
   * 把一个技能升一级。灵石收满弹出的三选一走这条路，一局之内有效。
   *
   * 等级只改两样：作用距离和法力开销。不改冷却也不改动作时长 —— 那两个改的是节奏，而一招的
   * 节奏是它的身份。
   */
  upgradeSkill(id: SkillId): boolean {
    if (!this.skillLoadout.raiseLevel(id)) return false;
    // 护身技那一包加成是算进属性里的，升一级得当场重算一遍。
    if (skillById(id).category === 'guard') this.refreshPassiveStats();
    return true;
  }

  /** 这一局还能升的技能：装备着、还没满级。三选一里"升级"那一类的货架。 */
  upgradableSkills(): SkillId[] {
    return this.skillLoadout.upgradable().map((skill) => skill.id);
  }

  /**
   * 这一局还没拿到的招。三选一里"获取"那一类的货架。
   *
   * 主动槽满了就不再出主动技 —— 抽到一张装不上的牌是最扫兴的一种结果。
   */
  obtainableSkills(): SkillId[] {
    const slotsFull = this.skillLoadout.activeSkillSlots.every((id) => id !== null);
    // 已经戴着一张护身技了就不再上护身牌。护身只有一格（SkillCategoryRules 的 guard），
    // 再抽一张是把手上那张连同它练出来的等级一起换掉 —— 牌面上写的是"获得"，而实际发生的
    // 是一次没写在牌上的损失。哪一张先露面就是哪一张，这就是护身那一格全部的选择。
    const hasGuard = this.skillLoadout.guardSkill !== null;
    return runSkillPool().filter((id) => {
      if (hasGuard && skillById(id).category === 'guard') return false;
      if (this.skillLoadout.isEquipped(id)) return false;
      return !(slotsFull && skillById(id).category === 'active');
    });
  }

  /** 拿到一招。抽牌选了"获取"就走这条路，一局之内有效。 */
  obtainSkill(id: SkillId): boolean {
    if (!runSkillPool().includes(id)) return false;
    if (!this.skillLoadout.setEquipped(id, true)) return false;
    // 护身技那一包加成是算进属性里的，拿到手当场重算一遍。
    if (skillById(id).category === 'guard') this.refreshPassiveStats();
    return true;
  }

  private refreshPassiveStats(): void {
    const before = this.player.maxHp;
    this.applyPlayerStats();
    if (this.player.maxHp > before) this.player.hp += this.player.maxHp - before;
  }

  skillLevel(id: SkillId): number {
    return this.skillLoadout.level(id);
  }

  /**
   * 这一局临时拿到的属性加成（灵石收满那个三选一）。跨局不保留。
   *
   * 加成是**相加再乘一次**的：拿两张 +15% 攻击是 +30%，不是 +32.25%。见 applyBonuses。
   */
  addRunBonus(bonus: StatBonus): void {
    for (const key of Object.keys(bonus) as (keyof UnitStats)[]) {
      this.runBonus[key] = (this.runBonus[key] ?? 0) + (bonus[key] ?? 0);
    }
    const before = this.player.maxHp;
    this.applyPlayerStats();
    // 血上限涨了就把涨的那一截补上，但不治疗已经掉的血 —— 一张属性卡不该同时是一瓶药。
    if (this.player.maxHp > before) this.player.hp += this.player.maxHp - before;
  }

  /**
   * 吃下一份经验，够了就当场升级。
   *
   * 局内就升而不是等结算：升级会改属性（攻击、血、速度全在长），而一局有二十多分钟 —— 攒到
   * 最后一起结算的话，这一整局玩家的强度是平的，练级在游戏里就看不见了。
   *
   * 升级把涨出来的血补上，但不治疗已经掉的血。升级是变强，不是喝药。
   */
  private gainExp(amount: number): void {
    if (amount <= 0) return;
    this.earnedExp += amount;
    if (this.heroLevel >= MAX_LEVEL) return;
    this.levelExp += amount;
    const leveledFrom = this.heroLevel;
    let leveled = false;
    while (this.heroLevel < MAX_LEVEL) {
      const need = expToNextLevel(this.heroLevel);
      if (this.levelExp < need) break;
      this.levelExp -= need;
      this.heroLevel++;
      leveled = true;
    }
    if (!leveled) return;
    if (this.heroLevel >= MAX_LEVEL) this.levelExp = 0;
    const before = this.player.maxHp;
    this.applyPlayerStats();
    if (this.player.maxHp > before) this.player.hp += this.player.maxHp - before;
    /*
     * 头顶飘一串金字：LV+1。
     *
     * 升级以前一点提示都没有 —— 只有左下角经验条归零、面板上那个数字变了。而玩家的
     * 眼睛一直在屏幕中间，两样都看不到。升级当场加属性、把涨出来的血补满 —— 发生了这么大
     * 一件事，却没有任何一帧画面说过它。
     *
     * 连升几级也只飘一串，写升了几级：一次飘三个 "LV+1" 叠在头顶读不出来，而 "LV+3"
     * 正好是玩家要知道的那件事。
     */
    this.floatGain(this.heroLevel - leveledFrom, 'level', 'plus', 'LV');
  }

  /**
   * 抽牌拿的加成，加上还在生效的那几张符，合成一份。
   *
   * 同一项上的多个来源是相加再乘一次（见 applyBonuses 那段），所以这里也只是把数加起来。
   */
  /** 这一张符正开着吗。聚宝符那种改规则而不改属性的符靠它问。 */
  private hasCharm(id: string): boolean {
    return this.timedCharms.has(id);
  }

  private mergedBonus(): StatBonus {
    const out: StatBonus = { ...this.rootBonus };
    for (const key of Object.keys(this.runBonus) as (keyof UnitStats)[]) {
      out[key] = (out[key] ?? 0) + (this.runBonus[key] ?? 0);
    }
    for (const entry of this.timedBonuses) {
      for (const key of Object.keys(entry.bonus) as (keyof UnitStats)[]) {
        out[key] = (out[key] ?? 0) + (entry.bonus[key] ?? 0);
      }
    }
    return out;
  }

  /**
   * 用掉一件药或符。
   *
   * 药立刻回一截血或蓝，按**上限的比例**给 —— 血量上限从一级的一千二长到满级的两千三，绝对
   * 值定的药到后期就是一口水。符挂上一个带时限的加成，上限涨出来的那一截当场补满，所以坚壁
   * 符同时也是半瓶药。
   *
   * @returns 这件东西有没有真的生效。界面靠它决定要不要扣掉一格。
   */
  applyPickup(id: string): boolean {
    const def = pickupById(id);
    if (!def || !this.player.alive) return false;
    if (def.regen && def.duration > 0) {
      this.regens.push({
        hp: def.regen.hp ?? 0,
        mp: def.regen.mp ?? 0,
        left: def.duration,
        // since 给满一跳：喝下去**立刻**回第一口，而不是干等一秒才看到第一个数。
        since: REGEN_TICK,
      });
    }
    if (def.restore) {
      if (def.restore.hp) {
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * def.restore.hp);
        this.floatGain(this.player.hp - before, 'heal', 'plus', 'HP');
      }
      if (def.restore.mp) {
        const before = this.currentMp;
        this.currentMp = Math.min(this.player.stats.maxMp, this.currentMp + this.player.stats.maxMp * def.restore.mp);
        this.floatGain(this.currentMp - before, 'mana', 'plus', 'MP');
      }
    }
    if (def.buff && def.duration > 0) {
      const beforeHp = this.player.maxHp;
      const beforeMp = this.player.stats.maxMp;
      this.timedBonuses.push({ bonus: def.buff, left: def.duration });
      this.timedCharms.set(def.id, Math.max(this.timedCharms.get(def.id) ?? 0, def.duration));
      this.applyPlayerStats();
      // 上限涨出来的那一截当场补满。不补的话"生命上限 +25%"在满血时什么也没发生，读起来像
      // 一张废牌，而到期缩回去时反倒会掉一截血。
      if (this.player.maxHp > beforeHp) this.player.hp += this.player.maxHp - beforeHp;
      if (this.player.stats.maxMp > beforeMp) this.currentMp += this.player.stats.maxMp - beforeMp;
      /*
       * 符飘的是**加成的百分比**，不是秒数。
       *
       * 先飘过秒数，换掉了：那个数配不上任何一个符号 —— 加号会被读成"回了十二点"，乘号会
       * 被读成"十二倍"。而百分比配乘号正好："×18"就是那一项乘了 1.18。撑多久这件事左下角
       * 那条计时一直在倒数，不需要飘字再说一遍。
       *
       * 一张符带好几项加成时取**最大**的那一个：飘一串数字没人读得完，而玩家真正要知道的是
       * "这一下有多狠"，那就是最大的那一项。具体哪几项在牌面和物品说明上写着。
       */
      let best = 0;
      let bestKey: keyof StatBonus | null = null;
      for (const [key, value] of Object.entries(def.buff) as [keyof StatBonus, number | undefined][]) {
        if ((value ?? 0) > best) {
          best = value ?? 0;
          bestKey = key;
        }
      }
      this.floatGain(Math.round(best * 100), 'buff', 'times', BONUS_LABEL[bestKey ?? 'attack'] ?? 'ATK');
    }
    this.itemFlash = ITEM_FLASH_TIME;
    // 不放光环。
    //
    // 试过在脚下推开一圈，撤了：那个形状是这套游戏里**技能**的语言 —— 横扫、回旋、金钟罩、
    // 突进收招，推开的圈全是"我打了一下"。用药借同一个形状，画面上就成了又放了一招，而它
    // 恰恰不是。身上那一层短促的提亮加头顶飘出来的数，说的已经是同一件事，而且只说这一件。
    return true;
  }

  /**
   * 头顶飘一个数。
   *
   * 走的是打人那套飘字（DamageNumbers），只是换了颜色 —— 同一个地方冒出来的数字用同一套画法，
   * 玩家不用学第二种读法。颜色是唯一的区别，而那正好就是"这是好事还是坏事"。
   */
  /**
   * 一项属性在头顶飘字里叫什么。
   *
   * 一张符带好几项加成时取最大的那一项来标 —— 飘一串数字没人读得完，而玩家真正要知道的是
   * "这一下最狠的是哪一项"。具体哪几项在牌面和物品说明上写着。
   */
  private floatGain(
    value: number,
    style: 'heal' | 'mana' | 'buff' | 'level',
    sign: 'plus' | 'times' | 'minus',
    label: DamageNumberLabel,
  ): void {
    if (value < 1) return;
    // follow：这一下发生在**玩家身上**，不是发生在地上某一点。他一边跑一边回，数字得跟着他
    // 走，否则就是掉在身后的一串数。以后的持续回血、回蓝药更要靠这一条。
    //
    // z 比头顶再高一截：这一串说的是玩家自己，要从满地的伤害数字里抬出来。
    this.damageNumbers.spawn(this.player.x, this.player.y, value, {
      style, sign, label, follow: true, z: PLAYER_FLOAT_Z,
    });
  }

  /**
   * 慢慢回那种药：每隔一秒回一口，头顶飘一个数。
   *
   * 按**跳**给而不是每帧按 dt 给：每帧回 0.6 点血是看不见的，玩家只会发现血条自己在长，
   * 而不知道那是刚才那口药。一秒一个数字飘上去，"我还在回血"这件事才是明说的 —— 那几个数
   * 跟着人走（见 floatGain 的 follow），所以边跑边回也读得出来。
   */
  private advanceRegens(dt: number): void {
    if (this.regens.length === 0) return;
    for (let i = this.regens.length - 1; i >= 0; i--) {
      const r = this.regens[i];
      const step = Math.min(dt, r.left);
      r.left -= dt;
      r.since += step;
      if (r.since >= REGEN_TICK) {
        r.since -= REGEN_TICK;
        if (r.hp > 0) {
          const before = this.player.hp;
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + this.player.maxHp * r.hp);
          this.floatGain(this.player.hp - before, 'heal', 'plus', 'HP');
        } else if (r.hp < 0) {
          /*
           * 负的那一支：狂暴的持续掉血。
           *
           * 走同一条路而不是另开一套：它要的就是"每秒扣一口、头顶飘个数"，和回血是同一件事
           * 的两个方向。**掉不死人，最低留一点** —— 被自己的增益技耐死读不出是一个决定的后果，
           * 只读得出"这个技能坑我"。风险还在（卡在一点就是一下就没），但最后那一下总是别人打的。
           */
          const before = this.player.hp;
          this.player.hp = Math.max(1, this.player.hp + this.player.maxHp * r.hp);
          this.tookHp += before - this.player.hp;
        }
        if (r.mp > 0) {
          const before = this.currentMp;
          this.currentMp = Math.min(
            this.player.stats.maxMp,
            this.currentMp + this.player.stats.maxMp * r.mp,
          );
          this.floatGain(this.currentMp - before, 'mana', 'plus', 'MP');
        }
      }
      if (r.left <= 0) {
        this.regens[i] = this.regens[this.regens.length - 1];
        this.regens.pop();
      }
    }
  }

  /** 符的倒计时。到期一条就把属性重算一遍。 */
  private advanceTimedBonuses(dt: number): void {
    for (const [id, left] of this.timedCharms) {
      if (left - dt > 0) this.timedCharms.set(id, left - dt);
      else this.timedCharms.delete(id);
    }
    if (this.timedBonuses.length === 0) return;
    let expired = false;
    for (let i = this.timedBonuses.length - 1; i >= 0; i--) {
      this.timedBonuses[i].left -= dt;
      if (this.timedBonuses[i].left > 0) continue;
      this.timedBonuses[i] = this.timedBonuses[this.timedBonuses.length - 1];
      this.timedBonuses.pop();
      expired = true;
    }
    // 上限缩回去之后血和蓝要跟着夹住，applyPlayerStats 里已经做了。
    if (expired) this.applyPlayerStats();
  }

  /** 重算玩家属性并挂到 Character 上。角色、等级、局内加成、调试倍率任何一个变了都要跑一次。 */
  private applyPlayerStats(): void {
    const guard = this.skillLoadout.guardSkill;
    const stats = resolveHeroStats(
      this.hero,
      this.heroLevel,
      this.mergedBonus(),
      // 手上那张护身技是哪一张、练到几级。没有就传 null，那一包加成整个不算。
      guard,
      guard ? this.skillLoadout.level(guard) : 0,
    );
    this.player.stats = stats;
    this.player.walkSpeed = stats.moveSpeed;
    this.player.maxHp = this.hpScale === Number.POSITIVE_INFINITY
      ? INVINCIBLE_HP
      : Math.round(stats.maxHp * this.hpScale);
    this.player.hp = Math.min(this.player.hp, this.player.maxHp);
    // 蓝上限涨了（升级、拿卡）不补满，只是夹住 —— 和血一样，变强不等于回复。
    this.currentMp = Math.min(this.currentMp, stats.maxMp);
  }

  /** 这张图对敌人的加成。换图时调一次。 */
  setMapModifier(modifier: MapModifier): void {
    this.modifier = modifier;
  }

  /** 一个兵种在当前这一波、这张图上的属性。出兵那一侧每放一个人都要算一次。 */
  private enemyStats(kind: ResolvedUnitKind): UnitStats {
    return resolveEnemyStats(kind, this.waves.waveNumber, this.modifier);
  }

  /**
   * 这个敌人两次出手之间等多久，秒。
   *
   * 弓手和近战本来就是两个量级（放箭要给箭留飞行时间），所以基准分两档；攻击频率那项属性
   * 除在它上面 —— 波次越往后，同一个兵出手越密。
   */
  private enemySwingGap(def: UnitDef, stats: UnitStats): number {
    const base = def.weapon === 'bow' ? ENEMY_ARCHER_SHOT_GAP : ENEMY_SWING_GAP;
    return base / Math.max(0.2, stats.attackSpeed);
  }

  /**
   * 一个出怪间隔里放几个人进来。菜单里那个 [− 出兵 xN +]。
   *
   * x1 是一个一个挪进画面，往上调就是一小群一小群涌上来。
   *
   * 注意它**不决定场上有多少人** —— 稳态是回收框定的（见 DESPAWN_MARGIN），出兵再快也只是更快
   * 顶到那条线。实测（grain 3 那一档视口下）x8 稳在 1335、x20 稳在 1465，差别很小。这个数真正
   * 影响的是**多快填满**：调到 1 要好几分钟才填满一屏。
   *
   * 默认直接顶满（MAX_SPAWN_BATCH）：这是一个割草游戏，开局前几十秒的空满不是节奏，是等待。
   * 稳态人数仍然是回收框定的（见上一段），所以顶满不会把场上堆得更多。
   */
  spawnBatch = MAX_SPAWN_BATCH;

  private innerCrowdSpacing = CROWD_SPACING;

  /**
   * 人群间距倍率，乘在躯干半宽上。1 就是两个人的躯干圆刚好相切。
   *
   * 调大人堆更松、更读得出个数，调小更挤。夹在上限里是因为 GRID_CELL 是按上限算死的 ——
   * 超过它，分离就会开始漏判边上的人，症状是偶尔两个人穿模，很难查。
   */
  get crowdSpacing(): number {
    return this.innerCrowdSpacing;
  }
  set crowdSpacing(value: number) {
    this.innerCrowdSpacing = clamp(value, 0.2, MAX_CROWD_SPACING);
    // 格子必须跟着交互距离走：小了分离会漏判（偶尔两个人穿模，很难查），大了每次查询白扫
    // 一堆够不着的人。
    this.grid.setMinCellSize(cellSizeFor(this.innerCrowdSpacing));
  }

  /** 调出兵批量。菜单和键盘走同一条路。 */
  nudgeSpawnBatch(delta: number): void {
    this.spawnBatch = clamp(this.spawnBatch + delta, 1, MAX_SPAWN_BATCH);
  }

  /**
   * 分离要跑几趟。
   *
   * 这个数曾经高达 16，因为那时敌人会无视前方一直往里挤，分离是唯一的对抗力量 —— 而位置
   * 松弛一趟只能把每对的重叠推开一半、且"我被推开"要一趟才传给身后那个人，十几排深的人堆
   * 就得十几趟才收敛。现在 slotAhead 让人在挤上之前就停下绕行，压力从源头没了，分离退回成
   * 收尾用的小修补。
   *
   * 实测（同屏 1000）：1 趟还有 3% 的人视觉上叠着，2 趟就是 0%，再往上到 16 趟间距没有任何
   * 变化，只有逻辑时间从 2.5 毫秒涨到 5.1。取 3 是在 2 的基础上留一点余量。
   *
   * 注意这个数和 slotAhead 是一对：哪天把找空位那段去掉，这里必须变回十几趟。
   */
  private get separationPasses(): number {
    return 3;
  }

  /** 这一局回收掉多少人。面板上显示，用来看跑步机转得对不对。 */
  recycled = 0;
  /** 这一局按预留位置放回去多少人。和 recycled 一起看就知道"回头"这件事有没有生效。 */
  restored = 0;

  /** 全图无骨架怪物：继续推进移动的数据，以及离开可见范围的怪物。 */
  private readonly reserved: Reservation[] = [];
  private distantRegionCounts = new Uint32Array(0);

  /** 两种表示共享同一张移动邻居表，视口边界两侧的怪物也能互相避让。每帧复用数组。 */
  private readonly movers: EnemyMover[] = [];
  private readonly movementGrid = new SpatialGrid(cellSizeFor(CROWD_SPACING));
  /** 0 本帧跳过，1 近处逐帧，2 远处本帧轮到（只做一轮分离）。 */
  private movementDue = new Uint8Array(0);
  private farGroup = 0;
  // 按对象绑定分组，数组交换删除不会改组；回收/恢复的新对象首次移动时重新决策。
  private readonly crowdDecisions = new WeakMap<EnemyMover, CrowdDecision>();
  private crowdDecisionGroup = 0;
  private crowdDecisionFrame = 0;

  /** 小地图读取实时位置，不需要访问无骨架怪物的战斗内部状态。 */
  *enemyPositions(): Generator<Readonly<{ x: number; y: number }>> {
    for (const enemy of this.enemies) if (enemy.alive) yield enemy;
    yield* this.reserved;
  }

  /** 小地图用平滑坐标；刷怪密度、激活与碰撞始终使用真实模拟坐标。 */
  *minimapEnemyPositions(): Generator<Readonly<{ x: number; y: number }>> {
    for (const enemy of this.enemies) if (enemy.alive) yield enemy;
    for (const enemy of this.reserved) yield enemy.motion.map;
  }

  get dormantEnemyCount(): number {
    return this.reserved.length;
  }

  /** 包含尸体占用的活跃槽位，确保生成和休眠转换共用同一个硬上限。 */
  get worldEnemyCount(): number {
    return this.enemies.length + this.reserved.length;
  }

  /**
   * 波次面板要的全部东西。每帧读一次，不用它的地方一个字段也不必算。
   *
   * countdown 一个数同时是"距下一波"和"本波还剩"—— 它们本来就是同一段时间，面板上只该有
   * 一个倒计时。
   */
  get waveStatus(): WaveStatus {
    const waves = this.waves;
    return {
      wave: waves.waveNumber,
      waves: waves.waveCount,
      countdown: waves.countdown,
      cleared: waves.cleared,
      crowd: waves.wave.crowd,
      bosses: waves.bossTotal,
      holding: waves.holding,
      pinned: this.pinnedWave,
    };
  }

  /** 换出兵模板（换地图）。会立刻从第一波重新开始，不动场上已有的人。 */
  setSpawnTemplate(template: SpawnTemplate): void {
    this.waves.setTemplate(template);
  }

  /**
   * 跳到第 n 波，并**当场**把屏幕外那片人海补到这一波的预算。调试用。
   *
   * 补这一下是这个方法存在的理由：光跳波号的话，人海还是上一波那么厚，要等区域补怪一点点
   * 涨上来 —— 每两秒最多 64 个，从第一波的 900 涨到第八波的 1200 得四十秒。压力测试的头四十秒
   * 量的就会是上一波，而那正是要测的那一段。补进去的都是屏幕外的无骨架数据，不会有人凭空
   * 出现在画面里，之后靠开波爆兵和跑步机补怪自然涌上来。
   *
   * 往回跳到预算更低的一波不会当场杀人：多出来的那部分靠玩家清场自然掉回预算。
   */
  jumpToWave(waveNumber: number, view: BattleView): void {
    this.waves.jumpTo(waveNumber);
    this.pinnedWave = this.waves.waveNumber;
    this.seedWorld(view);
  }

  /** 跳到最后一波。菜单里那个「末波压测」。 */
  jumpToLastWave(view: BattleView): void {
    this.jumpToWave(this.waves.waveCount, view);
  }

  /**
   * 调试时钉住的波次，0 是不钉。跳过波之后就一直是它，重开也不掉回第一波。
   *
   * 压力测试必然要死很多次，而清场重来会把波次重置 —— 每死一次都得重按一次末波压测，测的
   * 就不是那一波了。钉住之后死了重开还在那一波，人海也照那一波的预算重铺。
   */
  pinnedWave = 0;

  /** 这一局跑了多久，秒。 */
  private clock = 0;

  /** 只读的战斗时间，供不改变战斗状态的呼吸光等连续视觉使用。 */
  get elapsed(): number {
    return this.clock;
  }

  /** 逻辑这一段花掉的毫秒，指数平滑。暂停面板要读。 */
  simMs = 0;

  // 这两个跟着地图换，所以不是 readonly。见 setField。
  private field: Field;
  private worldPopulation: WorldPopulation;
  private spawnTimer = 0;
  /** 按模板发号施令的那个人：只管"这一秒该放几个、放什么"，落点仍在这个文件里算。 */
  private readonly waves = new WaveDirector(DEFAULT_SPAWN_TEMPLATE);
  /** 爆兵允许把场上堆到多少人。开波那一刻记一次，见 localSpawnRoom。 */
  private surgeCeiling = 0;

  /**
   * 邻居查表。每帧重建一次，分离和"把人推出玩家身体"都走它。
   *
   * 它自己按人群的包围盒开表，所以图外那一圈不用特意交代 —— 人走到哪儿，表就盖到哪儿。
   */
  private readonly grid: SpatialGrid;

  constructor(field: Field) {
    this.field = field;
    this.worldPopulation = new WorldPopulation(field.width, field.height, WORLD_ENEMY_SPACING);
    this.grid = new SpatialGrid(cellSizeFor(CROWD_SPACING));
    this.player = new Character(PlayerPresets[0].make(), PALETTE_HERO, HUMAN_PACE);
    this.player.facing = Math.PI * 0.5; // 面朝镜头
    this.player.x = field.width * 0.5;
    this.player.y = field.height * 0.5;
    this.applyPlayerStats();
    this.player.hp = this.player.maxHp;
  }

  /** 玩家加所有敌人。脚印那边要遍历全场，用生成器省掉每帧一个临时数组。 */
  *actors(): Generator<Character> {
    yield this.player;
    yield* this.enemies;
  }

  /**
   * 换一块地。
   *
   * 只换"世界是什么样"，不清场 —— 调用方紧接着一定要 reset(view)，否则上一局的人还站在
   * 新地图的旧坐标上。分两步是因为 reset 需要一份 BattleView，而那份视野得等玩家先被挪到
   * 新场地的中央才算得对。
   *
   * 全图人口表跟着场地尺寸重建：它按格子摊开整张图，尺寸变了那张表就整个不对了。
   */
  setField(field: Field): void {
    this.field = field;
    this.worldPopulation = new WorldPopulation(field.width, field.height, WORLD_ENEMY_SPACING);
    this.player.x = field.width * 0.5;
    this.player.y = field.height * 0.5;
  }

  /**
   * 调试菜单里换一个玩家形象。**只换长相，不换属性** —— 属性跟着角色走（setHero），而这个
   * 旋钮是用来看"这个模型在场上是什么样"的，不是用来换角色的。
   *
   * 血补满：换成小个子之后血条读不出来。
   */
  setPreset(index: number): void {
    if (index < 0 || index >= PlayerPresets.length) return;
    this.presetIndex = index;
    this.player.def = PlayerPresets[index].make();
    this.player.hp = this.player.maxHp;
  }

  /** 清场重来。 */
  reset(view: BattleView): void {
    this.enemies.length = 0;
    // 预留的是"刚才那片人海"，重开之后它不该再长回来。
    this.reserved.length = 0;
    // 锁着的那个人属于上一局。
    this.aimTarget = null;
    this.kills = 0;
    this.bossKills = 0;
    this.deaths = 0;
    this.damageTaken = 0;
    this.hurtPulse = 0;
    this.drainedHp = 0;
    // 尚未到飘字时机的事件也属于上一局，不能在新局重新生成。
    this.tookHp = 0;
    this.spentMp = 0;
    this.floatSince = 0;
    this.earnedExp = 0;
    this.defeated = false;
    this.outcome = 'none';
    this.bossDeadline = 0;
    this.runTime = 0;
    this.recycled = 0;
    this.restored = 0;
    // 跨帧招式和各自冷却一起归零。
    this.resetSkillRuntime();
    // 重开就是重新开一局：抽到的招、练出来的等级、拿到的属性卡全部清空，回到"一个自动攻击
    // 技加一双靴子"。技能和灵石同生共死，留着上一局堆出来的强度就不是重开了。
    this.skillLoadout.startRun(this.hero.attackSkill, this.hero.startGuard ?? null);
    this.runBonus = {};
    this.timedBonuses.length = 0;
    this.timedCharms.clear();
    this.regens.length = 0;
    this.itemSlots.fill(null);
    this.itemFlash = 0;
    this.applyPlayerStats();
    this.enemyArrows.length = 0;
    /*
     * 冲击弧也要抹掉。
     *
     * 弹片、扭曲、伤害数字都在这儿清了，就漏了这一层 —— 于是上一局最后那一招的扇面会
     * 跨过结算和选人界面，在新的一局开场那几帧里接着飘出来。
     */
    this.effects.clear();
    // 金钟罩外面那圈磐石。它不在任何一个粒子池里，是一组每帧重算的坐标 ——
    // 上一局开着罩子死的话，count 会就那么留着。
    this.orbit.count = 0;
    this.orbit.radius = 0;
    this.orbit.angle = 0;
    this.debris.clear();
    this.warp.clear();
    this.damageNumbers.clear();
    this.collectibles.clear();
    this.soundEvents.length = 0;
    this.collectedGems = 0;
    this.collectedCoins = 0;
    this.player.death = -1;
    this.player.hurt = 0;
    this.player.hp = this.player.maxHp;
    this.currentMp = this.player.stats.maxMp;
    this.seed(view);
  }

  /** 清掉已经放出的技能状态与冷却，但保留玩家的装备方案。 */
  private resetSkillRuntime(): void {
    this.skillWaves.length = 0;
    this.lunge = null;
    this.aegis = null;
    this.dharma = null;
    this.heavenSplit = null;
    this.skyArrow = null;
    this.heavenGuards.length = 0;
    this.pendingAttackSkill = this.skillLoadout.attackSkill;
    this.sustainOpen.clear();
    this.sprintEngaged = false;
    this.skillLoadout.resetCooldowns();
  }

  /**
   * 开局在视口外放一批进攻者，并在全图空地散布会移动的轻量怪物数据。
   */
  seed(view: BattleView): void {
    this.spawnTimer = 0;
    this.farGroup = 0;
    this.waves.reset();
    if (this.pinnedWave > 0) this.waves.jumpTo(this.pinnedWave);
    this.surgeCeiling = 0;
    // 全部生在视口外，和之后每一个走同一条路：方向均匀一整圈，距离按"沿这个方向走多远才
    // 出画面"算，再往外多撒一段随机纵深（见 SEED_DEPTH）让他们分批到达。
    //
    // 留着这一批而不是直接交给第一波的爆兵，是因为只有它带纵深：爆兵和之后的补兵都贴着视口
    // 边缘生成，一起放会读成一个整齐收缩的圆环。这三十个人是分批走进来的那一层。
    for (let i = 0; i < SEED_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const r = this.exitDistance(cos, sin, view) + SPAWN_MARGIN + Math.random() * SEED_DEPTH;
      this.place(this.player.x + cos * r, this.player.y + sin * r, view, this.waves.pick());
    }
    this.seedWorld(view);
    this.worldPopulation.reset();
  }

  /**
   * 分格散布全图。每格随机一点，避免扎堆；避开开局视口和实际障碍。
   *
   * 上限是日常预算而不是 MAX_WORLD_ENEMIES 那个兜底：格子数只跟图的大小和间距有关（1200
   * 见方是 42×42 = 1764 格），和预算完全脱钩，不夹一下就会一铺铺出 1538 个人来，超预算
   * 28%，还得等玩家杀十几秒才掉回来。
   *
   * 夹的办法是**把格子打乱了再填**，不是一行一行扫到数满就 return：格子本来是按行扫的，
   * 扫到预算停手会让地图下面三分之一一个人也没有，小地图上一眼就看出来。打乱之后停在哪儿
   * 都是均匀的，而且填够预算才停 —— 树底下没放成的那些格子会由后面的格子补上。
   */
  private seedWorld(view: BattleView): void {
    const field = this.field;
    const cols = Math.max(1, Math.floor(field.width / WORLD_ENEMY_SPACING));
    const rows = Math.max(1, Math.floor(field.height / WORLD_ENEMY_SPACING));
    const cellW = field.width / cols;
    const cellH = field.height / rows;
    const budget = this.worldBudget;
    const order = new Uint32Array(cols * rows);
    for (let i = 0; i < order.length; i++) order[i] = i;
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = order[i];
      order[i] = order[j];
      order[j] = swap;
    }
    for (const cell of order) {
      if (this.worldEnemyCount >= budget) return;
      const col = cell % cols;
      const row = (cell - col) / cols;
      const kind = this.waves.pick();
      for (let attempt = 0; attempt < 4; attempt++) {
        const x = (col + 0.25 + Math.random() * 0.5) * cellW;
        const y = (row + 0.25 + Math.random() * 0.5) * cellH;
        if (this.placeWorldEnemy(x, y, view, kind)) break;
      }
    }
  }

  /**
   * 开局和持续补怪共用：不占完整怪物槽位，不在可见区生成，不创建 Character。
   *
   * 兵种也按当前这一波的比例摇 —— 远处这些人迟早会走进画面变成完整怪物，用统一的随机会让
   * 第一波里混进弓手，模板写的配比就白写了。
   */
  private placeWorldEnemy(
    x: number, y: number, view: BattleView,
    kind: ResolvedUnitKind = this.waves.pick(),
  ): Reservation | null {
    if (this.worldEnemyCount >= MAX_WORLD_ENEMIES || this.inActiveArea(x, y, view, DESPAWN_MARGIN)) return null;
    const radius = RigSpec.hipHalfWidth * kind.def.bulk * 1.15;
    if (!isFreeSpot(this.field.terrain, this.field.props, x, y, radius)) return null;
    const stats = this.enemyStats(kind);
    const enemy: Reservation = {
      motion: new DistantMotion(x, y, this.clock, this.farGroup++),
      x, y, def: kind.def, palette: kind.palette, stats,
      expValue: expFromKill(kind, this.waves.waveNumber, this.modifier),
      boss: kind.boss,
      // 远处那份数据不会挨打，挺尸永远是 0；字段还是得有，两边共用同一个形状。
      stun: 0,
      walkSpeed: stats.moveSpeed, speed: 0, crowdPace: 0,
      sideBias: Math.random() < 0.5 ? -1 : 1,
      radius, spacing: RigSpec.torsoHalfWidth * kind.def.bulk, alive: true,
      facing: Math.atan2(this.player.y - y, this.player.x - x),
      cooldown: Math.random() * this.enemySwingGap(kind.def, stats),
      hp: stats.maxHp, maxHp: stats.maxHp,
    };
    this.reserved.push(enemy);
    return enemy;
  }

  /** 实际镜头与出怪框的并集；恢复区小于回收区，避免边缘反复装卸。 */
  private inActiveArea(x: number, y: number, view: BattleView, margin: number): boolean {
    const box = view.spawn;
    if (Math.abs(x - box.x) <= box.halfW * (1 + margin) &&
        Math.abs(y - box.y) <= box.halfH * (1 + margin)) return true;
    const visible = view.visible;
    const slack = SCREEN_SLACK * margin / RESTORE_MARGIN;
    return visible !== undefined &&
      Math.abs(x - visible.x) <= visible.halfW + slack &&
      Math.abs(y - visible.y) <= visible.halfH + slack;
  }

  /** 更新完整怪物与轻量数据的归属，也可在暂停后调整镜头时调用。此方法不推进移动。 */
  syncEnemyVisibility(view: BattleView): void {
    // 释放上一帧移动数组对已卸载 Character 的引用。
    this.movers.length = 0;
    this.recycle(view);
    this.grid.build(this.enemies);
    this.restoreReserved(view);
  }

  /**
   * 在视口外随机一个方向生一个。
   *
   * 方向是均匀的一整圈，不做任何"这边在图外就换一边"的挑拣 —— 那正是包围感的来源。距离按
   * **沿这个方向走多远才出画面**算，所以每个方向都恰好在看不见的地方生成，不多走一步。
   */
  spawn(view: BattleView, kind: ResolvedUnitKind = this.waves.pick()): boolean {
    const angle = this.spawnAngle();
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const r = this.exitDistance(cos, sin, view) + SPAWN_MARGIN + Math.random() * SPAWN_JITTER;
    return this.place(this.player.x + cos * r, this.player.y + sin * r, view, kind);
  }

  /**
   * 这一个从哪个方向来。
   *
   * 站着不动就是均匀的一整圈（围杀那个形态）；一旦跑起来就往前方偏 —— 生在身后的人追不上，
   * 走两步就被回收，纯属浪费。见 FORWARD_BIAS。
   *
   * 用拒绝采样而不是解析反变换：权重是 1 + bias·cos(θ−前进方向)，反变换要解一个超越方程，
   * 而拒绝采样在这个权重下平均一两次就中，还顺带保证了分布是精确的。
   */
  private spawnAngle(): number {
    const bias = clamp(this.player.speed / PLAYER_RUN_SPEED, 0, 1) * FORWARD_BIAS;
    if (bias < 0.02) return Math.random() * Math.PI * 2;
    // "前方"是他**走**的方向，不是他脸朝的方向。自动锁敌之后这两件事经常差得很远 —— 一边
    // 打身边这个一边往外撤，正是最常见的走位。生在脸朝的那一边就又回到了追不上的老问题。
    const dir = this.player.moveDir;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      if (Math.random() * (1 + bias) <= 1 + bias * Math.cos(a - dir)) return a;
    }
    return dir;
  }

  /**
   * 把远处的人转为无骨架数据。出怪框和实际可见框之外都留缓冲带；调试拉远镜头时，仍然保留
   * 画面中可见的怪物。出怪节奏继续按出货框计算。
   *
   * 尸体也一起回收：它们已经在画面外，没人看得见，留着只是占着数组。
   *
   * 抹掉的是**模型**，不是那个人站过的地方：活人在离场时把位置记进预留表，视线回来时照着
   * 放回去。数据不按时间过期；仅在总量满且附近缺兵时，允许从远处密集区调配刷怪名额。
   */
  private recycle(view: BattleView): void {
    const enemies = this.enemies;
    const reserved = this.reserved;
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      /*
       * 首领不回收。
       *
       * 回收是为了人海：几百个跟不上的杂兵抹成无骨架数据，省下的那一大笔开销才是帧率的来源。
       * 而首领一波就一个，留着不花什么钱 —— 反过来，把他抹成数据之后他就从 `enemies` 里消失了，
       * 小地图上那个骷髅头也跟着没了。玩家走远一点目标就不见了，这比不标还糟。
       */
      if (e.alive && e.boss) continue;
      if (this.inActiveArea(e.x, e.y, view, DESPAWN_MARGIN)) continue;
      if (e.alive) {
        reserved.push({
          motion: new DistantMotion(e.x, e.y, this.clock, this.farGroup++),
          x: e.x,
          y: e.y,
          facing: e.facing,
          def: e.def,
          palette: e.palette,
          walkSpeed: e.walkSpeed,
          stats: e.stats,
          expValue: e.expValue,
          boss: e.boss,
          stun: 0,
          speed: e.speed,
          crowdPace: e.crowdPace,
          sideBias: e.sideBias,
          radius: e.radius,
          spacing: e.spacing,
          alive: true,
          cooldown: e.attackCooldown,
          hp: e.hp,
          maxHp: e.maxHp,
        });
      }
      enemies[i] = enemies[enemies.length - 1];
      enemies.pop();
      this.recycled++;
    }
  }

  /**
   * 视线回到哪儿，就把那儿预留的人放回去。
   *
   * 只有成功激活才消费记录；容量不足或落点被占时保留数据，不能让小地图上的怪物凭空消失。
   *
   * 必须在 grid.build 之后调。邻居表覆盖原来的活跃怪物，本批新增者单独检查，避免不同时间
   * 留下的记录激活到同一位置。正常 update 在推进敌人之前再统一建表。
   */
  private restoreReserved(view: BattleView): void {
    const reserved = this.reserved;
    const enemies = this.enemies;
    const initialCount = enemies.length;

    for (let i = reserved.length - 1; i >= 0; i--) {
      const r = reserved[i];
      if (enemies.length >= this.maxEnemies) break;
      if (!this.inActiveArea(r.x, r.y, view, RESTORE_MARGIN)) continue;
      if (!this.spotFree(r.x, r.y, r.def, initialCount)) continue;

      const e = new Character(r.def, r.palette, r.walkSpeed, r.sideBias);
      e.stats = r.stats;
      e.expValue = r.expValue;
      e.boss = r.boss;
      e.stun = 0;
      e.x = r.x;
      e.y = r.y;
      e.facing = r.facing;
      e.speed = r.speed;
      e.crowdPace = r.crowdPace;
      e.attackCooldown = r.cooldown;
      e.hp = r.hp;
      e.maxHp = r.maxHp;
      e.update(0); // 暂停/缩放时也要有已构建的姿势。
      enemies.push(e);
      reserved[i] = reserved[reserved.length - 1];
      reserved.pop();
      this.restored++;
    }
  }

  /**
   * (x, y) 能不能塞得下 who：地形不挡、玩家不在那儿、也没有别的活人占着。
   *
   * 只给恢复用。出怪那条路不查这个 —— 出怪点在视野外的空地上，撞上了由分离顺手推开就行；
   * 而恢复是往**人堆里**放，放错了就是两个人叠在一起从画面外走出来。
   */
  private spotFree(x: number, y: number, def: UnitDef, initialCount: number): boolean {
    const { field, grid, enemies, player, crowdSpacing } = this;
    // 尺寸只由 def 推出来（见 Character 的 radius / spacing），所以不必先造一个人再来问。
    // 这条路每帧会为每个还没放回去的预留走一次，白造的 Character 会连带 Pose 和 Animator。
    const radius = RigSpec.hipHalfWidth * def.bulk * 1.15;
    const spacing = RigSpec.torsoHalfWidth * def.bulk;
    if (!isFreeSpot(field.terrain, field.props, x, y, radius)) return false;

    const toPlayer = (player.spacing + spacing) * crowdSpacing;
    if ((x - player.x) ** 2 + (y - player.y) ** 2 < toPlayer * toPlayer) return false;

    for (let i = initialCount; i < enemies.length; i++) {
      const other = enemies[i];
      const min = (spacing + other.spacing) * crowdSpacing;
      if ((other.x - x) ** 2 + (other.y - y) ** 2 < min * min) return false;
    }

    // 最坏情况下够得着的距离：对面是场上最胖的那位。按它开查询窗口，格子数才与间距无关。
    const reach = (spacing + MAX_SPACING) * crowdSpacing;
    const span = Math.max(1, Math.ceil(reach / grid.cellSize));
    const cx = grid.colOf(x);
    const cy = grid.rowOf(y);
    const x0 = Math.max(0, cx - span);
    const x1 = Math.min(grid.cols - 1, cx + span);
    const y0 = Math.max(0, cy - span);
    const y1 = Math.min(grid.rows - 1, cy + span);
    const items = grid.indices;

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const end = grid.end(gx, gy);
        for (let k = grid.begin(gx, gy); k < end; k++) {
          const other = enemies[items[k]];
          if (!other.alive) continue;
          const min = (spacing + other.spacing) * crowdSpacing;
          const dx = other.x - x;
          const dy = other.y - y;
          if (dx * dx + dy * dy < min * min) return false;
        }
      }
    }
    return true;
  }

  /**
   * 沿 (cos, sin) 从玩家走多远才离开视口。
   *
   * 玩家一定在视口里面（镜头夹取保证了这点），所以四条边里至少有一条在正方向上被穿过，
   * 取最近的那次穿越就是出口。
   */
  private exitDistance(cos: number, sin: number, view: BattleView): number {
    const box = view.spawn;
    const px = this.player.x;
    const py = this.player.y;
    let t = Infinity;
    if (cos > 1e-6) t = Math.min(t, (box.x + box.halfW - px) / cos);
    else if (cos < -1e-6) t = Math.min(t, (box.x - box.halfW - px) / cos);
    if (sin > 1e-6) t = Math.min(t, (box.y + box.halfH - py) / sin);
    else if (sin < -1e-6) t = Math.min(t, (box.y - box.halfH - py) / sin);
    // 玩家在框里的话四条边至少有一条在正方向上被穿过，t 必为正。他要是落在框外（不该发生，
    // shipViewport 已经把中心夹过了），负的 t 会让人刷在脚底下，所以兜一个对角线。
    if (!Number.isFinite(t) || t <= 0) return Math.hypot(box.halfW, box.halfH);
    return t;
  }

  /**
   * 真正把一个敌人放到 (x, y) 附近。
   *
   * 只夹到"图外一圈"这个大框里，**不**夹回场内 —— 图外生成是有意的，见 SPAWN_OUTSIDE。
   * 落点和树重叠就沿着原方向往外挪一点重试；图外没有树，所以那边一次就成。
   */
  private place(x: number, y: number, view: BattleView, kind: ResolvedUnitKind = this.waves.pick()): boolean {
    /*
     * 首领不占名额，也不被人数上限拦。
     *
     * 这两道闸是给人海的 —— 末波场上常年顶着一千二，而首领恰恰就在那个时候出。排在那条队里的
     * 后果是他根本生不出来，而“清完首领”又是这一局的胜负条件：一波三个首领变成零个，玩家会在
     * 空场上等到输。他们一共才十二个，多出这几个人压不垮帧。
     */
    if (!kind.boss) {
      if (this.localSpawnRoom() <= 0) return false;
      // 总量满时只置换远离玩家、也不在实际镜头里的数据。可见怪物和即将进场者不动。
      if (this.worldEnemyCount >= this.worldBudget && !this.releaseDistantSpawnSlot(view)) return false;
    }
    const field = this.field;
    const stats = this.enemyStats(kind);
    const e = new Character(kind.def, kind.palette, stats.moveSpeed);
    e.stats = stats;
    e.maxHp = stats.maxHp;
    e.hp = stats.maxHp;
    e.expValue = expFromKill(kind, this.waves.waveNumber, this.modifier);
    e.boss = kind.boss;

    const px = this.player.x;
    const py = this.player.y;
    let dx = x - px;
    let dy = y - py;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;

    let fx = x;
    let fy = y;
    for (let attempt = 0; attempt < 6; attempt++) {
      fx = clamp(x + dx * attempt * 6, -SPAWN_OUTSIDE, field.width + SPAWN_OUTSIDE);
      fy = clamp(y + dy * attempt * 6, -SPAWN_OUTSIDE, field.height + SPAWN_OUTSIDE);
      if (isFreeSpot(field.terrain, field.props, fx, fy, e.radius)) break;
    }

    e.x = fx;
    e.y = fy;
    e.facing = Math.atan2(py - fy, px - fx);
    // 随机的初始冷却，免得同一批出生的人到了跟前整齐划一地同时出手。
    e.attackCooldown = Math.random() * this.enemySwingGap(e.def, stats);
    this.enemies.push(e);
    return true;
  }

  /**
   * 这一波的全图人数预算。模板给，但不许突破全局的日常预算。
   *
   * 它是"人海有多厚"那个旋钮 —— 屏幕上站着多少人主要看它，而不是看出兵补得多勤。
   */
  private get worldBudget(): number {
    return Math.min(TARGET_WORLD_ENEMIES, this.waves.wave.world);
  }

  /**
   * 附近还能再放几个。
   *
   * 远处占满预算时，附近不足这一波的 crowd 仍然照常补兵 —— 那部分是从远处调过来的名额
   * （releaseDistantSpawnSlot），总量不变。crowd 逐波变大，所以这个上限也跟着波次走。
   *
   * 爆兵期间用的是另一条线：开波那一刻场上有多少人，再加这一波的爆兵数。不这么记的话开场白
   * 会被吞掉 —— 开波时场上往往已经比 crowd 多（走进画面的那批不经过出兵），按 crowd 算出来
   * 的余量是 0，一个人也放不出去。
   */
  private localSpawnRoom(): number {
    const target = this.waves.surging
      ? Math.max(this.waves.wave.crowd, this.surgeCeiling)
      : this.waves.wave.crowd;
    return Math.max(0, Math.min(this.maxEnemies - this.enemies.length, Math.max(
      this.worldBudget - WORLD_REFILL_RESERVE - this.worldEnemyCount,
      target - this.enemies.length,
    )));
  }

  private releaseDistantSpawnSlot(view: BattleView): boolean {
    const cell = 112;
    const cols = Math.ceil(this.field.width / cell);
    const rows = Math.ceil(this.field.height / cell);
    if (this.distantRegionCounts.length !== cols * rows) this.distantRegionCounts = new Uint32Array(cols * rows);
    const counts = this.distantRegionCounts;
    counts.fill(0);
    const region = (r: Reservation) =>
      clamp(Math.floor(r.y / cell), 0, rows - 1) * cols + clamp(Math.floor(r.x / cell), 0, cols - 1);
    for (const r of this.reserved) {
      if (!this.inActiveArea(r.x, r.y, view, 1)) counts[region(r)]++;
    }
    let selected = -1;
    let densest = 1;
    let farthest = 0;
    for (let i = 0; i < this.reserved.length; i++) {
      const r = this.reserved[i];
      // 两倍出货框之外才允许调配，避免镜头边缘红点消失或进攻队列突然断层。
      if (this.inActiveArea(r.x, r.y, view, 1)) continue;
      const density = counts[region(r)];
      // 优先从密集区调配，不把最远的边缘区域一只只抽空。
      if (density < densest || density <= 1) continue;
      const distance = (r.x - this.player.x) ** 2 + (r.y - this.player.y) ** 2;
      if (density === densest && distance <= farthest) continue;
      densest = density;
      farthest = distance;
      selected = i;
    }
    if (selected < 0) return false;
    this.reserved[selected] = this.reserved[this.reserved.length - 1];
    this.reserved.pop();
    return true;
  }

  /** 推进一帧。暂停时唯一被停下的就是它。 */
  update(dt: number, input: BattleInput, view: BattleView): void {
    const t0 = performance.now();
    const { player, enemies, field } = this;

    this.clock += dt;
    if (!this.defeated) this.runTime += dt;

    // 跑步这一帧按着没有。拿到外面来是因为有三个人要读它：松键收冷却、推进跑步本身、
    // 以及盯住它的下降沿。
    const sprintHeld = input.sprintHeld === true;
    this.advanceSprint(dt, input, sprintHeld);
    this.trackSustain(SPRINT_SKILL, this.sprintEngaged);
    // 法相按着没有。松手那一帧就落进收势，所以它必须在 advanceSkills 之前刷。
    //
    // 按键状态每帧都要看，**不能只在法相还开着的时候看**：蓝被榨干之后它已经没了，而欠着的
    // 那个冷却恰恰要等到那之后的某一帧松手才开始走。
    if (this.dharma) this.dharma.held = this.heldSkill(input, 'dharma');
    this.movePlayer(dt, input);
    // 先挪再转：朝向要用这一帧真正的走向（场上没人时人看着自己要去的地方）。
    this.aimPlayer(dt, input);
    this.advanceEnemyArrows(dt);
    this.syncEnemyVisibility(view);
    this.worldPopulation.update(dt, () => this.enemyPositions(), this.worldBudget - this.worldEnemyCount,
      (x, y) => this.placeWorldEnemy(x, y, view));
    this.spawnWave(dt, view);
    this.advanceSkillSchedule(dt, view);
    // 先推进当前攻击和完整攻击间隔；本帧一旦归零，就在同一帧开始下一次攻击。
    // 这样 HUD 的 0 与实际再次发动严格重合，不会出现归零后空等一帧。
    this.advancePlayerAttack(dt, view);
    this.swing();
    this.advanceSkills(dt, view);
    // 法相的下降沿要在 advanceSkills 之后盯：壳子是在那里面收掉的，而收势那一段仍然算在放。
    this.trackSustain('dharma', this.dharma !== null);
    // 完整怪物和无骨架数据一起移动，并共享避让与分离。
    this.driveEnemies(dt, view);
    this.separate();
    const mapBlend = DistantMotion.mapBlend(dt);
    for (const enemy of this.reserved) enemy.motion.smoothMap(enemy.x, enemy.y, mapBlend);

    this.effects.update(dt);
    this.debris.update(dt);
    this.warp.update(dt);
    this.damageNumbers.update(dt, this.player.x, this.player.y);
    // 吸附半径是玩家的一项属性（拾取范围），不再是 collectibles 里的一个常量。
    this.pickupTarget.x = player.x;
    this.pickupTarget.y = player.y;
    this.pickupTarget.pickupRange = player.stats.pickupRange;
    this.pickupTarget.accepts = this.acceptsPickup;
    this.collectibles.update(dt, this.pickupTarget);
    const collected = this.collectibles.collected;
    this.collectedGems += collected.gem;
    this.collectedCoins += collected.coin;
    for (const id of this.collectibles.collectedPickups) this.takeItem(id);
    this.advanceTimedBonuses(dt);
    this.advanceRegens(dt);
    this.advancePlayerFloats(dt);
    if (this.itemFlash > 0) this.itemFlash = Math.max(0, this.itemFlash - dt);
    // 玩家作为地表反馈焦点：雪印、水波和水珠不能被同一帧的大量敌人特效覆盖。
    field.update(dt, this.actors(), player);

    // 玩家倒下了。
    //
    // 正经流程是把这一局判负（defeated），由 main 切到结算画面；只有压力测试才走下面那条
    // 原地重开的路。倒地动画照常放完再判，玩家要看得见自己是怎么倒下的。
    if (!player.alive && player.death > RESPAWN_DELAY) {
      if (this.autoRespawn) {
        this.player.death = -1;
        this.player.hp = this.player.maxHp;
        this.currentMp = this.player.stats.maxMp;
        this.player.hurt = 0;
        enemies.length = 0;
        // 和 reset 一样：清场就该是真的清场，不能让预留把上一条命的人海放回来。
        this.reserved.length = 0;
        this.resetSkillRuntime();
        this.enemyArrows.length = 0;
        this.collectibles.clear();
        this.collectedGems = 0;
        this.collectedCoins = 0;
        this.seed(view);
      } else {
        this.defeated = true;
      }
    }

    // 清掉已经沉下去的尸体；还在飞的尸体夹回场地内。
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (e.gone) {
        enemies[i] = enemies[enemies.length - 1];
        enemies.pop();
        continue;
      }
      // 击飞不查地形（Character 不认识 field，也不该认识），但不能飞出地图 —— 场地边缘
      // 之外没有地面，尸体会躺在虚空里。撞树穿模无所谓：那是一堆两秒后就沉下去的尸体，
      // 而地图边界是**看得见**的。
      if (!e.alive) {
        e.x = field.clampX(e.x);
        e.y = field.clampY(e.y);
      }
    }

    this.simMs = smooth(this.simMs, performance.now() - t0);
  }

  // ---------------------------------------------------------------- 玩家

  private movePlayer(dt: number, input: BattleInput): void {
    const { player, field } = this;
    const fromX = player.x;
    const fromY = player.y;

    // 突进期间不听输入：方向在起手那一刻就定死了。
    //
    // 允许中途转向的话，玩家会拿它当一个"更快的走"来用 —— 那就不是一招了，而且判定跟着
    // 身体走，能转向就等于能画出一条任意折线的死亡走廊。冲多远由速度 × duration 定，
    // 一旦发动就是固定的一段。
    if (this.lunge) {
      // 这一帧从哪儿走到哪儿。判定用它连成的线段，见 advanceSkills。
      this.lunge.fromX = player.x;
      this.lunge.fromY = player.y;
      // 方向和速度都在起手那一刻就存进去了：冲到一半换个技能不该改变这一次冲刺。
      const speed = this.lunge.speed;
      const heading = this.lunge.heading;
      /*
       * 走的是 heading，**不是 facing**。
       *
       * 这两个数在突进期间是分开的：人整个沿着 heading 那条直线冲出去，而模型是在这几帧里
       * 转过去的（见 aimPlayer 的 LUNGE_TURN_RATE）。拿 facing 来推位移的话，转身还没转完
       * 的那几帧就会把人带偏，判定那条线段跟着歪 —— 而它必须是起手那一刻定下的那条直线。
       */
      player.moveAngle = heading;
      player.speed = speed;
      const to = moveWithCollision(
        field.terrain,
        field.props,
        player.radius,
        player.x,
        player.y,
        field.clampX(player.x + Math.cos(heading) * speed * dt),
        field.clampY(player.y + Math.sin(heading) * speed * dt),
      );
      player.x = to.x;
      player.y = to.y;
      this.playerVelocityX = dt > 0 ? (to.x - fromX) / dt : 0;
      this.playerVelocityY = dt > 0 ? (to.y - fromY) / dt : 0;
      return;
    }

    // 这里只管挪。朝哪儿是另一件事，由 aimPlayer 在这之后决定 —— 判定、特效和模型读的都是
    // facing，而它现在指着最近的敌人，和人往哪边走无关。
    const moveX = input.move?.x ?? 0;
    const moveY = input.move?.y ?? 0;
    if (moveX === 0 && moveY === 0) {
      player.moveAngle = null;
      player.speed = 0;
      this.playerVelocityX = 0;
      this.playerVelocityY = 0;
      return;
    }
    // 走多快是角色的属性，不再是两个常量。跑是走路乘一个固定倍率 —— 快多少是全局手感，
    // 不该每个角色各调一遍。跑不跑由疾走说了算，见 advanceSprint。
    const walk = player.stats.moveSpeed;
    const speed = this.sprinting ? walk * RUN_MULTIPLIER : walk;
    player.speed = speed;
    player.moveAngle = Math.atan2(moveY, moveX);
    const to = moveWithCollision(
      field.terrain,
      field.props,
      player.radius,
      player.x,
      player.y,
      field.clampX(player.x + moveX * speed * dt),
      field.clampY(player.y + moveY * speed * dt),
    );
    player.x = to.x;
    player.y = to.y;
    this.playerVelocityX = dt > 0 ? (to.x - fromX) / dt : 0;
    this.playerVelocityY = dt > 0 ? (to.y - fromY) / dt : 0;
  }

  /**
   * 朝哪儿打：自动锁住最近的那个敌人，玩家不用管。
   *
   * 这是割草游戏的标准做法，而且它解决的是一个真问题 —— 一只手走位、另一只手瞄准，在一个
   * 四面被围、每秒挥两三下的场面里，瞄准那一半其实没有决策可言：该打的永远是贴着你的那个。
   * 把它交给玩家，只是要求他每秒转十次鼠标去做一件没有选择的事。
   *
   * 锁的是**最近**，不是血最少、也不是首领：贴着你的那个是唯一能打到你的人，也是唯一你能
   * 打到的人。粘性和转速见 AIM_SWITCH_STICK / AIM_TURN_RATE。
   *
   * 附近一个人都没有时朝着走的方向 —— 空场上人总该看着自己要去的地方。连走都没在走就保持
   * 原样，站着不动的人不该自己转圈。
   */
  private aimPlayer(dt: number, input: BattleInput): void {
    const { player } = this;
    // 离线脚本直接指定朝向，见 BattleInput.facing。
    if (input.facing !== undefined) {
      player.facing = input.facing;
      this.aimTarget = null;
      return;
    }
    if (!player.alive) return;

    /*
     * 突进期间**朝着冲出去的那个方向，而且是瞬间转过去的**。
     *
     * 和疾走同一条规矩：人在位移，就看着自己要去的地方。冲的方向本身是走位方向（见
     * castSkill 的 dashHeading），所以站着不动按下去时它退回当前朝向 —— 那一下仍然是
     * "朝着锁住的那个人扑过去"，人不会莫名其妙扭一下。
     *
     * **这一档不插帧。** 别处的转身都要几帧过渡，那是为了不让身体抽搐；但突进不是"转身"，
     * 是一个起手动作 —— 人已经弹出去了，身体还在慢慢拧过来，看着就是模型没跟上，而不是
     * 一个甩身。骠骑将军身上最明显：马是一根长条，它的朝向在俯视角下比人清楚得多，差几帧
     * 就是马横着飘出去。整段只有 0.22 秒，任何过渡都占掉它的一大半。
     *
     * 转的只是模型。判定走的仍然是 lunge.heading 那条直线（见 movePlayer 和 advanceSkills），
     * 从第一帧起就是准的。
     */
    if (this.lunge) {
      player.facing = this.lunge.heading;
      return;
    }

    let want: number;
    if (this.sprinting) {
      /*
       * 疾走期间**不锁敌，朝着自己跑的方向**。
       *
       * 跑是"离开这儿"，不是"打那个人"。让身体在跑的时候还跟着最近的敌人转，在一个每帧都
       * 可能换目标的人堆里就是原地打转 —— 而疾走恰恰是用来从人堆里出来的。
       *
       * 朝着跑的方向，也就是玩家用鼠标跑时的光标方向（按住左键就是朝光标走，见 readInput），
       * 用方向键跑时就是键盘那个方向。两条路给的是同一个答案：他正在去的地方。
       *
       * 这条规矩场上本来就有 —— 附近没敌人时人也是看着自己要去的地方（下面那一支）。
       *
       * 用 sprinting 而不是 sprintEngaged：站着按住跑步键不算跑（见 advanceSprint），那时候
       * 人该照常转过去看着敌人。而 sprinting 为真就一定在走，所以 moveAngle 不会是空的。
       */
      if (player.moveAngle === null) return;
      want = player.moveAngle;
    } else {
      const target = this.pickAimTarget();
      this.aimTarget = target;
      if (target) want = Math.atan2(target.y - player.y, target.x - player.x);
      else if (player.moveAngle !== null) want = player.moveAngle;
      else return;
    }
    // 还差多少度决定这一帧转多快，见 AIM_TURN_EASE。
    const gap = Math.abs(Math.atan2(Math.sin(want - player.facing), Math.cos(want - player.facing)));
    const rate = clamp(gap * AIM_TURN_EASE, AIM_TURN_MIN, AIM_TURN_MAX);
    player.facing = turnToward(player.facing, want, rate * dt);
  }

  /**
   * 这一帧该锁谁。
   *
   * 线性扫一遍活着的完整怪物。没走网格：那张表是按人挤人的间距建的，一格才几个单位，要覆盖
   * 240 的半径得扫上千个格子，比直接比一遍还贵。而"比一遍"在同屏上限（1200）下也只是一千
   * 多次平方距离，和这一帧里的分离、驱动比起来不值一提。
   *
   * 只看 enemies —— 被抹成无骨架数据的那些（reserved）远在画面之外，本来就够不着。
   */
  private pickAimTarget(): Character | null {
    const { player } = this;
    const range2 = AIM_RANGE * AIM_RANGE;
    let best: Character | null = null;
    let bestD2 = range2;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    // 旧目标还活着、还在圈里，就粘着他，除非新的明显更近。
    const held = this.aimTarget;
    if (held && held.alive) {
      const dx = held.x - player.x;
      const dy = held.y - player.y;
      const heldD2 = dx * dx + dy * dy;
      if (heldD2 <= range2 && (best === null || bestD2 >= heldD2 * AIM_SWITCH_STICK)) return held;
    }
    return best;
  }

  /**
   * 这一帧跑不跑：按住跑步键、蓝还够、人还活着、而且没在突进。
   *
   * 蓝是**边跑边扣**的，不是起步时一次性收 —— 一次性扣费的跑步等于"点一下开始跑，然后永远
   * 免费"。扣不动就当场落回走路，不用玩家自己松手：他正被人追着，这时候要他去看蓝条是强人
   * 所难。
   *
   * 突进期间不跑：那一段的速度由突进自己定死（见 movePlayer），再叠一层跑步只会让那 0.22
   * 秒的距离变成一个说不清的数。
   */
  /**
   * 这一招所在的键位这一帧按着没有。
   *
   * 按技能 id 反查槽位，不记"是从哪个键放出来的"：同一招换个槽之后是另一个键，而玩家按的
   * 永远是它**现在**在的那个键。
   */
  private heldSkill(input: BattleInput, id: SkillId): boolean {
    const slot = this.skillLoadout.activeSkillSlots.indexOf(id);
    return slot >= 0 && input.heldSlots?.[slot] === true;
  }

  private advanceSprint(dt: number, input: BattleInput, held: boolean): void {
    if (!held || !this.player.alive || this.lunge) {
      this.sprintEngaged = false;
      this.sprinting = false;
      return;
    }
    // 跑空之后要等冷却。冷却本身就是闩：一旦 consume，ready 是假的，这里直接返回，
    // 所以不会每帧再收一次把那五秒一直顶在满格。
    if (!this.skillLoadout.ready(SPRINT_SKILL)) {
      this.sprintEngaged = false;
      this.sprinting = false;
      return;
    }
    // 同样留一档余量：不留的话蓝见底时人会在走和跑之间每隔几帧跳一次，步态看得出来。
    const rate = skillById(SPRINT_SKILL).mpDrain * this.skillLoadout.mpScale(SPRINT_SKILL);
    if (this.currentMp < rate * SUSTAIN_RESERVE) {
      // 跑到脱力：这一招就算收了，五秒从这一帧起算（见 trackSustain）。
      this.sprintEngaged = false;
      this.sprinting = false;
      return;
    }
    this.sprintEngaged = true;
    // 站着不动就不扣蓝：跑步买的是位移，原地按着跑步键烧一管蓝换不来任何东西。姿态仍然
    // 撑着（sprintEngaged），所以不会读作"技能结束"；而 sprinting 是假的，自动攻击照挥。
    const walking = (input.move?.x ?? 0) !== 0 || (input.move?.y ?? 0) !== 0;
    this.sprinting = walking && this.spendMp(rate * dt);
  }

  /**
   * 攻击是常态：到点就挥，不看周围有没有人、朝哪边。割草游戏里"挥不挥"根本不是一个需要判断
   * 的问题 —— 基础攻击就是攻击力、攻击范围、攻击频率三个数，而**发动只由频率决定**，其余的
   * 交给命中判定。
   *
   * 挥空不是问题：落点那一刻放出的是**武器扫过的弧**，说的是"这一下从这儿扫过去了"，而不是
   * "打中了"。中不中由 inAttackArc 的扇形判定单独说了算。
   *
   * **但速度变了的时候不挥。** 突进和疾走期间自动攻击停下来，动作结束才接着挥。理由是招式
   * 的形状和位置都挂在玩家的速度上：贴身的弧按 effectDrift 继承当前速度才跟得住人，而破空
   * 这类飞出去的招连射程都要按出货视口夹一次（cappedReach）。在一个速度正在变的瞬间发招，
   * 画出来的范围和真正杀到人的范围就对不上了 —— 而这个工程一贯的规矩是判定不能小于画面。
   */
  private swing(): void {
    if (!this.autoAttack || !this.player.alive) return;
    if (this.dashing || this.sprinting) return;
    this.startPlayerAttack();
  }

  /**
   * 显式装备或卸下一个技能。单选类别会自动替换旧项，多选类别互不影响，主动类占一个空槽。
   * 返回 false 表示装备规则拒绝了这次操作。
   */
  setSkillEnabled(id: SkillId, enabled: boolean): boolean {
    const oldGuard = this.skillLoadout.guardSkill;
    const wasEquipped = this.skillLoadout.isEquipped(id);
    if (!this.skillLoadout.setEquipped(id, enabled)) return false;

    if (oldGuard && oldGuard !== this.skillLoadout.guardSkill) this.clearSkillEffect(oldGuard);
    if (wasEquipped && !this.skillLoadout.isEquipped(id)) this.clearSkillEffect(id);
    return true;
  }

  /**
   * 调试菜单里点一招：装上或卸下。**装上的同时直接给满级。**
   *
   * 这条路只有调试菜单走（main.ts 的 toggleSkill 钩子），正常局里装招走的是三选一。
   * 菜单存在的理由就是"我想看看这一招长什么样"，而一级的招式和满级现在已经是两个东西 ——
   * 伤害、作用距离、出手频率、中心那一蓬碎片、把人掀多远，五样都跟着等级走。
   * 点上去只给一级的话，看到的是这一招最小的那个样子，而那恰恰不是来看的那一个。
   *
   * 卸下不调级：反正再点上去又是满级，而新开一局会把所有等级清回一级（startRun）。
   */
  toggleSkill(id: SkillId): boolean {
    const skill = skillById(id);
    const want = skill.category === 'attack' || !this.skillLoadout.isEquipped(id);
    if (!this.setSkillEnabled(id, want)) return false;
    if (want) this.skillLoadout.setLevel(id, SKILL_MAX_LEVEL);
    return true;
  }

  /** J 只在三个自动攻击之间循环，不再把护身、发射或主动技能塞进武器挥击。 */
  cycleAttackSkill(): void {
    this.skillLoadout.cycleAttack();
  }

  /** Q/W/E/R 触发对应主动槽；技能未装备、尚在冷却或玩家正在位移时都不会发动。 */
  triggerActiveSkill(slot: ActiveSkillSlot, view: BattleView): boolean {
    const id = this.skillLoadout.activeSkillSlots[slot];
    if (!id || !this.player.alive || !this.skillLoadout.ready(id)) return false;
    const skill = skillById(id);
    if (skill.category !== 'active') return false;
    // 按住型的技能没有"发动"这回事：按下去不触发什么，松开也不结束什么，它只是在按着的
    // 每一帧生效（见 advanceSprint）。所以这条路直接不认它。
    if (skill.kind === 'sustained') return false;
    // 冲刺期间**只挡突进自己**，别的主动技照放。
    //
    // 以前是一冲起来什么都按不了。突进只有零点二秒，那零点二秒里禁掉一切，恰好把这一招最
    // 该有的搭配也禁掉了：冲进人堆的路上开金钟罩，撞人的判定当场按罩子的外沿算（见
    // guardReach）。那是玩家自己发现的连招，不该被一条顺手写下的守卫挡住。
    if (this.dashing && skill.kind === 'lunge') return false;
    // 蓝不够按不动。HUD 上那一格这时已经是灰的（canAfford），所以玩家不会觉得是按丢了。
    if (!this.spendMp(skill.mpCost * this.skillLoadout.mpScale(skill.id))) return false;
    this.castSkill(skill, view);
    // 按住型的不在这里收冷却。它们的冷却是**脆弱惩罚**而不是发招间隔 —— 脸撑到蓝空才进冷却，
    // 自己收手则随时能再开（见 advanceSkills 里的 consume）。在这里收会把“有蓝就能放”变回“五秒一次”。
    if (skill.kind !== 'dharma') this.skillLoadout.consume(id);
    return true;
  }

  skillCooldown(id: SkillId): number {
    if (skillById(id).category === 'attack') {
      return this.skillLoadout.attackSkill === id ? this.player.attackCooldown : 0;
    }
    // 正放着（见 skillHolding）：按满格返回，格子因此是全灰的；数字由 HUD 另行按住。
    if (this.skillHolding(id)) return skillById(id).cooldown;
    return this.skillLoadout.cooldownOf(id);
  }

  /** HUD 使用的完整发动间隔；自动攻击还要包含武器动作本身，而不只是技能表里的额外等待。 */
  skillCooldownDuration(id: SkillId): number {
    const skill = skillById(id);
    if (skill.category === 'attack') {
      return playerSwingTime(this.player) + skill.cooldown * this.skillLoadout.rateScale(id);
    }
    return skill.cooldown;
  }

  private startPlayerAttack(): boolean {
    const skill = skillById(this.skillLoadout.attackSkill);
    if (!this.skillLoadout.ready(skill.id)) return false;
    // 技能等级压的是**冷却**，不是挥击动作本身（见 SKILL_LEVEL_RATE）。
    const started = this.player.swing(
      playerSwingTime(this.player) + skill.cooldown * this.skillLoadout.rateScale(skill.id),
    );
    if (!started) return false;
    // 起手那一刻响，不是落点那一刻。兵器是先动起来才扫到人的，等到落点再响，玩家听到的
    // 就是"砍中之后才听见挥"—— 而且那时命中声也正好在响，两个撞在一起谁都听不清。
    this.emitSound('attack');
    this.pendingAttackSkill = skill.id;
    this.skillLoadout.consume(skill.id);
    return true;
  }

  /**
   * 所有自动型技能各减各的冷却，法力也在这里回。同一帧到点的自动技可以一起发动。
   *
   * **冲刺期间一个也不发。** 和自动攻击停下是同一条理由（见 swing）：发射类技能的射程按
   * 施放者的属性折算、还要按出货视口夹一次（cappedReach），而冲刺一帧跨二十几个单位，发出
   * 去的招和画出来的形状对不上。冷却照常走，所以冲完立刻就会补上。
   *
   * 玩家**手动**按的主动技不在此列：冲进人堆的路上开金钟罩是这一招最该有的搭配，那是他自己
   * 的选择，不是系统替他发的。
   */
  private advanceSkillSchedule(dt: number, view: BattleView): void {
    this.skillLoadout.tick(dt);
    // 回蓝。死了也照回 —— 倒地那一秒多回的几点蓝不影响任何事，而加一个"活着才回"的分支
    // 只会让重开那一刻的蓝量取决于躺了多久。
    this.currentMp = Math.min(this.player.stats.maxMp, this.currentMp + this.player.stats.mpRegen * dt);
    if (!this.player.alive || this.dashing) return;
    for (const skill of this.skillLoadout.automaticSkills()) {
      if (!this.skillLoadout.ready(skill.id)) continue;
      this.castSkill(skill, view);
      this.skillLoadout.consume(skill.id);
    }
  }

  /** 菜单卸下技能时同步撤掉它尚未结束的实体；已经飞出去的通用冲击波仍自然播完。 */
  private clearSkillEffect(id: SkillId): void {
    // 卸下一招同时抹掉 sustainOpen：下一帧它当然不开着了，不抹的话那一帧会被读成一次
    // 正常的收招，白白挂上五秒冷却。
    this.sustainOpen.delete(id);
    switch (id) {
      case 'aegis':
        this.aegis = null;
        break;
      case 'dharma':
        this.dharma = null;
        break;
      case 'heavenSplit':
        this.heavenSplit = null;
        break;
      case 'skyArrow':
        this.skyArrow = null;
        break;
      case 'heavenGuard':
        // 卸下这一招，已经在推的那一排当场收走。和别的招不同的是它是一**批**东西，
        // 所以清的是数组不是一个字段。
        this.heavenGuards.length = 0;
        break;
      case 'lunge':
        this.lunge = null;
        break;
    }
  }

  /**
   * 推进玩家的动画，并在落点那一帧结算判定、放出冲击弧。
   *
   * 判定和特效在同一个时刻发生，但两者互不依赖：弧是画给人看的，中不中由扇形判定说了算。
   *
   * player.update 的返回值就是"这一帧跨过落点了没有"，是一次**跨越**检测而不是阈值比较，
   * 所以它必须每帧正好调一次 —— 漏一帧那一下就白挥了，多调一帧就会连着结算两次。
   */
  private advancePlayerAttack(dt: number, view: BattleView): void {
    const { player } = this;
    // 已经起手的那一下，在突进或疾走开始的那一帧收回去。
    //
    // 光靠 swing() 那道"不再起新招"的闸是不够的：玩家经常是**挥到一半**才按下 R 或者突进，
    // 而落点还没到。让它照常落下去，就正好落在速度突变的那一帧上 —— 而招式的范围是按速度
    // 算的（见 swing 上面那段）。收回去只损失这一下，比放出一个范围对不上的招好。
    if ((this.dashing || this.sprinting) && player.attack >= 0) player.attack = -1;
    if (!player.update(dt)) return;
    this.castSkill(skillById(this.pendingAttackSkill), view);
  }

  /**
   * 敌人打玩家。
   *
   * 走的是**同一个**伤害公式：攻击力经防御递减、按浮动掷一次。玩家凭什么打中，敌人就凭
   * 什么打中；玩家的防御怎么挡，敌人的防御就怎么挡，谁也不吃暗亏。这条和 combat.ts 顶上
   * 那段"敌我共用同一个判定"是同一个取向。
   *
   * power 给 1：敌人身上还没有技能，一律按平砍算。
   *
   * @returns 这一下是不是致命。
   */
  private hitPlayer(actor: Character): boolean {
    return this.damagePlayer(actor.stats.attack, actor.x, actor.y);
  }

  /**
   * 饮血回血。没戴饮血就什么都不做。
   *
   * 回的量攒起来交给头顶那串飘字（advancePlayerFloats），和掉血扣蓝同一个节奏 ——
   * 一刀砍中五十个人就飘五十个回血数字的话，这一层反馈就变成了噪声。
   */
  private drainLife(damage: number): void {
    const guard = this.skillLoadout.guardSkill;
    if (guard !== 'bloodthirst' || !this.player.alive) return;
    const rate = LIFESTEAL_PER_LEVEL * this.skillLoadout.level(guard);
    const healed = Math.min(this.player.maxHp - this.player.hp, damage * rate);
    if (healed <= 0) return;
    this.player.hp += healed;
    this.drainedHp += healed;
  }

  private damagePlayer(attack: number, fromX: number, fromY: number): boolean {
    const roll = rollDamage(attack, this.player.stats.defense, 1, CRIT_CHANCE_BASIC);
    /*
     * 挨打也飘字，但是**攒满一秒飘一个**。
     *
     * 以前只有左上角那条血槽在掉，而战斗里玩家的眼睛一直在屏幕中间 —— 他知道自己在掉血，
     * 不知道掉得有多快。
     *
     * 不一下一个：末波人堆里每秒有十几下落在身上，一下一个就是一秒十几个数字叠在头顶 ——
     * 读不出来，而且把全局九十六个的数字池吃光，连地上的伤害数字一起消失。一秒一个总数才是
     * 玩家真正要知道的：他正以多快的速度在掉血。和扣蓝、慢回的丹是同一个节奏（REGEN_TICK）。
     */
    this.tookHp += roll.value;
    this.damageTaken += roll.value;
    return this.player.takeHit(fromX, fromY, roll.value);
  }

  /**
   * 打一个敌人：算伤害、扣血、飘数字；血空了才倒。
   *
   * 所有杀伤都从这里走，免得每个技能各写一遍扣血和记账。
   *
   * **这是这一版真正变了的那件事。** 以前叫 slay，碰到就死 —— 敌人根本没有血量，飘出来的
   * 数字是掷着玩的。现在第一波的杂兵仍然一刀一个（一级武将实收约 115 伤害，杂兵 40 血），
   * 但越往后的兵越要补刀：末波的枪骑兵得挨四下平砍，或者两下技能。割草的手感在开局保持
   * 原样，压力从后面长出来。
   *
   * @param fromX/fromY 打击来自哪儿，决定往哪边飞。
   * @param power       1 = 平砍（只溅血），2 = 技能（血 + 甲片，伤害也翻一档）。
   */
  private strike(
    e: Character,
    fromX: number,
    fromY: number,
    power: number,
    /** 这一招的技能等级倍率（见 SkillLoadout.damageScale）。1 = 一级。 */
    scale = 1,
    launch: { force?: number; freeze?: number } = {},
  ): void {
    if (!e.alive) return;
    const roll = rollDamage(this.player.stats.attack * scale, e.stats.defense, power, this.player.stats.crit);
    /*
     * 掀得多远跟着这一招练到几级走。
     *
     * 以前一级和满级掀得一样远。而击飞是这个尺寸下最读得出来的反馈（人只有二十来个
     * 像素高，人堆里眼睛能捕捉到的只有位移），那它就是升级最该被看见的地方之一。
     *
     * 乘而不是覆盖：突进和开天自己带的那个 force（它们掀得比别的招狠）该保留，
     * 只是同样跟着等级缩。
     */
    const force = (launch.force ?? 1) * launchForce(scale);

    let dx = e.x - fromX;
    let dy = e.y - fromY;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) {
      dx = Math.cos(e.facing);
      dy = Math.sin(e.facing);
    } else {
      dx /= len;
      dy /= len;
    }

    /*
     * 饮血：打出去的伤害按比例回到自己身上。
     *
     * 挂在这里而不是击杀那一步：按击杀给的话，打一个满血首领两分钟一点血都回不到，
     * 而那正是最需要它的时候。按伤害给，它的回复量自动跟着"我正在打得多狠"走。
     */
    this.drainLife(roll.value);

    // dx/dy 就是这个人被掀飞的去向 —— 数字拿它往反方向让开，把飞行轨迹留给画面。
    // 首领那一串单独一档（金色、字大一截）。末波一刀下去几十个数字同时飘，长得一样就淡掉了。
    this.damageNumbers.spawn(e.x, e.y, roll.value, {
      crit: roll.crit,
      style: e.boss ? 'boss' : undefined,
      dirX: dx,
      dirY: dy,
    });
    this.emitSound('hit');

    // 没死就只闪一下白光（takeHit 里做的），不溅碎片也不掉东西。碎片是"这个人碎了"的信号，
    // 挨一下还站着的人溅出甲片会让玩家以为他已经死了。
    if (!e.takeHit(fromX, fromY, roll.value, { ...launch, force })) {
      /*
       * 首领挨一刀就停一下脚。
       *
       * 他太硬，打不飞也打不断 —— 没有这一下的话，他只是匀速地贴上来，玩家的输出完全没有回馈。
       * 停那一下把"我砍中了"和"他还在压过来"同时说出来：一步、一顿、又一步。
       *
       * 挺尸未消之前不重复触发，否则满配的输出打下去他会被永久钉在原地 —— 那就不是压迫而是一个桩子了。
       */
      if (e.boss && e.stun <= 0) e.stun = BOSS_HIT_STUN;
      return;
    }

    this.kills++;
    this.gainExp(e.expValue);
    const isBoss = e.boss;
    if (isBoss) this.bossKills++;
    /*
     * 掉什么：小兵只掉灵石和金币，**药和符一件不掉**；首领保底掉一件。
     *
     * 按击杀概率给药是**调不准的**：前期每秒杀三个、后期每秒杀几十个，同一个概率在两头差一个
     * 数量级 —— 改了三轮（1/50 → 1/300 → 1/3000）都不对。现在补给挂在**个数**上：一波一个首领，
     * 加上按时刷的篝火（见 Props）。玩家想要药就得到处走，而不是站着砍到它自己掉出来。
     *
     * 灵石和金币照旧从小兵身上出：灵石是这一局的节奏（攒够就抽牌），抽牌的门槛又是从出兵预算
     * 倒推的 —— 把它也挪到首领身上会让整条升级曲线散架。
     */
    // 聚宝符：金币掉落翻倍。它是唯一一张改"掉什么"而不是改属性的符，所以只能在这儿问一句。
    const coinChance = COIN_DROP_CHANCE
      * (this.hasCharm('charm-fortune') ? FORTUNE_COIN_MULTIPLIER : 1);
    if (isBoss) this.collectibles.dropPickup(rollBossPickup().id, e.x, e.y);
    else if (Math.random() < coinChance) this.collectibles.dropCoin(e.x, e.y);
    else this.collectibles.dropGem(e.x, e.y);

    // 甩多远跟着等级走，和人被掀飞多远同一条规则。
    this.debris.burst(e.x, e.y, dx, dy, power, e.palette, debrisReach(scale));
  }

  /**
   * 放一招。
   *
   * kind 对应 skills.ts 里的结算路径：instant 当场算清，其余持续或飞行技能把状态放出去，
   * 真正的杀伤在 advanceSkills 里逐帧结算。
   *
   * 谁被打中都是**碰到就死**，和基础攻击完全一样 —— 技能之间的区别只有形状，没有强度。
   */
  private castSkill(skill: SkillDef, view: BattleView): void {
    const { player } = this;
    const at = weaponImpactPoint(player.pose, player.def, player.x, player.y, player.facing);
    // 技能等级动四样：作用距离、伤害、冷却、法力开销（见 data/balance.ts）。前两样在这两行。
    //
    // 距离这一条顺带把**画面**也拉大了：下面所有冲击弧、环、扭曲的尺寸都是从 reach 算的，
    // 所以满级的横扫真的扫出一个更大的扇面，不用另外给特效加一个等级分支。
    const reach = player.stats.attackRange * skill.reach * this.skillLoadout.reachScale(skill.id);
    /*
     * 角色自带的那一招比别的招高一成（见 SIGNATURE_DAMAGE_BONUS）。
     *
     * 它是一局里唯一不用抽、一直在挥的那一招，也是四个角色真正的分岔点。它要是到后期反而
     * 输给随便抽到的一张牌，最优解就变成了"不管选谁，都靠主动技输出"。
     */
    const signature = skill.category === 'attack' ? 1 + SIGNATURE_DAMAGE_BONUS : 1;
    const scale = this.skillLoadout.damageScale(skill.id) * signature;
    // 放招的时候顺手把身边的篝火砸了。挂在这里而不是每一条结算路径上：所有招式都从这儿发出去，
    // 而篝火不会跑，"你在它旁边放了一招"就是全部条件。
    this.breakCampfires(player.x, player.y, reach);

    switch (skill.kind) {
      // 这两种在这条路上什么都不做：被动一直生效，按住型的每一帧自己生效（advanceSprint），
      // 两者都没有"发动"这个时刻。
      case 'passive':
      case 'sustained':
        return;

      case 'instant': {
        const arc = skill.arc ?? player.stats.attackArc;
        // 整圈那一招的圆心是**人**，不是武器落点：转一圈扫开身周，落点在身前一侧没有意义。
        const full = arc >= Math.PI * 1.99;
        if (full) {
          // 回旋：一圈从脚下推开的环，见 castRing（突进的收招用的是同一份）。
          this.castRing(reach, skill.power, scale, player.x, player.y, {
            velocityX: this.effectDriftX,
            velocityY: this.effectDriftY,
          });
          return;
        }
        {
          /*
           * 横扫的刀光片数**就是这一招的等级**，而它们摆成三层：外三、中二、内一。
           *
           *   Lv.1  里面一道              1 片
           *   Lv.2  中间两道              2 片
           *   Lv.3  外面三道              3 片
           *   Lv.4  外三 + 中二            5 片
           *   Lv.5  外三 + 中二 + 里一     6 片
           *
           * 满级是**三层都在**，也就是六片 —— 先弄成五片（外三中二），里面那一道永远出不来。
           *
           * 每一级都是几整层的组合，所以任何一级都是左右对称的 —— 敲出一个偏向一边的扇面读起来
           * 像没画完。级数越高层数越靠外，于是"练得越狠扫得越开"这件事不用看面板也读得出来。
           *
           * 固定分层试过（无论几级都是同一张脸），均匀撒开也试过（数得清片数，但扇面是平的）。
           * 分层加上片数跟等级，两件事同时成立。
           */
          const fanOrigin = player.stats.attackRange * 0.12;
          const fan: { side: number; distance: number; weight: number; tint: ReturnType<typeof rgb> }[] = [];
          for (const layer of SWEEP_LAYERS) {
            if ((SWEEP_FAN_BY_LEVEL[this.skillLoadout.level(skill.id)] & layer.bit) === 0) continue;
            for (const side of layer.sides) {
              // 中间最亮最粗、往两边掉：一道挥击本来就是中间吃力。
              const edge = Math.min(1, Math.abs(side) / 0.46);
              fan.push({
                side,
                distance: layer.distance,
                weight: layer.weight - 0.3 * edge,
                tint: rgb(255, Math.round(226 - 48 * edge), Math.round(142 - 84 * edge)),
              });
            }
          }
          for (const blade of fan) {
            const heading = player.facing + blade.side * arc;
            const originX = player.x + Math.cos(heading) * fanOrigin;
            const originY = player.y + Math.sin(heading) * fanOrigin;
            // 每片刀光按自己那个角度算继承，见 driftAlong。横扫的判定是发招那一帧一次算清的，
            // 所以这里被拖回来的只有画面 —— 但画面小于判定同样是错的，只是错在看不见的那一侧。
            const bladeDrift = this.driftAlong(heading);
            this.effects.spawn(originX, originY, heading, {
              power: player.def.bulk,
              // 接近破空单片波的 0.9 弧度，不再是上一版看不清的 0.32 小弧。
              span: 0.78,
              from: 1.1,
              to: (reach * blade.distance - fanOrigin) / player.def.bulk,
              weight: blade.weight,
              life: 0.42,
              overhead: true,
              style: 'slash',
              flash: 0.2,
              sparks: 0.32,
              trail: 0,
              tint: blade.tint,
              velocityX: bladeDrift.x,
              velocityY: bladeDrift.y,
            });
          }
        }
        /*
         * 扇面外缘砸一个洞，比回旋小、比回旋短。
         *
         * 圆心不在脚下：横扫的力气是甩出去的，洞跟着落点走才对得上眼睛看到的那一下；
         * 摆在脚下会读成"他自己脚底炸了"。
         *
         * **而且得离人足够远。** 原来圆心在身前六成距离、半径六成二 —— 镜头是**涨开**的
         * （warpFilter 里 radius 从 open 倍长到满），长到最后半径反而超过了圆心到人的距离，
         * 于是挥到一半角色自己被扭进去了。现在圆心推到九成五、半径收到五成，
         * 满开时内沿还在四成五距离外 —— 双锤一级的横扫是 22 个单位，而人的身体半径才四出头。
         * 外沿落在 1.45 倍距离上，比刀尖（1.0）还外一截：撕开的是扫出去那一圈的空气，
         * 不是他站的地方。
         */
        //
        // 旋进取负 = 画面上顺时针，和这一刀本身的走向一致：applySlash 的手从身体右后绕到左前
        // （animator.ts），换算到屏幕上正好是顺时针。反着拧会让人觉得画面在跟招式较劲。
        //
        // depth 0.17 不是"变弱了"：重映射从钟形衰减换成球面 pow 之后（warpFilter.ts），
        // 同一个数字对应的位移大了约两倍半。0.17 是按峰值位移反解出来的，横扫看到的深浅
        // 和换之前一样。
        const holeAt = reach * 0.95;
        this.warp.spawn(
          player.x + Math.cos(player.facing) * holeAt,
          player.y + Math.sin(player.facing) * holeAt,
          reach * 0.5,
          { life: 0.34, depth: 0.17, swirl: -0.95, dark: 0.4, rim: 0.4, open: 0.62 },
        );
        /*
         * 横扫以前没有中心那一蓬，于是满级一刀砍倒一大片人却只有每个人身上那几片 ——
         * 摄在一个十几像素高的人身上，合起来只是"一排人身上各掉了点东西"。现在和回旋走同一条规矩。
         *
         * 圆心在身前半个距离，不在脚下：横扫的力气是甩出去的，和那个扭曲镜头同一个道理。
         */
        const caught: Character[] = [];
        for (const e of this.enemies) {
          if (e.alive && inSector(player, e, reach, arc)) caught.push(e);
        }
        this.blastOver(
          player.x + Math.cos(player.facing) * reach * 0.5,
          player.y + Math.sin(player.facing) * reach * 0.5,
          caught, skill.power, scale,
        );
        for (const e of caught) this.strike(e, player.x, player.y, skill.power, scale);
        return;
      }

      case 'wave': {
        const arc = skill.arc ?? player.stats.attackArc;
        // 后退着放不该让这道波飞得更近，见 driftAlong。
        const drift = this.driftAlong(player.facing);
        const wave: SkillWave = {
          x: at.x,
          y: at.y,
          vx: drift.x,
          vy: drift.y,
          heading: player.facing,
          age: 0,
          life: skill.duration,
          from: 2,
          // 打不出画面。见 cappedReach —— 屏幕外一片人无声消失不是爽快，是茫然。
          to: cappedReach(at.x, at.y, player.facing, arc, reach, player.stats.attackRange, view.spawn),
          arc,
          power: skill.power,
          // 倍率在**发招那一刻**定下：波还在飞的时候抽到升级牌，不该回过头来加强它。
          scale,
          hit: new Set(),
        };
        this.skillWaves.push(wave);
        // 特效和判定共用同一条推进曲线和同一组端点，所以画面上波扫到谁，谁就正好死。
        this.effects.spawn(wave.x, wave.y, wave.heading, {
          power: 1,
          span: wave.arc,
          from: wave.from,
          // 判定比画面宽一圈，见 SKILL_HIT_MARGIN。近处那条走廊没有对应的画面 —— 它就在
          // 玩家脚底下，那儿本来就是"我这一下打出去了"的位置，不需要再画一遍给他看。
          to: wave.to / SKILL_HIT_MARGIN,
          life: wave.life,
          weight: 2.4,
          overhead: true,
          style: 'surge',
          velocityX: wave.vx,
          velocityY: wave.vy,
          // 偏冷的白。破空是唯一一个离开施放者独立飞出去的东西，给它一个和别的招不同的
          // 色温，玩家余光里就能分出"这是我放出去的那道波"还是"我脚下扫了一圈"。
          tint: rgb(214, 236, 255),
        });
        return;
      }

      case 'aura': {
        this.aegis = { left: skill.duration, total: skill.duration, radius: reach, power: skill.power, scale };
        // 撑开那一下：一圈从脚下推开的环，比回旋快、比回旋细 —— 它说的是"罩子立起来了"，
        // 不是"我扫了一圈"。罩子本身由 Scene 每帧跟着人画（见 aegis）。
        this.effects.spawn(player.x, player.y, player.facing, {
          power: 1,
          span: Math.PI * 2,
          from: 1,
          to: reach / SKILL_HIT_MARGIN,
          life: 0.3,
          weight: 1.8 * player.def.bulk,
          overhead: true,
          tint: rgb(255, 226, 140),
        });
        return;
      }

      case 'dharma': {
        this.dharma = {
          left: skill.duration,
          total: skill.duration,
          radius: reach,
          power: skill.power,
          scale,
          // 起手那一帧就当按着：玩家按下去的同一帧就该看到它展开，而输入要到下一帧才报"按住"。
          held: true,
          fading: false,
        };
        this.effects.spawn(player.x, player.y, player.facing, {
          power: 1,
          span: Math.PI * 2,
          from: 1,
          to: reach / SKILL_HIT_MARGIN,
          life: 0.3,
          weight: 1.8 * player.def.bulk,
          overhead: true,
          tint: rgb(255, 196, 72),
        });
        return;
      }

      case 'heavenGuard': {
        /*
         * 人数**就是技能等级**：一级一个，满级五个。
         *
         * 这是这一招的主线升级。多一个人在画面上当场读得出来（这一排明显更宽了），而"每个人
         * 更疼一点"只是数字在变 —— 和磐石"一级一颗、满级五颗"是同一条思路。
         */
        const count = Math.max(1, Math.min(this.skillLoadout.level(skill.id), SKILL_MAX_LEVEL));
        /*
         * 朝**走的方向**推，站着不动时才用脸朝的方向。**和突进同一个字段、同一条规矩**
         * （moveDir 就是 `moveAngle ?? facing`，见 Character）。
         *
         * 先做的是"一律按 facing"，那一版错在**把方向从玩家手里拿走了**：朝向归自动锁敌，
         * 玩家按不动它。于是这一招只有一种放法 —— 推向系统替他选的那个最近的人。而这是一堵
         * 会走的墙，它最该用的地方恰恰是玩家自己看见的那一片：要往哪边突围、哪个方向人最厚。
         *
         * 接到 moveDir 上之后，"推哪边"重新变成一个动作：**走着放就推着走的方向去，站桩放就
         * 推向正在打的那一片。** 站桩那一支一个字没变（不动时 moveAngle 是空的，moveDir 自己
         * 落回 facing），所以原来那种用法照旧成立，只是多出了另一种。
         *
         * 键位上和突进读作同一件事也要紧：两招都是"朝我要去的方向推出去"，玩家按之前不用回想
         * 哪一招看脚、哪一招看脸。
         */
        const heading = player.moveDir;
        const dirX = Math.cos(heading);
        const dirY = Math.sin(heading);
        /*
         * 推多远。reach 已经含了等级（attackRange × skill.reach × reachScale），这里只再夹一道
         * "不许推出画面"—— 和破空同一条规矩、同一个函数。
         *
         * 对这一招它比对破空更要紧：破空出了画面只是少杀几个人，而这一排是玩家盯着看的东西，
         * 推出去就等于把最值钱的那一段演在他看不见的地方。arc 给 0 表示只量正前方那一条线：
         * 队列是横着排开的，但它整排是**平移**，不是张开一个扇面。
         */
        const march = cappedReach(
          player.x + dirX * HEAVEN_GUARD_LEAD,
          player.y + dirY * HEAVEN_GUARD_LEAD,
          heading,
          0,
          reach,
          player.stats.attackRange,
          view.spawn,
        );
        // 走多快按施放者的步速折算，见 HEAVEN_GUARD_PACE。
        const speed = player.stats.moveSpeed * HEAVEN_GUARD_PACE;
        // 横轴：朝向转 +90°。第 i 个沿它偏移，左右对称（heavenGuardOffset）。
        const sideX = -dirY;
        const sideY = dirX;

        for (let i = 0; i < count; i++) {
          const offset = heavenGuardOffset(i, count);
          const actor = new Character(unitAppearance('bulwark'), HEAVEN_GUARD_PALETTE, speed);
          /*
           * 落点**不夹在场地里**。
           *
           * 夹过一版，当场出事：玩家贴着地图边缘朝外放，五个落点各自被夹到同一条边界线上 ——
           * 一排人叠成了一个人。而且夹了也不一致，推进那一段本来就不夹（他们是一段判定，不是
           * 场上的人）。
           *
           * 不夹的代价只是队列两头可能站到树墙里去，而那一侧玩家本来就走不过去；推多远已经被
           * 出货视口夹过一道（上面的 cappedReach），而玩家贴边时那个框也是夹在场地里的，所以
           * 这一排不会推到地图外面很远的地方。
           */
          actor.x = player.x + dirX * HEAVEN_GUARD_LEAD + sideX * offset;
          actor.y = player.y + dirY * HEAVEN_GUARD_LEAD + sideY * offset;
          actor.facing = heading;
          // 速度给满，这样他从落地第一帧起就是**走着**的 —— 站定的步态混合要小半秒才推上去，
          // 那半秒里一排人贴地平移，读作五张滑过来的贴纸。
          actor.speed = speed;
          // 先推一帧，把骨架从一堆零搭成站姿：没跑过 update 的 Pose 画出来是个塌在原点的人，
          // 而这一招第一眼看到的就是他们还在天上的那一帧。
          actor.update(1 / 60, true);
          this.heavenGuards.push({
            actor,
            heading,
            speed,
            left: march,
            drop: skill.duration,
            dropTotal: skill.duration,
            fade: 1,
            power: skill.power,
            scale,
          });
        }
        /*
         * 脚下推开一圈金光。**只有画面，不打人** —— 所以走 effects.spawn 而不是 castRing
         * （那一条会连着结算一圈伤害，金钟罩的起手用的也是这条纯画面的路）。
         *
         * 它存在是因为这一招的"发动"在画面上是空的：玩家按下去，真正的东西要三分之一秒后才
         * 落地。没有这一圈，那三分之一秒读作按空了。
         */
        this.effects.spawn(player.x, player.y, heading, {
          power: 1,
          span: Math.PI * 2,
          from: 1,
          to: reach * 0.3,
          life: 0.3,
          weight: 1.8 * player.def.bulk,
          overhead: true,
          tint: rgb(255, 224, 132),
        });
        return;
      }

      case 'heavenSplit': {
        // 朝着锁定的那个人放出去。起手后把角度锁进状态，飞剑不会再跟着身体转 —— 目标半路
        // 倒下时，已经飞出去的那一剑不该拐弯去追下一个。
        const heading = player.facing;
        const clearance = SKY_BLADE_WIDTH * 1.4;
        const outOfView = exitDistance(player.x, player.y, heading, {
          x: view.spawn.x,
          y: view.spawn.y,
          halfW: view.spawn.halfW + clearance,
          halfH: view.spawn.halfH + clearance,
        });
        // reach 继续定义原来的飞行速度；实际距离至少走完 reach，并延长到剑柄也越过扩张后的
        // 视口边界。这样增大窗口、切换体型或站到屏幕偏侧时，都恰好是整把剑飞出画面后消失。
        const speed = reach / skill.duration;
        const duration = Math.max(reach, outOfView) / speed;
        this.heavenSplit = {
          age: 0,
          left: duration,
          total: duration,
          x: player.x,
          y: player.y,
          heading,
          speed,
          power: skill.power,
          scale,
        };
        return;
      }

      case 'mend': {
        /*
         * 回春：推一条持续回血进去，和慢回那种丹走同一条路（advanceRegens）。
         *
         * 不另开一套状态：它要的就是"每秒回一口、头顶飘个数"，而那整套已经在那儿了 ——
         * 再写一遍只会得到两个节奏不一样的回血。
         *
         * 回多少：每秒一成上限，再乘伤害倍率。那个倍率本来就只由等级决定，把它当回血量用，
         * 这一招就和别的招走同一条升级曲线，不用单给它一张表。
         */
        this.regens.push({
          hp: MEND_HP_PER_TICK * scale,
          mp: 0,
          left: skill.duration,
          since: 0,
        });
        return;
      }

      case 'berserk': {
        /*
         * 狂暴：一条限时加成（和符走同一条路）加一条负的回血。
         *
         * 两条都用现成的机制：属性走 timedBonuses（到期自己重算），掉血走 regens（一秒一跳、
         * 头顶飘个数）。另开一套"狂暴状态"只会得到两个自己走自己节奏的计时器，而它们本该同时结束。
         *
         * 输出那两项（攻击力、出手频率）乘伤害倍率，掉血和降防不乘 —— 升级该把这一招变得
         * 更值，而不是更危险。
         *
         * 频率那一项走的也是属性加成这条现成的路：playerSwingTime 拿 attackSpeed 去除动作
         * 时长（见文件上方），所以加在这里，挥击动作本身就跟着变快 —— 狂暴的八秒因此在画面
         * 上是看得见的，不用另外加一层特效去说"他现在很猛"。
         */
        this.timedBonuses.push({
          bonus: {
            attack: BERSERK_ATTACK * scale,
            attackSpeed: BERSERK_ATTACK_SPEED * scale,
            defense: BERSERK_DEFENSE,
          },
          left: skill.duration,
        });
        this.regens.push({ hp: -BERSERK_HP_DRAIN, mp: 0, left: skill.duration, since: 0 });
        this.applyPlayerStats();
        return;
      }

      case 'skyArrow': {
        // 落点不是起手时锁死：等待期间镜头跟着玩家移动，0.8 秒一到才在“此刻”的视口里抽取位置。
        this.skyArrow = {
          age: 0, targetX: 0, targetY: 0, radius: reach, power: skill.power, scale,
        };
        this.effects.spawn(at.x, at.y, player.facing, {
          power: 0.8,
          span: 0.48,
          from: 1,
          to: player.stats.attackRange * 1.5,
          life: 0.18,
          weight: 1.2,
          overhead: true,
          style: 'slash',
          tint: rgb(255, 222, 140),
        });
        return;
      }

      case 'lunge': {
        /*
         * 冲刺速度 = 这个角色的奔跑速度 × 技能表里那个倍数，冲多远由它乘 duration 得出。
         *
         * **这一招不能用上面那个 reach。** 那个数是 `attackRange × skill.reach`，对别的招
         * 来说是"够多远"，而突进的 skill.reach 是"冲刺是奔跑的几倍"（8.2），两件事借用了
         * 同一个字段。乘出来是 34 × 8.2 = 279 个单位，两倍半于真正冲出去的距离 —— 前推弧
         * 照着它画，出来就是一道横贯半个屏幕的大波，而人只冲了一百来个单位。
         */
        // 突进升级同样是"冲得更远"，只是它的远靠的是快：距离 = 速度 × 固定的动作时长，
        // 所以倍数只能加在速度上。升到满级是每秒六百多、一下冲一百五十个单位。
        const dashSpeed =
          player.stats.moveSpeed * RUN_MULTIPLIER * skill.reach * this.skillLoadout.reachScale(skill.id);
        const dashDistance = dashSpeed * skill.duration;
        /*
         * 冲**走的那个方向**，不是脸朝的方向。
         *
         * 突进是一件走位的事：进去、出来、绕开。朝向已经不归玩家管了（自动锁敌），如果冲刺
         * 也跟着朝向走，玩家就只剩下"冲进最近的那个人怀里"这一种用法 —— 而这一招一半的价值
         * 在于脱身。站着不按方向时 moveDir 就退回 facing，那时候冲向敌人才是他唯一的意思。
         */
        const dashHeading = player.moveDir;
        /*
         * 朝向**在这一刻**就甩过去，不等到下一帧的 aimPlayer。
         *
         * 因为底下那道前推弧的落点（at）是按朝向算出来的武器落点。不先转，弧就从他扑出去
         * 的**反**方向那一侧冒出来 —— 一道本该跟着人往前推的波，看着像是从背后掉下来的。
         *
         * 站着不动按下去时 dashHeading 就是当前朝向，这一行是个空操作。
         */
        player.facing = dashHeading;
        const dashFrom = weaponImpactPoint(player.pose, player.def, player.x, player.y, dashHeading);
        this.lunge = {
          left: skill.duration,
          heading: dashHeading,
          speed: dashSpeed,
          power: skill.power,
          scale,
          // 收招那一圈是**判定**半径，所以它照旧按 attackRange 折算，和上面那条不是一回事。
          finishRing: player.stats.attackRange * skill.finishRing,
          fromX: player.x,
          fromY: player.y,
        };
        // 突进：一道窄而急的前推弧，跟着人一起冲出去。弧的长度按**真正冲出去的距离**给。
        // 落点用 dashFrom（按冲的方向算的那个），不是外面那个按旧朝向算的 at。
        this.effects.spawn(dashFrom.x, dashFrom.y, dashHeading, {
          power: 1,
          span: 1.1,
          from: 2,
          to: dashDistance * 0.62,
          life: 0.42,
          weight: 2.2 * player.def.bulk,
          overhead: true,
          style: 'surge',
          tint: rgb(255, 232, 190),
        });
        return;
      }
    }
  }

  /**
   * 原地炸一圈：以玩家为心的整圈判定，外加一道推开的环。
   *
   * 回旋是它、突进的收招也是它。抽出来不是为了省几行，是为了让"同一个形状"在画面和判定上
   * 真的是同一份代码 —— 两处各写一遍的话，改了一处忘了另一处，玩家就会看到两个长得像但
   * 判定不一样的圈。
   */
  /**
   * 砸掉范围里的篝火，每一堆保底掉一件。
   *
   * 篝火是玩家**自己能决定什么时候去拿**的那一份补给：首领一波才一个、什么时候来不由他，
   * 而篝火就在地图上那几个点上、按时刷回来。想要药就得跑一趟 —— 这正是把一张均质的图变成
   * 有去处的图的那一下。
   */
  private breakCampfires(x: number, y: number, reach: number): void {
    const broken = this.field.props.breakNear(x, y, reach);
    for (const at of broken) {
      const a = Math.random() * Math.PI * 2;
      const r = CAMPFIRE_DROP_SPREAD;
      this.collectibles.dropPickup(rollPickup().id, at.x + Math.cos(a) * r, at.y + Math.sin(a) * r);
    }
  }

  private castRing(
    reach: number,
    power: number,
    scale: number,
    x = this.player.x,
    y = this.player.y,
    options: Pick<ShockwaveOptions, 'style' | 'tint' | 'velocityX' | 'velocityY'> = {},
  ): void {
    const { player } = this;
    this.effects.spawn(x, y, player.facing, {
      power: 1,
      span: Math.PI * 2,
      from: 1.5,
      to: reach / SKILL_HIT_MARGIN,
      life: 0.5,
      weight: 2.1 * player.def.bulk,
      overhead: true,
      style: options.style ?? 'ring',
      tint: options.tint ?? rgb(255, 214, 124),
      velocityX: options.velocityX,
      velocityY: options.velocityY,
    });
    // 那圈环扫过的地方，画面跟着被拧一下。
    //
    // 折射带**恒定压在环上**，靠的是两个半径用同一条推进曲线（都是三次 easeOut，见
    // WarpField.collect 和 frontRadius）加上一个固定的比：环的终点是 reach /
    // SKILL_HIT_MARGIN，透镜的终点是 reach，比就是 1/1.15 ≈ 0.87 —— 那正是 rimAt。起点也
    // 按同一个比给（环从 1.5 起手，所以透镜从 1.5 × 1.15 起手）。于是整条命里，带子一直
    // 骑在那个椭圆环上，而不是从它身上滑下来。
    //
    // depth / swirl / dark 全是 0：它们作用的是**整片**，而这一招的圆心站着玩家自己。
    // 拧他一下读作画面坏了，不是有力量在那儿。这一招的扭曲只发生在外围那条带上，
    // 环里面一个像素都不动。见 warpField.ts 顶上那段。
    const ringFrom = 1.5 * SKILL_HIT_MARGIN;
    this.warp.spawn(x, y, reach, {
      life: 0.5,
      depth: 0,
      swirl: 0,
      dark: 0,
      edge: 0.12,
      rim: 0.5,
      rimAt: 1 / SKILL_HIT_MARGIN,
      // 比横扫那条锐得多：带子要在 r = 1 之前衰减干净，否则透镜外沿会留一道几像素的硬
      // 台阶 —— 那读作画面被切了一刀。
      rimSharp: 13,
      open: ringFrom / reach,
    });
    const hit = (e: Character): boolean =>
      e.alive && (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y) <= (reach + e.radius) * (reach + e.radius);

    // 从中心真的甩出东西来。
    //
    // 光靠每个死者身上溅的那一蓬凑不出"爆炸"：一次回旋杀掉身周五十人，碎片就摊在一个半径
    // 四十多个单位的圈上，每一处都很稀，合起来只是"一圈人身上各掉了点东西"。爆炸得有东西从
    // **中心**飞出来，而且飞得比那圈人还远 —— 见 Debris.blast。
    //
    // 材质取圈里的一个人，不取玩家：飞出来的是被炸碎的**他们**，用玩家的甲色会让一蓬金片从
    // 他脚下喷出来，读作他自己碎了。一个人都没打到就不炸 —— 空地上炸出一蓬血是假的。
    //
    // 而且要**赶在结算之前**炸。碎片池快满时会按比例缩水（Debris 里的 share），排在五十个
    // 人身上那些小蓬后面去分剩下的话，最该被看见的这一蓬反而是被削得最狠的那个。
    //
    // 所以先把圈里的人数点出来：那一蓬有多大得跟着**包了多少人**和**练到几级**走。
    // 一级回旋的圈只有二十个单位、冷却 0.25 秒，照满量给的话站在两三个人旁边每秒就甩出
    // 四百多片 —— 疼得跟一个人碎了差不多，而他们没碎。
    const caught: Character[] = [];
    for (const e of this.enemies) if (hit(e)) caught.push(e);
    this.blastOver(x, y, caught, power, scale);
    for (const e of caught) this.strike(e, x, y, power, scale);
  }

  /**
   * 从一点炸出一蓬碎片。**有多大只看打中了多少人，甩多远只看练到几级。**
   *
   * 两条分开是故意的：数量说的是"死了几个人"，那是一件客观的事，和你练得多好无关；
   * 而甩多远是"这一下有多重"，那才是等级该看得见的地方（和掀飞距离同一条规则）。
   *
   * 要**赶在结算之前**炸。碎片池快满时会按比例缩水（Debris 里的 share），排在几十个人
   * 身上那些小蓬后面去分剩下的话，最该被看见的这一蓬反而是被削得最狠的那个。
   *
   * 材质取被打中的一个人，不取玩家：飞出来的是被炸碎的**他们**，用玩家的甲色会让一蓬金片
   * 从他脚下喷出来，读作他自己碎了。一个人都没打中就不炸 —— 空地上炸出一蓬血是假的。
   */
  private blastOver(x: number, y: number, caught: Character[], power: number, scale: number): void {
    if (caught.length === 0) return;
    const volume = Math.min(1, caught.length * BLAST_PER_ENEMY);
    this.debris.blast(x, y, power, caught[0].palette, volume, debrisReach(scale));
  }

  /**
   * 推进所有跨帧技能，并结算它们这一帧碰到的人。
   *
   * 这些技能是**故意**偏离"发招那一刻一次算清"那条规矩的（combat.ts 顶上那段）。理由很直接：
   * 一道要飞两百个单位的波，如果在起手那一帧就把远处的人杀了，玩家会看到人先倒、波后到 ——
   * 画面在撒谎。而"碰到就死"本来就是这个游戏唯一的伤害规则，让它按时间发生正是这条规则的
   * 字面意思。基础攻击和 instant 类技能仍然走老路：它们的范围只有十几个单位，一帧之内到达，
   * 分不分帧看不出来。
   */
  private advanceSkills(dt: number, view: BattleView): void {
    const { player } = this;

    for (let i = this.skillWaves.length - 1; i >= 0; i--) {
      const w = this.skillWaves[i];
      w.age += dt;
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      const radius = frontRadius(Math.min(w.age / w.life, 1), w.from, w.to);
      for (const e of this.enemies) {
        if (!e.alive || w.hit.has(e)) continue;
        if (sweptBy(e, w.x, w.y, w.heading, radius, w.arc, WAVE_NEAR_HALF_WIDTH)) {
          // 记上名字再砍：这一道波对他就这一下，剩下的三十多帧它只是从他身上越过去。
          w.hit.add(e);
          this.strike(e, w.x, w.y, w.power, w.scale);
        }
      }
      if (w.age >= w.life) {
        this.skillWaves[i] = this.skillWaves[this.skillWaves.length - 1];
        this.skillWaves.pop();
      }
    }

    if (this.skyArrow) {
      const arrow = this.skyArrow;
      const before = arrow.age;
      arrow.age += dt;
      if (before < 0.8 && arrow.age >= 0.8) {
        // 稍留边距，避免箭头与回旋环被屏幕边缘截断。
        const box = view.spawn;
        arrow.targetX = box.x + (Math.random() * 2 - 1) * box.halfW * 0.78;
        arrow.targetY = box.y + (Math.random() * 2 - 1) * box.halfH * 0.72;
      }
      // 0.8 秒呼应用户要求；后续 0.28 秒是可见的俯冲与落地窗口。
      if (arrow.age >= 1.08) {
        this.castRing(arrow.radius, arrow.power, arrow.scale, arrow.targetX, arrow.targetY, {
          style: 'burst',
          tint: rgb(255, 188, 62),
        });
        this.skyArrow = null;
      }
    }

    if (this.aegis) {
      this.aegis.left -= dt;
      // 碰到罩子就飞。原点是玩家自己 —— 罩子是以他为心的，人本来就该被朝外推开。
      // 每个人自带一扇免疫窗口（见 AURA_HIT_GAP）。以前是每帧结算，而每帧结算对一个死不了的人就是秒杀。
      const now = this.clock;
      for (const e of this.enemies) {
        if (!e.alive || now - e.domeHitAt < AURA_HIT_GAP) continue;
        if (inSector(player, e, this.aegis.radius, Math.PI * 2)) {
          e.domeHitAt = now;
          this.strike(e, player.x, player.y, this.aegis.power, this.aegis.scale);
        }
      }
      if (this.aegis.left <= 0) this.aegis = null;
    }

    this.advanceOrbit(dt);
    // 玩家死了也照推：这一排是已经放出去的东西，不是他身上的一层状态（金钟罩和法相是）。
    // 放完就倒下，那几秒里它仍然在替他犁 —— 而这恰恰是这一招最好看的时候。
    this.advanceHeavenGuards(dt);

    if (this.dharma) {
      /*
       * 按住就一直开着：每帧把 left 顶回满并扣蓝；松手（或者蓝空了）立刻落进收势那零点三五秒。
       *
       * 和突进那个"停表"不是一回事。突进是**一段固定的位移**，按住只是把它摊长；法相是一个
       * **姿态**，按住期间它一直是完全展开的，所以这里要把 left 顶满而不是冻住 —— 顶满之后
       * Scene 画出来的壳子才是稳的，冻住会让它停在起手那一帧的收放进度上。
       */
      const skill = skillById('dharma');
      const rate = skill.mpDrain * this.skillLoadout.mpScale('dharma');
      const wants = !this.dharma.fading && this.dharma.held && this.player.alive;
      // 留一档余量再扣：光看"这一帧扣得动吗"是不够的，剩一点蓝时回蓝每隔几帧就又够扣一帧，
      // 招式会在开和收之间抖。要求手上还剩得住四分之一秒，它才算还开得起。
      const afford = this.currentMp >= rate * SUSTAIN_RESERVE;
      const sustain = wants && afford && this.spendMp(rate * dt);
      if (sustain) {
        this.dharma.left = this.dharma.total;
      } else {
        // 蓝扣不动也好、玩家松手也好，到这里都是同一件事：落进收势。冷却不在这儿收 ——
        // 收势那三百五十毫秒仍然算在放，要等壳子真正消失才算结束（见 trackSustain）。
        this.dharma.fading = true;
        this.dharma.left -= dt;
      }
      // 同上：一扇免疫窗口，但和金钟罩各记各的（两个壳子可以同时开着）。
      const nowAspect = this.clock;
      for (const e of this.enemies) {
        if (!e.alive || nowAspect - e.aspectHitAt < AURA_HIT_GAP) continue;
        if (inSector(player, e, this.dharma.radius, Math.PI * 2)) {
          e.aspectHitAt = nowAspect;
          this.strike(e, player.x, player.y, this.dharma.power, this.dharma.scale);
        }
      }
      // 没有冷却可收（见技能表）：开得起就开，开到蓝空自己停。
      if (this.dharma.left <= 0) this.dharma = null;
    }

    if (this.heavenSplit) {
      const blade = this.heavenSplit;
      const fromX = blade.x;
      const fromY = blade.y;
      const dirX = Math.cos(blade.heading);
      const dirY = Math.sin(blade.heading);
      blade.age += dt;
      blade.left -= dt;
      blade.x += dirX * blade.speed * dt;
      blade.y += dirY * blade.speed * dt;

      // 上一帧的柄到这一帧的剑尖是一条连续线段，包含整截剑身和这一帧扫过的距离。判定半径
      // 与画出来的刃宽一致；命中后的横向击飞与定格则直接走突进的同一个函数。
      this.strikeAlongLunge(
        fromX,
        fromY,
        blade.x + dirX * SKY_BLADE_LENGTH,
        blade.y + dirY * SKY_BLADE_LENGTH,
        blade.heading,
        SKY_BLADE_WIDTH * 0.5,
        blade.power,
        blade.scale,
      );
      if (blade.left <= 0) this.heavenSplit = null;
    }

    if (this.lunge) {
      this.lunge.left -= dt;
      // 撞到谁谁死，判定就是人自己的身体加一点余量 —— 冲过去的是这个人，不是一个扇形。
      //
      // 但判定的是**这一帧走过的那条线段**，不是落点那一个圈。冲刺速度接近 500 单位/秒，
      // 60 帧下一步就跨 8 个单位，而 main.ts 把 dt 夹在 1/20 —— 掉帧时一步跨 25 个单位，
      // 比判定圈的直径还大，中间的人整个被跳过去。实测 20 帧下一条 18 人的队列漏掉 7 个，
      // 而且漏的位置是散的（第 0、1、5、8、9 个），玩家读作"从人身上穿过去了"。
      const ax = this.lunge.fromX;
      const ay = this.lunge.fromY;
      this.strikeAlongLunge(
        ax,
        ay,
        player.x,
        player.y,
        this.lunge.heading,
        this.guardReach(player.radius + LUNGE_BODY_MARGIN),
        this.lunge.power,
        this.lunge.scale,
      );
      if (this.lunge.left <= 0) {
        // 冲到头再炸一圈：把走廊两侧漏掉的人一起带走。冲锋该以"撞进人堆里停下"收尾，
        // 而不是穿过去就没事了。
        if (this.lunge.finishRing > 0) {
          this.castRing(this.lunge.finishRing, this.lunge.power, this.lunge.scale, player.x, player.y, {
            style: 'burst',
            tint: rgb(255, 142, 74),
          });
        }
        this.lunge = null;
      }
    }
  }

  /**
   * 神兵天降：那一排金身重甲兵各自往前推一格，犁掉挡在路上的人。
   *
   * 一个人分三段过完自己的一生：**掉下来 → 往前推 → 明灭着散掉**。三段各有各的出口条件，
   * 所以写成三个分支而不是一条插值曲线 —— 中间那一段有多长是等级定的（推多远 ÷ 走多快），
   * 另外两段是固定的。
   *
   * 他们**不进人群分离、不撞树、不撞地图边界**：这是一段长着人形的判定，不是场上的一个人。
   * 真让他走一遍寻路和挤人，一排五个会当场挤成一堆，而"一排平行的矛平推过来"正是这一招的
   * 全部内容。走出地图边界也无所谓 —— 推进距离已经被夹在出货视口里了（castSkill 里的
   * cappedReach），他到不了那么远。
   */
  private advanceHeavenGuards(dt: number): void {
    const guards = this.heavenGuards;
    for (let i = guards.length - 1; i >= 0; i--) {
      const g = guards[i];
      const actor = g.actor;

      if (g.drop > 0) {
        // 还在天上。不结算也不前进 —— 一个还没落地的人杀人，玩家读作"隔空死的"。
        g.drop -= dt;
        if (g.drop <= 0) {
          g.drop = 0;
          /*
           * 落地那一下：脚边推开一圈，并把这一圈里的人当场犁掉。
           *
           * 用 strikeAlongLunge 而不是 castRing，两个理由：castRing 的圈是按玩家的朝向和体格
           * 画的（它读的是 this.player），而这一下发生在离玩家十几个单位外的另一个人脚底下；
           * 更要紧的是**受力方向** —— 被砸中的人该朝这一排推进的方向两侧飞开，那正是 lunge
           * 那条规则算的，而环是朝四面八方推。
           *
           * 起点终点是同一个点，所以它退化成一个以落点为心的圆 —— 这条正是"线段判定"在零
           * 长度时该有的样子，不用另写一份。
           */
          this.strikeAlongLunge(
            actor.x, actor.y, actor.x, actor.y,
            g.heading,
            actor.radius + HEAVEN_GUARD_BODY_MARGIN,
            g.power, g.scale,
            HEAVEN_GUARD_HIT_GAP,
          );
          this.effects.spawn(actor.x, actor.y, g.heading, {
            power: 1,
            span: Math.PI * 2,
            from: 1,
            to: (actor.radius + HEAVEN_GUARD_BODY_MARGIN) * 1.6,
            life: 0.32,
            weight: 2.2,
            overhead: false,
            style: 'burst',
            tint: rgb(255, 228, 140),
          });
          this.debris.burst(actor.x, actor.y, 0, 0, g.power, actor.palette, 0.6);
        }
      } else if (g.left > 0) {
        const step = Math.min(g.speed * dt, g.left);
        const fromX = actor.x;
        const fromY = actor.y;
        actor.x += Math.cos(g.heading) * step;
        actor.y += Math.sin(g.heading) * step;
        g.left -= step;
        /*
         * 判定的是**这一帧走过的那条线段**，不是落点那一个圈。和突进同一条理由（见那一段）：
         * 掉帧时一步能跨过好几个身位，按圆判会把中间的人整个跳过去，玩家读作"从人身上穿过去
         * 了"。这一招尤其不能漏 —— 它的全部卖点就是身后那条空出来的路。
         */
        this.strikeAlongLunge(
          fromX, fromY, actor.x, actor.y,
          g.heading,
          actor.radius + HEAVEN_GUARD_BODY_MARGIN,
          g.power, g.scale,
          HEAVEN_GUARD_HIT_GAP,
        );
      } else {
        // 推到头了。站着明灭几帧再散 —— 走到最后一步凭空消失读作画面卡了一下。
        // 这一段**不再结算**：一排停在原地还继续绞人的墙会变成一个可以站桩的杀阵。
        g.fade -= dt / HEAVEN_GUARD_FADE;
        actor.speed = 0;
        if (g.fade <= 0) {
          guards[i] = guards[guards.length - 1];
          guards.pop();
          continue;
        }
      }

      // 步态照常推进。他在天上的时候也走 —— 一个在半空中蹬腿的人比一个僵直落下来的更像
      // "从天而降"，而且落地那一帧的姿势已经是走着的，接得上。
      actor.update(dt, true);
    }
  }

  /**
   * 磐石的流星：转一格，撞该撞的人。
   *
   * 几颗由磐石的**技能等级**定，一级一颗、满级五颗 —— 这一招的升级方向是"更多颗"，不是
   * "转得更快"或者"撞得更疼"。多一颗在画面上是看得见的，而快一点疼一点只是数字变了。
   *
   * 一遍遍历敌人、里面比五颗流星，不是五遍遍历：场上随时几百个人，遍历本身比距离计算贵。
   */
  private advanceOrbit(dt: number): void {
    const { player } = this;
    const owned = this.skillLoadout.guardSkill === 'bulwark' && player.alive;
    this.orbit.count = owned ? Math.max(1, this.skillLoadout.level('bulwark')) : 0;
    if (this.orbit.count === 0) return;

    this.orbit.radius = player.stats.attackRange * ORB_ORBIT_REACH;
    // 流星每帧都在重新算位置，所以倍率也每帧现取 —— 它不是一次放出去的东西，升级当场生效。
    const orbScale = this.skillLoadout.damageScale('bulwark');
    this.orbit.angle = (this.orbit.angle + ORB_SPIN * dt) % (Math.PI * 2);

    const step = (Math.PI * 2) / this.orbit.count;
    const radius = this.orbit.radius;
    const now = this.elapsed;
    // 五颗的位置这一帧只算一次，下面每个敌人都拿它比。
    const orbX = this.orbitX;
    const orbY = this.orbitY;
    for (let i = 0; i < this.orbit.count; i++) {
      const a = this.orbit.angle + step * i;
      orbX[i] = player.x + Math.cos(a) * radius;
      orbY[i] = player.y + Math.sin(a) * radius;
    }

    const reach = ORB_HIT_RADIUS;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (now - e.orbHitAt < ORB_HIT_GAP) continue;
      const hit = reach + e.radius;
      for (let i = 0; i < this.orbit.count; i++) {
        const dx = e.x - orbX[i];
        const dy = e.y - orbY[i];
        if (dx * dx + dy * dy > hit * hit) continue;
        e.orbHitAt = now;
        this.strike(e, orbX[i], orbY[i], ORB_POWER, orbScale);
        break;
      }
    }
  }

  /** 这一帧五颗流星的位置。复用同一对数组 —— 每帧新建五个坐标对是白扔。 */
  private readonly orbitX = new Float64Array(SKILL_MAX_LEVEL);
  private readonly orbitY = new Float64Array(SKILL_MAX_LEVEL);

  /**
   * 玩家身上此刻**最外面**那一层罩子有多大，世界单位。
   *
   * 这是"技能搭配"那条规则的唯一实现点：身上挂着的罩子（金钟罩、天地法相，以后还会有别的）
   * 各有各的半径，而一次碰撞该按其中最大的那个算 —— 开着金钟罩去撞人，撞上的边界就是罩子
   * 的边界，不是人的身体。人比罩子宽的时候（罩子还没开，或者开的是个贴身的小罩）就按人算，
   * 所以这个函数永远不会让判定变小。
   *
   * 加一种新的持续罩子时，往下面这个数组里再加一行就够了，调用点一处都不用动。
   *
   * @param base 没有任何罩子时的判定半径，通常是人自己的身体加一点余量。
   */
  private guardReach(base: number): number {
    let reach = base;
    for (const aura of [this.aegis, this.dharma]) {
      if (aura && aura.left > 0) reach = Math.max(reach, aura.radius);
    }
    return reach;
  }

  /**
   * 按突进规则扫过一条线段：连续碰撞、向路径两侧击飞，并使用突进的力度和短定格。
   * 玩家突进与开天的剑体共用这一份，保证“按照突进技能处理”不是近似相同而是同一条代码路径。
   */
  private strikeAlongLunge(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    heading: number,
    hit: number,
    power: number,
    scale: number,
    immunity = 0,
  ): void {
    const segX = bx - ax;
    const segY = by - ay;
    const segLen2 = segX * segX + segY * segY;
    const dirX = Math.cos(heading);
    const dirY = Math.sin(heading);
    const now = this.elapsed;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      // 免疫窗口。突进和开天都不传（它们只有零点几秒，一个人最多被扫到一两帧），神兵天降要
      // 推三四秒，必须有它 —— 见 Character.plowHitAt。
      if (immunity > 0 && now - e.plowHitAt < immunity) continue;
      let t = segLen2 > 1e-9 ? ((e.x - ax) * segX + (e.y - ay) * segY) / segLen2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = e.x - (ax + segX * t);
      const dy = e.y - (ay + segY * t);
      const reach = hit + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;

      if (immunity > 0) e.plowHitAt = now;
      const side = -dx * dirY + dy * dirX;
      const sign = Math.abs(side) > 0.05 ? Math.sign(side) : e.sideBias;
      let kx = -dirY * sign + dirX * LUNGE_SIDE_FORWARD;
      let ky = dirX * sign + dirY * LUNGE_SIDE_FORWARD;
      const kl = Math.hypot(kx, ky) || 1;
      kx /= kl;
      ky /= kl;
      this.strike(e, e.x - kx * 10, e.y - ky * 10, power, scale, {
        force: LUNGE_FORCE,
        freeze: LUNGE_FREEZE,
      });
    }
  }

  // ---------------------------------------------------------------- 敌人

  /** 在弓弦撒放的那一帧，记录玩家此刻的位置并生成一支不追踪的箭。 */
  private fireEnemyArrow(archer: Character): void {
    const local = archer.pose.weaponGrip;
    const sin = Math.sin(archer.facing);
    const cos = Math.cos(archer.facing);
    const fromX = archer.x + local.x * sin + local.y * cos;
    const fromY = archer.y - local.x * cos + local.y * sin;
    const targetX = this.player.x;
    const targetY = this.player.y;
    const distance = Math.hypot(targetX - fromX, targetY - fromY);
    const total = clamp(distance / ENEMY_ARROW_SPEED, ENEMY_ARROW_MIN_TIME, ENEMY_ARROW_MAX_TIME);
    const startZ = Math.max(6, local.z);

    this.enemyArrows.push({
      attack: archer.stats.attack,
      fromX,
      fromY,
      targetX,
      targetY,
      x: fromX,
      y: fromY,
      z: startZ,
      previousX: fromX,
      previousY: fromY,
      previousZ: startZ,
      startZ,
      arcHeight: clamp(distance * 0.24, 14, 24),
      age: 0,
      total,
      landed: false,
      groundLeft: 0,
      opacity: 1,
    });
  }

  /** 推进固定弹道；命中玩家便消失，落空则保持入射角插在旧落点，数秒后渐隐。 */
  private advanceEnemyArrows(dt: number): void {
    const arrows = this.enemyArrows;
    const player = this.player;
    for (let i = arrows.length - 1; i >= 0; i--) {
      const arrow = arrows[i];
      if (arrow.landed) {
        arrow.groundLeft -= dt;
        arrow.opacity = clamp(arrow.groundLeft / ENEMY_ARROW_FADE_TIME, 0, 1);
        if (arrow.groundLeft > 0) continue;
        arrows[i] = arrows[arrows.length - 1];
        arrows.pop();
        continue;
      }

      arrow.previousX = arrow.x;
      arrow.previousY = arrow.y;
      arrow.previousZ = arrow.z;
      arrow.age += dt;
      const t = clamp(arrow.age / arrow.total, 0, 1);
      const position = enemyArrowPosition(arrow);
      arrow.x = position.x;
      arrow.y = position.y;
      arrow.z = position.z;

      if (t < 1) continue;

      const dx = player.x - arrow.targetX;
      const dy = player.y - arrow.targetY;
      const hit = player.radius + ENEMY_ARROW_HIT_MARGIN;
      if (player.alive && dx * dx + dy * dy <= hit * hit) {
        if (this.damagePlayer(arrow.attack, arrow.fromX, arrow.fromY)) this.deaths++;
        arrows[i] = arrows[arrows.length - 1];
        arrows.pop();
        continue;
      }

      arrow.age = arrow.total;
      arrow.landed = true;
      arrow.groundLeft = ENEMY_ARROW_GROUND_TIME;
      arrow.opacity = 1;
    }
  }

  private driveEnemies(dt: number, view: BattleView): void {
    const { player, field } = this;
    this.crowdDecisionFrame = (this.crowdDecisionFrame + 1) % CROWD_DECISION_GROUPS;

    const enemies = this.movers;
    enemies.length = 0;
    for (const enemy of this.enemies) enemies.push(enemy);
    for (const enemy of this.reserved) enemies.push(enemy);
    this.movementGrid.setMinCellSize(cellSizeFor(this.crowdSpacing));
    this.movementGrid.build(enemies);
    const activeCount = this.enemies.length;
    if (this.movementDue.length < enemies.length) this.movementDue = new Uint8Array(enemies.length);
    this.movementDue.fill(0, 0, enemies.length);
    const box = view.visible ?? view.spawn;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const data = i >= activeCount ? this.reserved[i - activeCount] : null;
      const near = data === null || this.inActiveArea(e.x, e.y, view, RESTORE_MARGIN);
      if (data) data.cooldown = Math.max(0, data.cooldown - dt);
      const moveDt = data ? data.motion.step(this.clock, dt, near) : dt;
      if (data && moveDt <= 0) continue;
      this.movementDue[i] = near ? 1 : 2;
      // 是否计算骨架只看真实镜头，移动规则对所有怪物一致。
      const onScreen =
        Math.abs(e.x - box.x) <= box.halfW + SCREEN_SLACK &&
        Math.abs(e.y - box.y) <= box.halfH + SCREEN_SLACK;
      if (e.alive) {
        const dx = player.x - e.x;
        const dy = player.y - e.y;
        const dist = Math.hypot(dx, dy);
        e.facing = Math.atan2(dy, dx);

        // 停在攻击距离的八成处，而不是正好在边缘上：卡在边缘的话玩家稍一后退就出圈，一群人
        // 会在"走两步"和"挥一下"之间反复横跳。
        //
        // 但不能比"两个人的身体贴在一起"还近 —— 那个距离他**到不了**，会被 clearPlayerBody
        // 每帧推回来，于是他永远以为自己还在赶路，一直播着走路动画原地踏步。取两者的大者，
        // 他就停在真正站得住的地方，然后老老实实出手。
        const stop = Math.max(
          e.stats.attackRange * 0.8,
          (player.spacing + e.spacing) * this.crowdSpacing,
        );
        if (dist > stop && e.stun <= 0) {
          // 落远了就跑起来。
          //
          // 玩家走 32、冲刺 60，敌人只有 20~33 —— 不提速的话，光是按住左键前进就能把整队甩在
          // 身后，割草游戏最要紧的那份"杀不完"的压迫感直接没了。
          //
          // 倍率 1.8 是按"走路甩不掉、冲刺能甩掉"倒推的：20~33 乘 1.8 得 36~59.4，全都快过
          // 走路的 32，又全都慢过冲刺的 60。于是冲刺是一张真能用的脱身牌，散步不是。离线跑
          // 九十秒、同屏上限 90：击杀 351 → 422（走）、365 → 453（冲刺）。
          //
          // 用一段斜坡而不是一个阈值：硬切会让卡在线上的人每帧在走和跑之间跳，而动画器是按
          // speed 混合步态的，跳档一眼看得出来。走斜坡的话，追上来的人自己就变成跑的姿势。
          const chase = clamp((dist - CHASE_NEAR) / (CHASE_FAR - CHASE_NEAR), 0, 1);
          const want = e.walkSpeed * (1 + (CHASE_BOOST - 1) * chase);

          // 找空位：正前方被占了就沿切线绕过去。room 是"还能直着走多少"，0 表示完全被堵。
          //
          // 包括远处无骨架的数据；共用邻居表才能在进入视口前就排好队、绕开前方的人。
          // 近处按三组轮流查询邻居；远处本来已是 10 Hz，轮到移动时直接决策。
          let room: number;
          let side: number;
          if (near) {
            const decision = this.crowdDecision(i, dx / dist, dy / dist, dist, stop);
            room = decision.room;
            side = decision.side;
          } else {
            room = this.slotAhead(i, dx / dist, dy / dist, dist);
            side = this.slotSide;
          }

          // 越是被堵住越慢，而且越靠后越慢。直行那一份按 room 走全速；绕行那一份先打个折，
          // 再按离玩家多远衰减 —— 见 SIDESTEP_SPEED 上那段。
          const shuffle = SIDESTEP_SPEED * clamp(SIDESTEP_NEAR / dist, 0, 1);
          // 快到站位时再乘一段减速，把"走"和"站定"之间那个硬开关抹平 —— 见 APPROACH_BAND。
          const approach = clamp((dist - stop) / APPROACH_BAND, 0, 1);
          // 目标速度不直接用，先滑过去 —— 见 PACE_TAU。
          const wantPace = (room + (1 - room) * shuffle) * approach;
          e.crowdPace += (wantPace - e.crowdPace) * (1 - Math.exp(-moveDt / PACE_TAU));
          const pace = e.crowdPace;

          let mx = (dx / dist) * room + (-dy / dist) * side * SIDESTEP * (1 - room);
          let my = (dy / dist) * room + (dx / dist) * side * SIDESTEP * (1 - room);
          const mlen = Math.hypot(mx, my);
          if (mlen > 1e-6) {
            mx /= mlen;
            my /= mlen;
          } else {
            mx = 0;
            my = 0;
          }
          // 没有寻路：撞上障碍就被推开，沿着它蹭过去。绕不过去的死角会卡住，但这张图上没有
          // 能围死人的东西 —— 真需要寻路的时候再说。
          // 远处较大的时间步拆成短碰撞步，避免高速越过树干；昂贵的邻居决策仍只做一次。
          const collisionSteps = Math.max(1, Math.ceil(moveDt / (1 / 30)));
          const stepX = mx * want * pace * moveDt / collisionSteps;
          const stepY = my * want * pace * moveDt / collisionSteps;
          let to = { x: e.x, y: e.y };
          for (let step = 0; step < collisionSteps; step++) {
            to = moveWithCollision(field.terrain, field.props, e.radius, to.x, to.y, to.x + stepX, to.y + stepY);
          }
          // 交给动画器的是**实际走了多远**，不是想走多快。
          //
          // 这两者在人堆里差得很远：挤在最里圈的人每帧只能蹭出零点几个单位，而按意图报速度
          // 的话他会以全速播走路循环 —— 一排原地大步流星的人，看着比穿模还假。蹭着树走的
          // 那种半速也是同一回事。动画器本来就是按 speed 混合步态的，喂给它真值即可。
          const moved = Math.hypot(to.x - e.x, to.y - e.y);
          e.speed = moveDt > 0 ? moved / moveDt : 0;
          e.x = to.x;
          e.y = to.y;
        } else {
          // 到位了：站定出手。crowdPace 也归零，免得下次起步带着旧值窜一下。
          e.crowdPace = 0;
          e.speed = 0;
          const decision = this.crowdDecisions.get(e);
          if (decision) decision.stale = true; // 重新起步时不能沿用站定前的邻居。
        }

        /*
         * 够得着就挥，**不管他走到没走到自己的槽位**。
         *
         * 以前这一句在"到位了"那个分支里。人堆里绝大多数人永远到不了位 —— 前面堵着一堆人，
         * 他们一直在蹭着挪，于是贴在玩家脸上也不出手。玩家的读法是"围了一圈人却没人打我"。
         * 现在只看一件事：你够不够得着。swing 自己带门（正在挥或者还在冷却就不受理），所以每帧调也无妨。
         *
         * 间隔里那点随机抖动是必须的：少了它，同一批贴上来的人会整齐划一地同时挥。
         */
        if (i < activeCount && reachable(e, player)) {
          const jitter = e.def.weapon === 'bow' ? ENEMY_ARCHER_SHOT_JITTER : ENEMY_SWING_JITTER;
          this.enemies[i].swing(this.enemySwingGap(e.def, e.stats) + Math.random() * jitter);
        }
      }

      if (i < activeCount) {
        const actor = this.enemies[i];
        if (actor.update(dt, onScreen) && player.alive) {
          if (actor.def.weapon === 'bow') this.fireEnemyArrow(actor);
          // 够得着就算打中：不判角度、不判碰撞（见 reachable）。
          else if (reachable(actor, player) && this.hitPlayer(actor)) this.deaths++;
        }
      }
    }
  }

  /** slotAhead 顺带算出来的绕行方向：+1 往左，-1 往右。 */
  private slotSide = 1;

  private crowdDecision(i: number, dirX: number, dirY: number, dist: number, stop: number): CrowdDecision {
    const e = this.movers[i];
    let decision = this.crowdDecisions.get(e);
    if (!decision) {
      decision = {
        group: this.crowdDecisionGroup++ % CROWD_DECISION_GROUPS,
        stale: true, dirX, dirY, crowdSpacing: this.crowdSpacing, room: 1, side: e.sideBias,
      };
      this.crowdDecisions.set(e, decision);
    }
    // 近身保持逐帧响应；追击方向急转或间距设置变化也立即重算。
    if (decision.stale ||
        decision.group === this.crowdDecisionFrame ||
        dist <= stop + APPROACH_BAND ||
        dirX * decision.dirX + dirY * decision.dirY < 0.94 ||
        decision.crowdSpacing !== this.crowdSpacing) {
      decision.room = this.slotAhead(i, dirX, dirY, dist);
      decision.side = this.slotSide;
      decision.stale = false;
      decision.dirX = dirX;
      decision.dirY = dirY;
      decision.crowdSpacing = this.crowdSpacing;
    }
    return decision;
  }

  /**
   * 第 i 个敌人朝 (dirX, dirY) 还能直着走多少，0..1；顺带把该往哪边绕写进 slotSide。
   *
   * 只给**比我更靠近玩家**的人让路。所有人都朝同一个点收拢，路径必然两两交叉，没有优先权
   * 的话"别撞上别人"会退化成"谁都别动"；按到玩家的距离排先后天然无环 —— 最里圈那个永远
   * 不让人，外面的依次绕着它找缝。
   *
   * 判的是一条**走廊**而不是扇形：那个人在不在我前面（沿朝向的投影为正且不远），以及他离
   * 我的行进直线偏多少（横向小于两人该有的间距才算挡路）。扇形会把并排的邻居也算进来，
   * 围成一圈之后前排互相刹车，谁都够不到玩家。
   */
  private slotAhead(i: number, dirX: number, dirY: number, distToPlayer: number): number {
    const { movementGrid: grid, movers: enemies, crowdSpacing, player } = this;
    const self = enemies[i];
    const items = grid.indices;
    const maxLook = (self.spacing + MAX_SPACING) * crowdSpacing * SLOT_LOOKAHEAD;
    const span = Math.max(1, Math.ceil(maxLook / grid.cellSize));
    const cx = grid.colOf(self.x);
    const cy = grid.rowOf(self.y);
    const x0 = Math.max(0, cx - span);
    const x1 = Math.min(grid.cols - 1, cx + span);
    const y0 = Math.max(0, cy - span);
    const y1 = Math.min(grid.rows - 1, cy + span);

    let room = 1;
    let side = 1;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const end = grid.end(gx, gy);
        for (let k = grid.begin(gx, gy); k < end; k++) {
          const j = items[k];
          if (j === i) continue;
          const other = enemies[j];
          if (!other.alive) continue;
          const ox = other.x - player.x;
          const oy = other.y - player.y;
          if (ox * ox + oy * oy >= distToPlayer * distToPlayer) continue;

          const dx = other.x - self.x;
          const dy = other.y - self.y;
          const along = dx * dirX + dy * dirY;
          if (along <= 0) continue;
          const touch = (self.spacing + other.spacing) * crowdSpacing;
          const look = touch * SLOT_LOOKAHEAD;
          if (along >= look) continue;
          const lateral = dx * -dirY + dy * dirX;
          if (Math.abs(lateral) >= touch) continue;

          const k2 = clamp((along - touch) / (look - touch), 0, 1);
          if (k2 < room) {
            room = k2;
            // 往远离他的那一侧绕。他基本正对着我时横向偏移在零附近抖，这时候按符号选边会
            // 每帧翻一次，人在原地左右抽搐 —— 所以改用这个人固定的习惯侧，见 sideBias。
            side =
              Math.abs(lateral) > touch * 0.25 ? (lateral > 0 ? -1 : 1) : self.sideBias;
          }
        }
      }
    }
    this.slotSide = side;
    return room;
  }

  /**
   * 互相推开。不是寻路，只是不让一群人叠在同一个像素上 —— 少了这一步，一百个杂兵会精确地
   * 重合成一个人，人群完全读不出数量。用全图移动网格查邻居，完整怪物和数据怪物共享此规则。
   */
  private separate(): void {
    const enemies = this.movers;
    const grid = this.movementGrid;
    grid.build(enemies);
    // 必须在 build **之后**取：人数涨过上次容量时 build 会重开这个数组，先取就拿到旧的那根了。
    const items = grid.indices;

    for (let pass = 0; pass < this.separationPasses; pass++) {
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      const due = this.movementDue[i];
      if (!a.alive || due === 0 || (due === 2 && pass > 0)) continue;
      const cx = grid.colOf(a.x);
      const cy = grid.rowOf(a.y);
      const x0 = cx > 0 ? cx - 1 : 0;
      const x1 = cx < grid.cols - 1 ? cx + 1 : grid.cols - 1;
      const y0 = cy > 0 ? cy - 1 : 0;
      const y1 = cy < grid.rows - 1 ? cy + 1 : grid.rows - 1;

      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const end = grid.end(gx, gy);
          for (let k = grid.begin(gx, gy); k < end; k++) {
            // 两者本轮都更新时只处理 j > i；另一只没轮到，也要允许当前这只与它分离。
            //
            // 试过按"到玩家的距离从近到远"排序再扫，指望修正一趟就从里圈推到外圈。实测在
            // 一千人时间距只从 9.2 变成 9.3（噪声），却多花 0.4 毫秒排序 —— 因为瓶颈根本不
            // 是修正传得快不快，是那么多人**真的没地方站**（见 separationPasses 上那段）。
            const j = items[k];
            const otherDue = this.movementDue[j] === 1 || (pass === 0 && this.movementDue[j] === 2);
            if (j === i || (j < i && otherDue)) continue;
            const b = enemies[j];
            if (!b.alive) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const min = (a.spacing + b.spacing) * this.crowdSpacing;
            const d2 = dx * dx + dy * dy;
            if (d2 >= min * min || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const push = (min - d) * 0.5;
            const nx = (dx / d) * push;
            const ny = (dy / d) * push;
            a.x -= nx;
            a.y -= ny;
            b.x += nx;
            b.y += ny;
          }
        }
      }
    }
    }

    this.clearPlayerBody();
  }

  /**
   * 把压在玩家身上的人推出去。
   *
   * 玩家**不动**：他有体积，但质量当成无穷大。互推的话，一圈人能把玩家从人堆里挤出去 ——
   * 割草游戏里那是最难受的一种失控，明明没按任何键，人却在漂。所以推的是敌人那一边。
   *
   * 只查玩家所在的 3x3 格，所以这一步和场上有多少人无关。
   */
  private clearPlayerBody(): void {
    const { player, movementGrid: grid } = this;
    const items = grid.indices;
    const enemies = this.movers;
    const cx = grid.colOf(player.x);
    const cy = grid.rowOf(player.y);
    const x0 = cx > 0 ? cx - 1 : 0;
    const x1 = cx < grid.cols - 1 ? cx + 1 : grid.cols - 1;
    const y0 = cy > 0 ? cy - 1 : 0;
    const y1 = cy < grid.rows - 1 ? cy + 1 : grid.rows - 1;

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const end = grid.end(gx, gy);
        for (let k = grid.begin(gx, gy); k < end; k++) {
          const e = enemies[items[k]];
          if (!e.alive) continue;
          const dx = e.x - player.x;
          const dy = e.y - player.y;
          const min = (player.spacing + e.spacing) * this.crowdSpacing;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          if (d2 < 1e-6) {
            // 正好压在中心：没有方向可推，随便挑一个，下一帧就正常了。
            e.x = player.x + min;
            continue;
          }
          const d = Math.sqrt(d2);
          const push = (min - d) / d;
          e.x += dx * push;
          e.y += dy * push;
        }
      }
    }
  }

  // ---------------------------------------------------------------- 出怪

  /**
   * 按模板出兵。
   *
   * 计时是连续的（模板给的是"每秒几个"），真正放人却仍然按 SPAWN_INTERVAL 一小批一小批地
   * 放 —— 摊到每一帧一个一个地生，人是"渗"进画面的；攒 0.18 秒再一起放，是一小群一起走进来。
   * 后者才像一支队伍。
   */
  private spawnWave(dt: number, view: BattleView): void {
    // 旋钮是模板速度的倍率，顶满就是原速。见 MAX_SPAWN_BATCH。
    this.waves.update(dt, this.spawnBatch / MAX_SPAWN_BATCH);
    if (this.waves.takeWaveStart()) {
      this.surgeCeiling = this.enemies.length + this.waves.wave.surge;
      // 篝火一波只点一次。按秒数刷的话玩家在四处营地之间转一圈就能一直拿，那就不是补给而是水龙头了。
      this.field.props.relight();
    }
    /*
     * 一波到点就放一个首领。
     *
     * 不走普通出兵那条队：那一条要看场上还容不容得下，而末波场上常年顶着人数上限 —— 首领
     * 排在那条队里的话这一波就白打了。他只有一个，多出来这一个人不会把帧压垮。
     */
    /*
     * 先结上一批的账，再放下一批。**顺序不能反**。
     *
     * 截止线恰好落在下一波到点那一帧，而那一帧也正是新一批首领出场的时刻。先放人再判的话，
     * 新那条截止线当场把旧的覆盖掉，于是永远判不出输 —— 漏掉的那几个一直滞留到打完全场。
     */
    if (this.outcome === 'none' && this.bossDeadline > 0
      && this.runTime >= this.bossDeadline && this.bossAlive) {
      this.outcome = 'lost';
    }
    const due = this.waves.takeBossDue();
    if (due > 0) {
      for (let i = 0; i < due; i++) this.spawn(view, resolveKind(BOSS_KIND));
      /*
       * 截止线**只给最后那一批**。
       *
       * 之前每一波的首领都挂一条（时长是下一波的时长），没按时打完就当场判负。两个毛病：
       *
       *   那条线**是看不见的** —— 波次面板上的红字倒计时只在最后一波亮。玩家血还剩着、
       *   什么提示都没有，突然就进结算了，从他的角度这和一个 bug 没区别。
       *
       *   一局里有八次"不打完就死"的压力，而这一局真正的目标只有一个。
       *
       * 现在前面几波的首领杀不杀得掉都不影响胜负，只是少拿一份掉落；他不会被回收，小地图上那个
       * 髅髅一直亮着，玩家随时可以回头找他。没找的话他就会站到决战那一刻，跟最后那一批
       * 一起算进“全都清掉才算赢”里 —— 欠的帐最后一起还。
       */
      this.bossDeadline = this.waves.lastWaveOver ? this.runTime + FINAL_BOSS_LIMIT : 0;
    }
    if (this.outcome === 'none' && !this.bossAlive) {
      this.bossDeadline = 0;
      // 最后一波的那几个也清了，这一局就赢了。
      if (this.waves.lastWaveOver) this.outcome = 'won';
    }
    this.spawnTimer += dt;
    while (this.spawnTimer >= SPAWN_INTERVAL) {
      this.spawnTimer -= SPAWN_INTERVAL;
      const batch = this.waves.take(this.localSpawnRoom());
      for (let i = 0; i < batch; i++) {
        // 每个人各自摇兵种：一批里混着几种兵，才不会读成"这一小队全是盾兵"。
        // 放不下就把剩下的名额退回去，等下一批 —— 配额是模板承诺的人数，不该被一次失败吃掉。
        if (!this.spawn(view)) {
          this.waves.refund(batch - i);
          break;
        }
      }
    }
  }
}
