import minimapFrameUrl from '../../assets/hud/minimap-frame.png';
import type { Battle } from '../game/battle';
import type { Field } from '../game/field';
import type { Camera } from '../render/camera';
import './hud.css';
import { Minimap } from './minimap';
import { HudProgressBar } from './hudProgressBar';
import { HudCardPicker } from './hudCardPicker';
import { HudFrame } from './hudFrame';
import { createHudIcon } from './hudIcons';
import { startCursorBreathing } from './cursorImage';
import { HudWavePanel } from './hudWavePanel';
import { HudPlayerPanel } from './hudPlayerPanel';
import { HudQuickbar } from './hudQuickbar';
import { HUD_COOLDOWN_SKILLS, HudCooldownPanel } from './hudCooldownPanel';
import { HudText, type HudLocale } from './text/hudText';
import { HurtFlash } from './hurtFlash';
import { SPRINT_SKILL } from '../game/skillLoadout';
import { cardCost } from '../data/balance';
import { ITEM_SLOT_COUNT } from '../data/pickups';
export { HudProgressBar, type HudProgressBarOptions } from './hudProgressBar';
export { HudFrame, type HudFrameOptions } from './hudFrame';
export { createHudIcon, HUD_ICON_URLS, type HudIconName } from './hudIcons';
export { HudWavePanel, type HudWavePanelOptions } from './hudWavePanel';
export { HudPlayerPanel, type HudPlayerPanelOptions } from './hudPlayerPanel';
export {
  HudQuickbar,
  type HudQuickbarItemUse,
  type HudQuickbarOptions,
  type HudQuickSlotOptions,
} from './hudQuickbar';
export { HudCooldownPanel, type HudTimedEffect } from './hudCooldownPanel';
export { HudText, type HudLocale, type HudTextKey, type HudTextParams } from './text/hudText';

/** HUD 的设计坐标；窗口只缩放整层，不改变组件内部布局。 */
const HUD_DESIGN_WIDTH = 1920;
const HUD_DESIGN_HEIGHT = 1080;

/**
 * 小地图调节集中在这里：size 改整个 HUD 尺寸，zoom 改内部地图视野（1 = 整张地图）。
 * 也可以在 new Hud(host, options) 时覆盖，不必改组件实现。
 */
export const MINIMAP_SETTINGS = {
  size: '11.5%',
  zoom: 1.35,
};

export const GEM_PROGRESS_SETTINGS = {
  width: '60%',
  height: '20px',
  /**
   * 只在**还没进图**的那一小会儿用得上。
   *
   * 真正的门槛按每张图的出兵表倒推，进图时由 main 调 setGemsPerCycle 换掉（见
   * game/stats.ts 的 gemsPerCard）。留一个数在这儿只是为了让 HUD 在第一帧有东西可画。
   */
  gemsPerCycle: 300,
  sideOverhang: 0,
};

export interface HudOptions {
  minimapSize?: string;
  minimapZoom?: number;
  gemProgressWidth?: string;
  gemProgressHeight?: string;
  gemsPerCycle?: number;
  gemProgressSideOverhang?: number;
  locale?: HudLocale;
  /**
   * 整个程序共用的那一份 HudText。传进来而不是自己建：语言开关换的是这一个实例，
   * 备战、商店、战绩、结算都挂在它上面，换一次全屏跟着变。
   */
  text?: HudText;
}

/**
 * 正式游戏 HUD。它挂在固定 16:9 的 gameViewport 里，不属于 ESC 调试菜单。
 *
 * 小地图与宝石进度各自封装为组件，位置在 hud.css、默认参数在本文件中调整。
 */
export class Hud {
  readonly root = document.createElement('div');
  readonly minimapLayer = document.createElement('div');
  readonly minimap: Minimap;
  readonly gemProgress: HudProgressBar;
  readonly playerInfo: HudPlayerPanel;
  readonly waveInfo: HudWavePanel;
  readonly currencyInfo: HudFrame;
  readonly quickbar: HudQuickbar;
  readonly cooldownInfo: HudCooldownPanel;
  readonly cards: HudCardPicker;
  /** 挨打时屏幕四周红一下。见 hurtFlash.ts。 */
  private readonly hurtFlash = new HurtFlash();
  readonly text: HudText;

  /** 灵石收满是否弹卡牌。菜单里可以关掉，关掉就是接这个功能之前的样子。 */
  cardsEnabled = true;
  /** 门槛过了、但还没找到机会弹的牌。一次只记一张，弹完下一张自然会再攻下来。 */
  private cardsPending = false;

  private readonly combatPanel = new HudFrame({ className: 'hud-combat-panel' });
  private readonly vitals = document.createElement('div');
  private readonly progression = document.createElement('div');
  private readonly minimapDock = document.createElement('div');
  /** 左上角那行淡字。见 build 里那段说明。 */
  private readonly pauseHint = document.createElement('div');
  private readonly minimapElement = document.createElement('div');
  private readonly currencyValues = new Map<'gold' | 'energy', HTMLSpanElement>();
  private readonly quickbarResizeObserver: ResizeObserver;
  private readonly viewportResizeObserver: ResizeObserver;
  /**
   * 第一张三选一要攒多少灵石。往后每张按 CARD_COST_GROWTH 递增，见下面那三个字段。
   *
   * 不再是构造时定死的一个数：每张地图的波数和出兵量差着一截，门槛跟着那张图走（见
   * game/stats.ts 的 gemsPerCard），换图时由 main 调 setGemsPerCycle 换掉。
   */
  private gemsPerCycle: number;

  /** 这一局已经弹过几次牌。下一张的门槛按它算。 */
  private gemCards = 0;
  /** 上一张牌弹出来时的灵石总数。进度条的起点。 */
  private gemFloor = 0;
  /** 下一张牌要攒到的灵石总数。进度条的终点。 */
  private gemNext: number;
  private readonly gemProgressSideOverhang: number;
  private lastCollectedGems = 0;
  private lastCollectedCoins = 0;

  constructor(host: HTMLElement, options: HudOptions = {}) {
    this.root.className = 'hud';
    /*
     * **出生就是藏着的。** HUD 是战斗界面，而它被构造的时候（main.ts 靠前那几行）离开局
     * 还早得很 —— 后面还有生成地形、烘地面、加载贴图和音效那一长串。
     *
     * 默认可见的话，这一整段加载时间里它都挂在屏幕上：菜单那层蒙版只有 74% 不透明
     * （.menu 的背景是 rgba(11,13,18,.74)，故意留透的 —— 暂停时要看得见后面的战场），
     * 于是血条、小地图、技能格全都从加载条后面透出来。
     *
     * 以前是靠 main.ts 末尾补一句 setVisible(false) 收场的，但那句在所有 await 之后，
     * 挡不住前面那几秒。藏在这里才是对的：谁要显示谁自己调 setVisible(true)。
     */
    this.root.hidden = true;
    this.root.style.width = `${HUD_DESIGN_WIDTH}px`;
    this.root.style.height = `${HUD_DESIGN_HEIGHT}px`;
    // 没传就用 HudText 自己的兜底，不在这里再写一个默认语言 ——
    // 真正的默认值只有一处，在 profile.ts 的 detectLocale。
    this.text = options.text ?? new HudText(options.locale);

    // 血、蓝、等级、经验全部由 draw 每帧喂真值，所以初值给 0：面板自带的那套占位数
    // （22 级、268/300 血、82/120 蓝）会在第一帧之前闪一下，那一下说的是假话。
    this.playerInfo = new HudPlayerPanel(this.text, {
      level: 1,
      health: 0,
      maxHealth: 1,
      mana: 0,
      maxMana: 1,
      experience: 0,
      maxExperience: 1,
    });
    this.waveInfo = new HudWavePanel(this.text, { className: 'hud-wave-info' });
    this.currencyInfo = this.createCurrencyFrame();
    this.root.appendChild(this.waveInfo.root);
    this.vitals.className = 'hud-combat-vitals';
    this.progression.className = 'hud-resource-progression';
    this.playerInfo.mountSections(this.vitals, this.progression);
    this.currencyInfo.content.appendChild(this.progression);

    /*
     * 左上角那行淡字：按 ESC 暂停。
     *
     * 它接替的是刚被拿掉的那两个按钮。按钮本来就没人按 —— 打起来的时候没人会把鼠标挪到
     * 屏幕角上去点一个 42 像素的图标，而它们一直占着小地图上方那一条。但"能暂停"这件事
     * 还是得有个地方说，否则新玩家只能靠猜。
     *
     * 做成水印而不是按钮，因为它要说的话只有第一局有用：读过一次就再也不需要了，而一个
     * 按钮会永远占着那块地方。淡到几乎看不见，正好是"找的时候找得到、不找的时候不碍事"。
     * aria-hidden：它是给眼睛看的提示，读屏走的是各自控件上的 aria-label。
     */
    this.pauseHint.className = 'hud-pause-hint';
    this.pauseHint.setAttribute('aria-hidden', 'true');
    this.text.bindText(this.pauseHint, 'pauseHint');
    this.root.appendChild(this.pauseHint);

    this.minimapDock.className = 'hud-minimap-dock';
    this.minimapElement.className = 'hud-minimap';
    this.setMinimapSize(options.minimapSize ?? MINIMAP_SETTINGS.size);
    this.minimap = new Minimap(options.minimapZoom ?? MINIMAP_SETTINGS.zoom);

    const frame = document.createElement('img');
    frame.className = 'hud-minimap-frame';
    frame.src = minimapFrameUrl;
    frame.alt = '';
    frame.draggable = false;

    this.minimapLayer.className = 'hud-minimap-layer';
    this.minimapLayer.setAttribute('aria-hidden', 'true');
    this.minimapLayer.appendChild(this.minimap.canvas);

    this.minimapElement.append(frame, this.minimapLayer);
    this.minimapDock.append(this.minimapElement, this.currencyInfo.root);
    this.root.appendChild(this.minimapDock);
    const cycle = options.gemsPerCycle ?? GEM_PROGRESS_SETTINGS.gemsPerCycle;
    this.gemsPerCycle = Number.isFinite(cycle) ? Math.max(1, Math.floor(cycle)) : GEM_PROGRESS_SETTINGS.gemsPerCycle;
    const sideOverhang = options.gemProgressSideOverhang ?? GEM_PROGRESS_SETTINGS.sideOverhang;
    this.gemProgressSideOverhang = Number.isFinite(sideOverhang) ? Math.max(0, sideOverhang) : 0;
    const gemProgressHeight = options.gemProgressHeight ?? GEM_PROGRESS_SETTINGS.height;
    this.root.style.setProperty('--hud-gem-progress-height', gemProgressHeight);
    this.gemProgress = new HudProgressBar({
      label: this.text.value('gemProgress'),
      className: 'hud-gem-progress',
      width: options.gemProgressWidth ?? GEM_PROGRESS_SETTINGS.width,
      height: gemProgressHeight,
    });
    this.text.bindAttribute(this.gemProgress.root, 'aria-label', 'gemProgress');
    this.gemNext = cardCost(this.gemsPerCycle, 0);
    this.gemProgress.setValue(0, this.gemNext, false);
    this.quickbar = new HudQuickbar(this.text);
    this.combatPanel.content.append(this.vitals, this.quickbar.root);
    this.cooldownInfo = new HudCooldownPanel(this.text);
    this.cards = new HudCardPicker(this.text);
    // 被动 CD、血条技能面板、灵石进度条自上而下叠成一列，整列底部对齐。三者的间距和
    // 底部留白只在 .hud-bottom-stack 里写一次，要给主视图让高度也只改那一处。
    const bottomStack = document.createElement('div');
    bottomStack.className = 'hud-bottom-stack';
    bottomStack.append(this.cooldownInfo.root, this.combatPanel.root, this.gemProgress.root);
    this.root.appendChild(bottomStack);
    // 卡牌压在所有 HUD 之上，所以最后挂。
    this.root.appendChild(this.cards.root);
    this.quickbarResizeObserver = new ResizeObserver(() => this.syncGemProgressWidth());

    // 挨打那一圈红挂在画幅上、HUD 下：它说的是画面里的事，糊到小地图和血条上去会读成"面板坏了"。
    host.appendChild(this.hurtFlash.root);
    host.appendChild(this.root);
    // 光标是一枚真的 CSS cursor，挂在 body 上（见 cursorImage.ts）。固定在窗口顶层那一层已经
    // 不存在了 —— 换成系统来画之后，ESC 菜单、画框留边、掉出窗口都自然就对了。
    startCursorBreathing();
    this.viewportResizeObserver = new ResizeObserver(([entry]) => {
      if (entry) this.syncViewportScale(entry.contentRect.width, entry.contentRect.height);
    });
    this.viewportResizeObserver.observe(host);
    const viewportRect = host.getBoundingClientRect();
    this.syncViewportScale(viewportRect.width, viewportRect.height);
    this.quickbarResizeObserver.observe(this.quickbar.root);
    this.syncGemProgressWidth();
  }

  private syncViewportScale(width: number, height: number): void {
    const scale = Math.min(width / HUD_DESIGN_WIDTH, height / HUD_DESIGN_HEIGHT);
    this.root.style.setProperty('--hud-scale', String(scale));
  }

  private syncGemProgressWidth(): void {
    // 使用变换前的面板外宽，进度条两端与血条技能面板外沿对齐。
    const width = this.combatPanel.root.offsetWidth;
    if (width > 0) {
      this.gemProgress.root.style.width = `${width + this.gemProgressSideOverhang * 2}px`;
    }
  }

  private createCurrencyFrame(): HudFrame {
    const frame = new HudFrame({
      className: 'hud-currency-info',
      label: this.text.value('currencyInfo'),
    });
    this.text.bindAttribute(frame.root, 'aria-label', 'currencyInfo');
    const values: Array<['coin' | 'gem', 'gold' | 'energy', string]> = [
      ['coin', 'gold', '0'],
      ['gem', 'energy', '0'],
    ];
    for (const [icon, label, value] of values) {
      const item = document.createElement('div');
      item.className = 'hud-currency-item';
      this.text.bindAttribute(item, 'aria-label', label);
      item.append(createHudIcon(icon, `hud-currency-icon hud-icon--${icon}`));
      const count = document.createElement('span');
      count.className = 'hud-text hud-text--pixel hud-currency-value';
      count.textContent = value;
      this.currencyValues.set(label, count);
      item.appendChild(count);
      frame.content.appendChild(item);
    }
    return frame;
  }

  setLocale(locale: HudLocale): void {
    this.text.setLocale(locale);
  }

  /**
   * 按下数字键：用掉这一格里的一件。
   *
   * 顺序要紧 —— 先问结算那边这一下**用不用得上**（格子空着、人死了），用得上才在界面上走
   * 那一套。反过来的话按一下就少一个，而什么都没发生。
   */
  useItem(index: number, apply: (slot: number) => boolean): boolean {
    const effect = this.quickbar.itemEffectAt(index);
    if (!effect || !apply(index)) return false;
    this.cooldownInfo.activateTimedEffect(effect);
    return true;
  }



  update(dt: number): void {
    this.cooldownInfo.update(dt);
  }

  /** CSS 长度或百分比，例如 '22.5%'、'240px'。 */
  setMinimapSize(size: string): void {
    this.minimapDock.style.width = size;
  }

  /**
   * 备战界面期间收起来。
   *
   * HUD 上每一格说的都是"这一局打得怎么样"：血、蓝、灵石、波次。选人的时候一局还没开始，
   * 那些数字要么是零要么是上一局留下的，摆着只会让人以为已经在打了。
   */
  setVisible(on: boolean): void {
    this.root.hidden = !on;
    // 上一局最后那一下的红不能跟着下一局一起淡出去。
    if (!on) this.hurtFlash.clear();
  }

  /**
   * 换一张图就换一个门槛。
   *
   * 顺带把这一局的进度清零：上一局收的灵石不算数，而进度条上剩的那一截会让新的一局看着像是
   * 已经打了一会儿。
   */
  setGemsPerCycle(gems: number): void {
    this.cardsPending = false;
    this.cards.hide();
    this.hurtFlash.clear();
    this.cooldownInfo.clearEffects();
    const next = Number.isFinite(gems) ? Math.max(1, Math.floor(gems)) : this.gemsPerCycle;
    this.gemsPerCycle = next;
    this.lastCollectedGems = 0;
    this.gemCards = 0;
    this.gemFloor = 0;
    this.gemNext = cardCost(next, 0);
    this.gemProgress.setValue(0, this.gemNext, false);
    // 牌库那边也是一局一算：抽了几轮、哪几项属性封顶了。和这一句本来就是同一件事。
    this.cards.resetRun();
  }

  draw(field: Field, battle: Battle, camera: Camera): void {
    this.playerInfo.setHealth(Math.max(0, Math.ceil(battle.player.hp)), battle.player.maxHp);
    // 等级和经验条。以前这两样是面板自己带的占位数（22 级、2845/4500），谁也没喂过它们。
    // 现在它们来自存档：等级是这个角色练到的那一级，经验条是这一级攒了多少。
    //
    // 法力那一格还是空的 —— 技能不耗蓝（skills.ts 里一个耗蓝字段都没有），摆一条假的蓝条
    // 比空着更容易被当真。
    this.playerInfo.setLevel(battle.level);
    this.playerInfo.setExperience(battle.expIntoLevel, battle.expForLevel);
    // 蓝条。主动技能的开销从这里出，自己按每秒回复涨回来。
    this.playerInfo.setMana(Math.max(0, Math.floor(battle.mp)), battle.maxMp);
    /*
     * 屏幕四周那一下红。
     *
     * 跟着头顶那个扣血数字走（一秒一次），不是每挨一下闪一下 —— 末波人堆里每秒十几下，
     * 一下一闪就是一层抹不掉的红。两边同一个时机同一个节奏，读起来才是一件事。
     */
    const hurt = battle.takeHurtPulse();
    if (hurt > 0) {
      const maxHp = Math.max(1, battle.player.maxHp);
      this.hurtFlash.hit(hurt / maxHp, battle.player.hp / maxHp);
    }
    // 波次面板：三个数都自己判重，值没变时一个 DOM 节点也不会碰。
    const wave = battle.waveStatus;
    this.waveInfo.setWave(wave.wave);
    // 最后一批首领出来之后，这一行改成"清完他们还剩多久"，字变红。两个倒数不会同时存在。
    const stand = battle.finalStand ? battle.bossCountdown : 0;
    this.waveInfo.setCountdown(stand > 0 ? stand : wave.countdown);
    this.waveInfo.setUrgent(stand > 0);
    this.waveInfo.setWaveProgress(wave.cleared, wave.waves);
    // 三个主动槽（Q/W/E）加末尾钉死的疾走（R）。疾走不在槽数组里，见 SPRINT_SKILL，
    // 但它在这条栏上有自己的一格 —— 冷却、蓝够不够、练到几级，都和别的招一样要看得见。
    const slots = battle.skillLoadout.activeSkillSlots;
    for (let index = 0; index <= slots.length; index++) {
      const skillId = index < slots.length ? slots[index] : SPRINT_SKILL;
      this.quickbar.setSkill(index, skillId);
      // 正放着的按住型招式（疾走、法相）照样置灰，但不写秒数；收招之后那五秒才开始跑。
      this.quickbar.setSkillCooldown(index,
        skillId ? battle.skillCooldown(skillId) : 0,
        skillId ? battle.skillCooldownDuration(skillId) : 0,
        !skillId || !battle.skillHolding(skillId));
      // 蓝不够就压暗这一格，和进冷却是同一种压暗。
      this.quickbar.setSkillAffordable(index, !skillId || battle.canAfford(skillId));
      // 格子底下那排菱形。以前填的是写死的预览值（3/5），现在是这一局真的练到了几级。
      this.quickbar.setSkillLevel(index, skillId ? battle.skillLevel(skillId) : 0);
    }
    // 药和符那几格。装什么、装几个都在 Battle 上（它是这一局的状态），这里只把它画出来。
    // 格位不固定：先捡到的先占前面，所以每一格的图标也要跟着换。
    for (let index = 0; index < ITEM_SLOT_COUNT; index++) {
      const held = battle.itemAt(index);
      this.quickbar.setItem(index, held?.id ?? null, held?.count ?? 0);
    }
    for (const definition of HUD_COOLDOWN_SKILLS) {
      this.cooldownInfo.setSkillState(definition.id,
        battle.skillLoadout.isEquipped(definition.id),
        battle.skillCooldown(definition.id), battle.skillCooldownDuration(definition.id),
        battle.skillLevel(definition.id));
    }
    this.minimap.draw(field, battle, camera);
    if (battle.collectedCoins !== this.lastCollectedCoins) {
      const goldValue = this.currencyValues.get('gold');
      if (goldValue) goldValue.textContent = String(battle.collectedCoins);
      this.lastCollectedCoins = battle.collectedCoins;
    }
    const total = battle.collectedGems;
    if (total !== this.lastCollectedGems) {
      const energyValue = this.currencyValues.get('energy');
      if (energyValue) energyValue.textContent = String(total);
      // 攒够下一张的门槛就弹牌。用"越过 gemNext"而不是取模：门槛是一张比一张高的，取模
      // 没有意义；而且一帧可能一次收好几颗，正好落在某个整数上的机会本来也不可靠。
      //
      // while 而不是 if：末波一帧能收十几颗，理论上可以一次跨过两张牌的门槛。牌本身一次只
      // 弹一张（show 开着的时候不再抽），但账要记全，不然后面每一张都会偏。
      let popped = false;
      while (total >= this.gemNext) {
        this.gemCards++;
        this.gemFloor = this.gemNext;
        this.gemNext += cardCost(this.gemsPerCycle, this.gemCards);
        popped = true;
      }
      this.gemProgress.setValue(total - this.gemFloor, this.gemNext - this.gemFloor,
        total > this.lastCollectedGems && !popped);
      if (this.cardsEnabled && popped && battle.player.alive) this.cardsPending = true;
      this.lastCollectedGems = total;
    }
    // 攻下的牌先记着，等手里那招放完再弹（见 Battle.sustaining）。这一句在收灵石那个
    // 分支**外面**：欠着的牌要等的是松手，而松手那一帧未必恰好又收到一颗灵石。
    // 死亡当帧可能仍收到灵石，或恰好结束持续施法；丢弃待选牌，让倒地和结算继续。
    if (!battle.player.alive) {
      this.cardsPending = false;
      if (this.cards.open) this.cards.hide();
    }
    if (this.cardsPending && this.cardsEnabled && battle.player.alive && !battle.sustaining) {
      this.cardsPending = false;
      this.cards.show();
    }
  }
}
