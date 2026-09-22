import { SkillCategoryRules, skillById, type SkillId } from '../game/skills';
import { SPRINT_SKILL } from '../game/skillLoadout';
import type { HudText, HudTextKey } from './text/hudText';
import type { StatBonus } from '../data/types';
import { HUD_ICON_URLS } from './hudIcons';
import { SKILL_ICONS } from './skillIcons';
import { SkillFigure } from './skillFigure';
import type { HeroDef } from '../data/types';
import { HudFrame } from './hudFrame';
import { currentItems } from './currentItems';
import type { ItemStripEntry } from './itemStrip';
import {
  CARD_GOLD_AMOUNTS,
  CARD_OBTAIN_FROM,
  STAT_CARD_CAP,
  skillDamageScale,
  SKILL_LEVEL_REACH,
} from '../data/balance';
import './hudCardPicker.css';

/**
 * 一张牌的内容，外加选中它之后**真的发生什么**。
 *
 * 加上 bonus / skill 这两样之前，这块界面是纯摆设：抽三张、点掉，一个数都不改。现在属性牌
 * 给一份本局有效的加成（Battle.addRunBonus），技能牌解锁一个这个角色还没有的主动技 —— 后者
 * 是"主动技能要在游戏里获得"这条规则唯一的落地点，另一条路是以后的商店。
 */
export interface HudCardOffer {
  /** 属性牌是 'attack' 这类词，技能牌是技能 id。用来避免一次抽到两张一样的。 */
  key: string;
  icon: string;
  name: string;
  detail: string;
  /** 属性牌：这一局加什么。跨局不保留。 */
  bonus?: StatBonus;
  /** 技能牌：这一张说的是哪一招。 */
  skill?: SkillId;
  /** 技能牌是"获取"（这一局还没有它）还是"升一级"。 */
  obtain?: boolean;
  /** 金币牌：给多少金币。只在什么都满了的时候出。 */
  gold?: number;
}

/** 属性牌可能出现的幅度，百分比。 */
const STAT_STEPS = [8, 12, 15, 20];

interface StatCard {
  key: keyof StatBonus;
  icon: string;
  nameKey: HudTextKey;
  /** 这一项的幅度要不要打折。不写就是 1。 */
  scale?: number;
  /** 说明文案的 key，里面带一个 {value}：本次抽中的幅度（已经乘过 scale）。 */
  detailKey: HudTextKey;
}

/**
 * 属性牌的货架。key 直接就是 UnitStats 上的字段名 —— 这样一张牌要加什么是**写出来**的，
 * 不需要在别处再维护一张"卡名到属性"的对照表。
 */
const STAT_CARDS: StatCard[] = [
  { key: 'attack', icon: HUD_ICON_URLS.swords, nameKey: 'cardAttack', detailKey: 'cardAttackDetail' },
  { key: 'attackSpeed', icon: HUD_ICON_URLS.fire, nameKey: 'cardAttackSpeed', detailKey: 'cardAttackSpeedDetail' },
  {
    key: 'attackRange',
    icon: HUD_ICON_URLS.bow,
    nameKey: 'cardAttackRange',
    detailKey: 'cardAttackRangeDetail',
    scale: 0.5,
  },
  { key: 'pickupRange', icon: HUD_ICON_URLS.gem, nameKey: 'cardPickupRange', detailKey: 'cardPickupRangeDetail' },
  { key: 'defense', icon: HUD_ICON_URLS.shield, nameKey: 'cardDefense', detailKey: 'cardDefenseDetail' },
  { key: 'moveSpeed', icon: HUD_ICON_URLS.boots, nameKey: 'cardMoveSpeed', detailKey: 'cardMoveSpeedDetail' },
  { key: 'maxHp', icon: HUD_ICON_URLS.heart, nameKey: 'cardMaxHp', detailKey: 'cardMaxHpDetail' },
  { key: 'mpRegen', icon: HUD_ICON_URLS.potion, nameKey: 'cardMpRegen', detailKey: 'cardMpRegenDetail' },
];

/** 一轮摆几张牌。 */
const CARD_COUNT = 3;

/**
 * 出场动画时长。取的是最长的那条 —— 选中卡牌浮上去的 hud-card-taken；没选的两张
 * 140ms 就退完了。和 hudCardPicker.css 里的时长是一对，改一处要改两处。
 */
const EXIT_MS = 200;

/**
 * 从候选里接着抽，抽到 out 有 upTo 张为止。**三张之间既不重样、也不撞图**。
 *
 * 续摆而不是一次抽完：三格里要先给技能牌留一格，剩下的才从全部货架里抽。
 *
 * 光靠"从池子里取走"是不够的：那只保证不抽到同一条记录，而不同的记录仍然可能共用一张图。
 * 玩家读牌先看图 —— 两张一样的图摆在一起，第一反应是"这一轮出重复了"，哪怕名字不同。所以
 * 这里额外按 icon 去一遍重。
 *
 * 去重之后可能凑不满三张（牌库快抽空的时候）。那就有多少给多少：少一张牌比摆一张重复的强。
 */
function take(pool: HudCardOffer[], upTo: number, out: HudCardOffer[], icons: Set<string>): void {
  const rest = pool.filter((offer) => !out.some((had) => had.key === offer.key));
  while (out.length < upTo && rest.length > 0) {
    const [offer] = rest.splice(Math.floor(Math.random() * rest.length), 1);
    if (icons.has(offer.icon)) continue;
    icons.add(offer.icon);
    out.push(offer);
  }
}

/**
 * 灵石收满后弹出的三选一卡牌。
 *
 * **这一版只有界面**：抽牌、显示、点掉，选中不改任何数值。弹出期间世界是停住的
 * （main.ts 的 ticker 跳过 update），先把版式和信息量摆出来看效果，接玩法是下一步。
 */
/**
 * 这块界面要问外面一件事、告诉外面两件事：还能解锁哪些技能，以及玩家选了属性牌还是技能牌。
 *
 * 做成回调而不是让它直接拿着 Battle：这是一块 DOM，它不该认识战斗引擎，HUD 的其余部分也
 * 都不认识。
 */
export interface HudCardHooks {
  /**
   * 这一局还没拿到的招：主动技、发射技、这个角色的护身技。
   *
   * 一局是从"一个自动攻击技 + R 上的疾走"开始的，别的全在这张单子上。
   */
  obtainableSkills(): SkillId[];
  /** 这一局还能升级的技能：已经拿到了、而且没满级。 */
  upgradableSkills(): { id: SkillId; level: number; max: number }[];
  /** 现在是谁在打。牌面上那个台子要画的就是他 —— 四个角色拿同一招长得不一样。 */
  hero(): HeroDef;
  /** 玩家选了一张属性牌。 */
  onStatCard(bonus: StatBonus): void;
  /** 玩家选了一张"获取"牌。 */
  onObtainSkill(skill: SkillId): void;
  /** 玩家选了一张"升级"牌。 */
  onUpgradeSkill(skill: SkillId): void;
  /** 玩家选了那张金币牌。金币是跨局的家底，直接进存档。 */
  onGoldCard(amount: number): void;
  /**
   * 牌刚弹出来。目前只用来发一声音效。
   *
   * 走钩子而不是在这里直接 `play`：ui/ 这一层至今没有一个文件引过 audio/，而 audio/bank.ts
   * 里那条规矩是"只能被浏览器那一侧引到" —— `.ogg` 一旦进了 node 侧的依赖图，esbuild 打
   * `npm run bench` 和 tools/ 那几个离线脚本时就没有 loader 了，当场挂掉。现在这个文件不在
   * 那张图里，直接引也不会炸；但把这条边连上，就等着哪天有人从 preview.ts 顺藤摸过来。
   *
   * 和战斗层推语义队列、由 main 翻译成音效是同一个套路：界面只说"发生了什么"。
   */
  onShow?(): void;
  /**
   * 选完了，牌正在飞出去。
   *
   * 在出场动画**起点**发，不是等 200ms 动画跑完 —— 声音要和看见的东西同时开始，
   * 和 onShow 挂在入场动画起点是同一个道理。
   *
   * 只有"选完"这一条路会发。菜单里关掉开关、人死了、打完一局回选人也会收牌（走 hide），
   * 那几种是"牌被撤掉"而不是"玩家做完了一次选择"，不该有回响。
   */
  onDismiss?(): void;
  /**
   * 手上有哪些药和符。摆在牌底下，图在上、字在下，排法和战场上的快捷栏一致。
   *
   * 为什么摆在这儿：抽牌是一局里**世界停住**的两个时刻之一（另一个是结算），而快捷栏上那几格
   * 只有图和数字，说不出按下去会发生什么。玩家正要决定"这一轮拿什么"，那他手上已经有什么就
   * 是这个决定的一半。
   */
  heldItems(): ItemStripEntry[];
}

export class HudCardPicker {
  readonly root = document.createElement('div');

  private hooks: HudCardHooks | null = null;

  private readonly frame = new HudFrame({ className: 'hud-card-panel' });
  private readonly row = document.createElement('div');
  /** 牌底下那一行"我现在有什么"。 */
  private readonly cards: HTMLButtonElement[] = [];
  private offers: HudCardOffer[] = [];
  /** 出场动画跑完才真正藏起来；这期间不再接受选择。 */
  private closing = 0;
  /**
   * 这一局已经抽过几轮。前几轮不上新招（见 CARD_OBTAIN_FROM）。
   */
  private round = 0;
  /** 每一项属性牌这一局拿过几张。拿满就下架（见 STAT_CARD_CAP）。 */
  private readonly statTaken = new Map<string, number>();
  /**
   * 这一轮牌上那几个台子。开着的时候由一个 rAF 推，收牌时停。
   *
   * 自己起一个循环而不是搭主循环：弹牌那一刻世界是停住的（main 里直接 return），
   * 而这几个台子恰恰要在那段时间里动。
   */
  private readonly figures: SkillFigure[] = [];
  private raf = 0;
  private lastFrame = 0;

  /** 接上结算。不接也能弹、能点，只是不产生效果 —— 离线预览图就是这么用的。 */
  connect(hooks: HudCardHooks): void {
    this.hooks = hooks;
  }

  private readonly text: HudText;

  constructor(text: HudText) {
    this.text = text;
    this.root.className = 'hud-card-picker';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', this.text.value('cardPicker'));

    this.row.className = 'hud-card-row';
    for (let i = 0; i < CARD_COUNT; i++) {
      const card = this.createCard(i);
      this.cards.push(card);
      this.row.appendChild(card);
    }

    this.frame.content.appendChild(this.row);
    this.root.appendChild(this.frame.root);
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** 抽三张并弹出。已经开着就不再抽，免得后一次收满把玩家正在看的牌换掉。 */
  show(): void {
    if (this.open) return;
    this.cancelClose();
    this.figures.length = 0;
    this.offers = this.roll();
    for (let i = 0; i < this.cards.length; i++) this.fill(this.cards[i], this.offers[i]);
    // 和结算那块共用同一个节点，所以两处的位置天然重合（见 currentItems.ts）。
    currentItems.show('cards', this.hooks?.heldItems() ?? []);
    this.root.hidden = false;
    // 先清空再设回 'in'：菜单里直接关掉时不会经过 'out'，值没变的话入场动画不会重播。
    // 中间那下读 offsetWidth 是为了逼浏览器把清空这一步结算掉。
    this.root.dataset.phase = '';
    void this.root.offsetWidth;
    this.root.dataset.phase = 'in';
    this.startFigures();
    // 放在最后：上面那一串一旦抛了，牌根本没弹出来，也就不该有声音。
    this.hooks?.onShow?.();
  }

  /** 台子的循环。牌一开就跑，一收就停 —— 没牌的时候一帧都不该占。 */
  private startFigures(): void {
    this.stopFigures();
    if (this.figures.length === 0) return;
    this.lastFrame = performance.now();
    const tick = (now: number): void => {
      // 夹一下：切后台再回来会攒出一个很大的步长，那会把整段动作一帧跳完。
      const dt = Math.min((now - this.lastFrame) / 1000, 1 / 20);
      this.lastFrame = now;
      for (const figure of this.figures) figure.step(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopFigures(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * 新的一局。轮次和属性牌的计数都清掉。
   *
   * 跟着 Hud.setGemsPerCycle 走 —— 那一句本来就是"换图了，灵石进度从头算"，和这里要清的
   * 是同一件事。自己再开一个 reset 只会多一个要记得调的地方。
   */
  resetRun(): void {
    this.round = 0;
    this.statTaken.clear();
  }

  /** 立刻收起，不走动画。菜单里关掉开关走这条。 */
  hide(): void {
    this.stopFigures();
    this.cancelClose();
    this.blurCards();
    this.root.hidden = true;
    this.root.dataset.phase = '';
    currentItems.hide('cards');
  }

  /**
   * 点过的那张牌会一直带着焦点，:focus-visible 的高亮就赖在上面不走 —— 鼠标明明已经
   * 移开了，牌看起来还是选中的。收场时把焦点交还给 body。
   */
  private blurCards(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.root.contains(active)) active.blur();
  }

  /**
   * 数字键选牌，从左到右对应 1/2/3。牌面上不画编号（画了反而像在标稀有度），
   * 但键还是留着——鼠标已经在画面中间了，顺手按个数字比挪过去点更快。
   *
   * 返回是否吃掉了这一下按键，调用方据此决定要不要继续走原来的逻辑。
   */
  choose(index: number): boolean {
    if (!this.open || this.closing || index < 0 || index >= this.offers.length) return false;
    const offer = this.offers[index];
    this.round++;
    if (offer.gold !== undefined) this.hooks?.onGoldCard(offer.gold);
    else if (offer.bonus) {
      this.statTaken.set(offer.key, (this.statTaken.get(offer.key) ?? 0) + 1);
      this.hooks?.onStatCard(offer.bonus);
    } else if (offer.skill && offer.obtain) this.hooks?.onObtainSkill(offer.skill);
    else if (offer.skill) this.hooks?.onUpgradeSkill(offer.skill);
    // 这一版没有效果可以结算，选中就只剩下收场。选中那张单独标一下，出场时的动作和
    // 另外两张不一样。
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i].classList.toggle('hud-card--taken', i === index);
    }
    this.root.dataset.phase = 'out';
    this.hooks?.onDismiss?.();
    // 动画跑完再藏。open 在这期间仍然是 true，所以世界会多停这 200ms —— 正好让牌浮出去。
    this.closing = setTimeout(() => {
      this.closing = 0;
      this.blurCards();
      this.stopFigures();
      this.root.hidden = true;
      this.root.dataset.phase = '';
      currentItems.hide('cards');
    }, EXIT_MS) as unknown as number;
    return true;
  }

  private cancelClose(): void {
    if (!this.closing) return;
    clearTimeout(this.closing);
    this.closing = 0;
  }

  /**
   * 抽三张。货架上有三种东西，上架规则各不相同：
   *
   *   **属性牌** —— 每一项一局最多拿 STAT_CARD_CAP 张，拿满就下架。不封顶的话，
   *   一局三十多张牌可以全砸在攻击力上，而那不是一个构筑，是一个乘法。
   *
   *   **获取牌**（这一局还没拿到的招）—— 前 CARD_OBTAIN_FROM 轮不上。开局只有一个
   *   自动攻击技，第一张牌就塞一招新的进来的话，玩家手上立刻有两件没练过的东西。
   *
   *   **升级牌** —— 已经在用、还没满级的招。从第一轮就在。
   *
   * **只要还有技能牌，三格里就留一格给它。**
   *
   * 最要紧的是头两轮：那时货架上只有八张属性牌加一张自动攻击技的升级，不留格的话
   * 那一张升级只有三成三的机会露面 —— 也就是说有三分之二的开局玩家根本没得选，
   * 只能在三张属性牌里挑一张。而头两轮不上新招的全部意义就是"先把本命那一招推上去"。
   * 留一格之后，每一轮都至少有一张招式牌。
   *
   * 什么都没了（招全拿全满、属性也封顶）就摆一张金币牌。只摆一张：这一轮已经没有选择了，
   * 摆三张一模一样的牌只是把"没得选"写成了三遍。
   */
  private roll(): HudCardOffer[] {
    const stats: HudCardOffer[] = STAT_CARDS
      .filter((c) => (this.statTaken.get(c.key) ?? 0) < STAT_CARD_CAP)
      .map((c) => {
        const step = STAT_STEPS[Math.floor(Math.random() * STAT_STEPS.length)];
        return {
          key: c.key,
          icon: c.icon,
          name: this.text.value(c.nameKey),
          detail: this.text.value(c.detailKey, { value: Math.round(step * (c.scale ?? 1)) }),
          bonus: { [c.key]: (step * (c.scale ?? 1)) / 100 } as StatBonus,
        };
      });
    // 获取：这一局还没拿到的招。牌面上写清它是哪一类，那决定它会占哪一格。
    const obtain: HudCardOffer[] = this.round < CARD_OBTAIN_FROM
      ? []
      : (this.hooks?.obtainableSkills() ?? []).map((id) => {
        const skill = skillById(id);
        return {
          key: `get:${id}`,
          icon: SKILL_ICONS[id],
          name: this.text.value(skill.nameKey),
          detail: `${this.text.value(skill.noteKey)}
${this.text.value('cardObtain', { kind: this.text.value(SkillCategoryRules[skill.category].nameKey) })}`,
          skill: id,
          obtain: true,
        };
      });
    /*
     * 升级：已经在用、还没满级的招。牌面上写清现在几级、升到几级。
     *
     * **前两轮把疾走撤下去。** 开局手上是两招（本命 + 疾走），而留给技能牌的只有一格 ——
     * 两个人抢一格，本命那一张就只剩一半的机会站在那儿。离线跑一百万次量出来：前两轮
     * 本命牌只有 **62.5%** 的场次会出现，另外 37.5% 玩家看到的是一张疾走升级加两张属性牌。
     *
     * 而那 37.5% 恰好把"前两轮不上新招"这条规则的意义整个抵消掉了 —— 它存在的全部理由就是
     * "先把本命那一招推上去"（见 CARD_OBTAIN_FROM）。更糟的是疾走的那一级在这个时候几乎
     * 不改变什么：它没有作用距离、没有法力开销，升一级只是跑起来省一点蓝、冷却短一点，
     * 而开局那两轮玩家还没到"跑到脱力"的场面。一张看着是选择、实际是弃权的牌。
     *
     * 撤的只是**前两轮**，不是把它赶出牌库：满配那笔账（CARD_PICKS_FOR_FULL_BUILD）把八个
     * 技能都算进去了，疾走从第三轮起照常上架。
     */
    const upgrade: HudCardOffer[] = (this.hooks?.upgradableSkills() ?? [])
      .filter((entry) => !(this.round < CARD_OBTAIN_FROM && entry.id === SPRINT_SKILL))
      .map((entry) => {
      const skill = skillById(entry.id);
      // 伤害那一条是现算的：每级的增量是固定的，但它占当前值的比例逐级变小
      // （一级升二级 +25%，四级升满级 +14%）。写死一个数就有四分之三的时候是假的。
      const gain = Math.round((skillDamageScale(entry.level + 1) / skillDamageScale(entry.level) - 1) * 100);
      const reach = Math.round(SKILL_LEVEL_REACH * 100);
      return {
        key: `up:${entry.id}`,
        icon: SKILL_ICONS[entry.id],
        name: this.text.value(skill.nameKey),
        detail: `${this.text.value(skill.noteKey)}
${this.text.value('cardSkillUpgrade', {
  from: entry.level,
  to: entry.level + 1,
  damage: gain,
  reach,
})}`,
        skill: entry.id,
      };
    });

    const skills = [...obtain, ...upgrade];
    if (stats.length === 0 && skills.length === 0) return [this.goldOffer()];

    const out: HudCardOffer[] = [];
    const icons = new Set<string>();
    // 先给技能牌留一格，剩下两格从全部货架里抽。
    take(skills, 1, out, icons);
    take([...stats, ...skills], CARD_COUNT, out, icons);
    return out;
  }

  /** 什么都满了之后那一张。 */
  private goldOffer(): HudCardOffer {
    const gold = CARD_GOLD_AMOUNTS[Math.floor(Math.random() * CARD_GOLD_AMOUNTS.length)];
    return {
      key: `gold:${gold}`,
      icon: HUD_ICON_URLS.coin,
      name: this.text.value('gold'),
      detail: `本局已经满配
金币 +${gold}（带得走）`,
      gold,
    };
  }

  private createCard(index: number): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'hud-card';

    /*
     * 图那一格现在是一个**台子**：底下是技能演示（打到哪儿），图标压在上面。
     *
     * 两样都要：图标是这一招的**身份**（快捷栏、选人界面、商店里认的都是它），
     * 而演示回答的是第一次看到它的人真正要问的那一件事。只留一样都会丢掉另一半。
     */
    const stage = document.createElement('div');
    stage.className = 'hud-card-stage';
    const icon = document.createElement('img');
    icon.className = 'hud-card-icon';
    icon.alt = '';
    icon.draggable = false;
    stage.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'hud-text hud-text--pixel hud-card-name';
    const detail = document.createElement('span');
    detail.className = 'hud-text hud-text--pixel hud-card-detail';

    // 角标：新招写"NEW"，升级画一个向上的箭头。属性牌两样都没有。
    const tag = document.createElement('span');
    tag.className = 'hud-text hud-text--pixel hud-card-tag';
    tag.hidden = true;
    // 牌下面那行说明已经写了"等级 +1"，角标只是把它挑到轮廓上，读屏不必再念一遍。
    tag.setAttribute('aria-hidden', 'true');

    card.append(stage, name, detail, tag);
    card.addEventListener('click', () => this.choose(index));
    return card;
  }

  private fill(card: HTMLButtonElement, offer: HudCardOffer | undefined): void {
    card.hidden = !offer;
    if (!offer) return;
    (card.querySelector('.hud-card-icon') as HTMLImageElement).src = offer.icon;

    /*
     * 技能牌底下铺一层演示（见 skillDemo.ts），属性牌没有 —— "攻击力 +15%" 没有形状可言。
     *
     * 每次重建而不是缓存：一轮才三张牌，而同一格上一轮是什么招下一轮就不是了，
     * 留着的话还得判一遍"还是不是同一招"。
     */
    const stage = card.querySelector('.hud-card-stage') as HTMLElement;
    stage.querySelector('.skill-figure')?.remove();
    stage.classList.toggle('hud-card-stage--figure', offer.skill !== undefined);
    if (offer.skill && this.hooks) {
      const figure = new SkillFigure(this.hooks.hero(), offer.skill);
      stage.insertBefore(figure.canvas, stage.firstChild);
      this.figures.push(figure);
    }

    // 角标。新招写 NEW，升级画箭头 —— 两者在牌面上其实很像，而它们是两件完全不同的事。
    const tag = card.querySelector('.hud-card-tag') as HTMLElement;
    const kind = offer.skill ? (offer.obtain ? 'new' : 'up') : '';
    tag.hidden = kind === '';
    // 升级那一版是空的：箭头由 CSS 切出来（见 hudCardPicker.css 的 --up::before）。
    tag.textContent = kind === 'new' ? 'NEW' : '';
    tag.classList.toggle('hud-card-tag--new', kind === 'new');
    tag.classList.toggle('hud-card-tag--up', kind === 'up');
    (card.querySelector('.hud-card-name') as HTMLElement).textContent = offer.name;
    // 说明里的换行是内容自己带的（技能牌是"招式说明 + 等级 +1"两行）。
    const detail = card.querySelector('.hud-card-detail') as HTMLElement;
    detail.textContent = '';
    offer.detail.split('\n').forEach((line, i) => {
      if (i > 0) detail.appendChild(document.createElement('br'));
      detail.appendChild(document.createTextNode(line));
    });
    card.setAttribute('aria-label', `${offer.name}：${offer.detail.replace('\n', '，')}`);
  }
}
