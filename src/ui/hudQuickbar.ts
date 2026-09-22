import skillFrameLeftUrl from '../../assets/hud/skill/skill-frame-left.png';
import skillFrameMiddleUrl from '../../assets/hud/skill/skill-frame-middle.png';
import skillFrameRightUrl from '../../assets/hud/skill/skill-frame-right.png';
import { SKILL_ICONS } from './skillIcons';
import { ITEM_SLOT_COUNT, pickupById } from '../data/pickups';
import { pickupIcon } from '../items/pickupIcons';
import type { SkillId } from '../game/skills';
import type { HudText } from './text/hudText';
import type { HudTextKey } from './text/hudText.types';
import { createHudSkillLevel } from './hudSkillLevel';
import { SKILL_MAX_LEVEL } from '../data/balance';
import './hudQuickbar.css';

export interface HudQuickSlotOptions {
  key: string;
  icon?: string;
  label: HudTextKey;
  emptyLabel?: HudTextKey;
  id?: string;
  count?: number;
  effectDuration?: number;
}

export interface HudQuickbarOptions {
  skills?: readonly HudQuickSlotOptions[];
  items?: readonly HudQuickSlotOptions[];
}

/** 冷却进度写进 CSS 前量化到多少档。见 setSkillCooldown。 */
const COOLDOWN_STEPS = 128;

type HudQuickSlotView = {
  root: HTMLElement;
  icon: HTMLImageElement | null;
  name: HTMLSpanElement | null;
  levels: HTMLElement | null;
  cooldown: HTMLSpanElement | null;
  cooldownValue: HTMLSpanElement | null;
  countValue: HTMLSpanElement | null;
  lastCooldownText: string;
  /** 上一次写进 CSS 的冷却进度，量化过；见 setSkillCooldown。 */
  lastCooldownStep: number;
  lastCooling: boolean;
  /** 上一次写进 DOM 的"蓝不够"状态。见 setSkillAffordable。 */
  lastBroke: boolean;
  /** 上一次画出来的技能等级。见 setSkillLevel。 */
  lastLevel: number;
  skillId: SkillId | null | undefined;
};

type HudItemSlot = {
  view: HudQuickSlotView;
  /** 这一格现在装的是什么。格位不固定，所以它是会变的。 */
  options: HudQuickSlotOptions;
  count: number;
};

export interface HudQuickbarItemUse {
  id: string;
  icon: string;
  label: string;
  duration: number;
}

/*
 * 四格键位。**只有键位，没有图** —— 装的是哪一招每帧跟着 Battle 走（setSkill）。
 *
 * Q/W/E 原来各硬写着一张图（横扫、铁布衫、天地法相），那是塑界面时的占位。现在开局三个主动
 * 槽本来就是空的，那三张图永远不是玩家真正装着的招，只会让这三格在第一帧里长成不属于它们
 * 的样子。三格现在都一样：空着，抽到才长出图来。
 *
 * 最后那一格是疾走，钉死的（见 SPRINT_SKILL）。它不在那三个主动槽里，但它仍然是一招、
 * 仍然扣蓝、仍然有冷却，所以它照样要在这条栏上占一格，和别的招同一个样子。
 *
 * 那一格写 **R**，不写 ⇧：两个键都能跑，而栏上只能写一个 —— 写 R，因为它和左边三格排在
 * 同一行，玩家的手照着栏子往右挪一格就是它。Shift 是给记着老习惯的人留的后门，不用画出来。
 */
const DEFAULT_SKILLS: readonly HudQuickSlotOptions[] = ['Q', 'W', 'E', 'R'].map((key) => ({
  key,
  label: 'activeSkillSlot' as const,
  emptyLabel: 'emptyActiveSkillSlot' as const,
}));

const ACTIVE_SKILL_PRESENTATION: Partial<Record<SkillId, { name: HudTextKey }>> = {
  lunge: { name: 'skillLunge' },
  aegis: { name: 'skillAegis' },
  dharma: { name: 'skillDharma' },
  heavenGuard: { name: 'skillHeavenGuard' },
  mend: { name: 'skillMend' },
  berserk: { name: 'skillBerserk' },
  // 疾走固定占最后那一格（R）。一双靴子，和别的招那几张符箓一眼就分得开 —— 它本来也
  // 不是一招，是走位。
  sprint: { name: 'skillSprint' },
};

/** 药用掉之后在左下角那条上闪多久，秒。它不是效果时长，只是一个"生效了"的回执。 */
const ITEM_FLASH = 1.2;

/**
 * 快捷栏那几格：**开局全空，而且不属于任何一件东西**。
 *
 * 以前这里写着三颗红药、三颗蓝药、两张符 —— 摆界面用的假存货，玩家没做任何事就在手里。后来
 * 改成开局为 0，但格位还是钉死的（一号永远回血）。现在连格位也放开：先捡到的先占前面的格子。
 *
 * 钉死格位在只有四件东西时还行，可东西会越加越多，钉死就意味着永远只有前四种能被拿到，后面
 * 的全是摆设。按先后排之后，这几格装的是"这一局你身上有什么"。
 *
 * 所以这张表里只有键位，没有图也没有 id —— 那两样每一帧跟着 Battle 走（setItem）。
 */
const DEFAULT_ITEMS: readonly HudQuickSlotOptions[] = Array.from(
  { length: ITEM_SLOT_COUNT },
  (_, index) => ({ key: String(index + 1), label: 'itemSlot' as const, count: 0 }),
);



/** 底部快捷栏的纯显示组件；技能和物品逻辑接入时只需更新各槽位图标与状态。 */
export class HudQuickbar {
  readonly root = document.createElement('div');
  readonly skillGroup = document.createElement('div');
  readonly itemGroup = document.createElement('div');

  private readonly skillSlots: HudQuickSlotView[] = [];
  private readonly itemSlots: HudItemSlot[] = [];
  private readonly text: HudText;

  constructor(text: HudText, options: HudQuickbarOptions = {}) {
    this.text = text;
    this.root.className = 'hud-quickbar';
    this.skillGroup.className = 'hud-quickbar-group hud-quickbar-group--skills';
    this.itemGroup.className = 'hud-quickbar-group hud-quickbar-group--items';
    text.bindAttribute(this.skillGroup, 'aria-label', 'activeSkills');
    text.bindAttribute(this.itemGroup, 'aria-label', 'itemQuickbar');

    const skills = options.skills ?? DEFAULT_SKILLS;
    const items = options.items ?? DEFAULT_ITEMS;
    for (let index = 0; index < skills.length; index++) {
      const view = this.createSlot(text, skills[index], index, skills.length, true);
      this.skillSlots.push(view);
      this.skillGroup.appendChild(view.root);
    }
    for (let index = 0; index < items.length; index++) {
      const view = this.createSlot(text, items[index], index, items.length, false);
      const count = Math.max(0, Math.floor(items[index].count ?? 0));
      this.itemSlots.push({ view, options: items[index], count });
      this.refreshItemCount(this.itemSlots[index]);
      this.itemGroup.appendChild(view.root);
    }
    this.root.append(this.skillGroup, this.itemGroup);
    text.onChange(() => {
      for (const slot of this.skillSlots) this.refreshSkillPresentation(slot);
    });
  }

  setSkill(index: number, id: SkillId | null): void {
    const slot = this.skillSlots[index];
    if (!slot || slot.skillId === id) return;
    slot.skillId = id;
    this.refreshSkillPresentation(slot);
  }

  /**
   * 蓝够不够放这一招。不够就把整格压暗，**和进冷却是同一种压暗**。
   *
   * 用同一种表现是有意的：对玩家来说"现在按不动"就是一件事，没必要分成两种灰。区别只在
   * 冷却那一格上有一个倒数的数字，而蓝不够没有数字 —— 因为它没有一个确定的时刻，取决于
   * 接下来这几秒还放不放别的招。
   */
  setSkillAffordable(index: number, affordable: boolean): void {
    const slot = this.skillSlots[index];
    if (!slot) return;
    const broke = !affordable;
    if (broke === slot.lastBroke) return;
    slot.lastBroke = broke;
    slot.root.classList.toggle('hud-quick-slot--broke', broke);
  }

  /**
   * 格子底下那排菱形填到第几颗。
   *
   * 只在**变了**的时候重画：这个方法每帧被调四次，而等级一局只涨三十来次。重画一次是把五个
   * img 的 src 全换一遍，每帧干四次是白扔。
   */
  setSkillLevel(index: number, level: number): void {
    const slot = this.skillSlots[index];
    if (!slot?.levels) return;
    const next = Math.max(0, Math.floor(level));
    if (next === slot.lastLevel) return;
    slot.lastLevel = next;
    slot.levels.replaceChildren(...createHudSkillLevel(next, SKILL_MAX_LEVEL).childNodes);
  }

  /**
   * @param countdown 要不要在格子上写秒数。按住型的招正放着的时候给 false：
   *   那一格照样全灰（它确实按不动），但没有数字可数 —— 能再撑多久只看蓝条，
   *   写一个不动的"5.0"在那里反而是假消息。技能收了之后数字才出现并开始跑。
   */
  setSkillCooldown(index: number, remaining: number, total: number, countdown = true): void {
    const slot = this.skillSlots[index];
    if (!slot?.cooldown || !slot.cooldownValue) return;
    const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
    const safeRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    const ratio = safeTotal > 0 ? Math.min(1, safeRemaining / safeTotal) : 0;

    // 进度量化到 1/128 再写。
    //
    // 这个方法每帧被调四次，而写自定义属性不管值变没变都会让这一格的样式失效。一个六秒的
    // 技能每帧只走 0.3%，量化之后大约三帧才真的写一次，而 1/128 换算到格子上是半个像素 ——
    // 扫过去的那道暗边照样是连续的。
    const step = Math.round(ratio * COOLDOWN_STEPS);
    if (step !== slot.lastCooldownStep) {
      slot.lastCooldownStep = step;
      slot.root.style.setProperty('--hud-quick-slot-cooldown', String(step / COOLDOWN_STEPS));
    }
    const cooling = ratio > 0;
    if (cooling !== slot.lastCooling) {
      slot.lastCooling = cooling;
      slot.root.classList.toggle('hud-quick-slot--cooling', cooling);
    }

    const cooldownText = cooling && countdown
      ? (safeRemaining >= 10 ? String(Math.ceil(safeRemaining)) : safeRemaining.toFixed(1))
      : '';
    if (slot.lastCooldownText === cooldownText) return;
    slot.lastCooldownText = cooldownText;
    slot.cooldownValue.textContent = cooldownText;
  }

  /**
   * 把某一格画成"装着 id 这件东西、共 count 个"。id 给 null 就是空格。
   *
   * 这一层不记账，只显示 —— 真正的账本在 Battle 上（它是这一局的状态，和血、蓝、技能等级
   * 一样）。判重是因为这个方法每帧被调几次，而格子的内容一局只变几十次。
   */
  setItem(index: number, id: string | null, count: number): void {
    const item = this.itemSlots[index];
    if (!item) return;
    const next = Math.max(0, Math.floor(count));
    if (item.options.id === (id ?? undefined) && next === item.count) return;
    const def = id ? pickupById(id) : null;
    item.options = def
      ? {
        ...item.options,
        id: def.id,
        icon: pickupIcon(def.id),
        // 药没有持续时间（立刻回血），但左下角那条计时还是要闪一下，告诉玩家"这一口下去了"。
        effectDuration: def.duration > 0 ? def.duration : ITEM_FLASH,
      }
      : { key: item.options.key, label: item.options.label, count: 0 };
    item.count = next;
    const icon = item.view.icon;
    if (icon) {
      const src = item.options.icon;
      if (src && icon.src !== src) icon.src = src;
      icon.alt = def ? this.text.value(def.nameKey) : '';
    }
    item.view.root.title = def
      ? `${this.text.value(def.nameKey)} · ${this.text.value(def.noteKey)}`
      : '';
    this.refreshItemCount(item);
  }

  /** 这一格用掉一件会产生什么效果条。空格返回 null。 */
  itemEffectAt(index: number): HudQuickbarItemUse | null {
    return this.consumeItem(index);
  }

  consumeItem(index: number): HudQuickbarItemUse | null {
    const item = this.itemSlots[index];
    const icon = item?.options.icon;
    const duration = item?.options.effectDuration ?? 0;
    if (!item || !icon || item.count <= 0 || duration <= 0) return null;
    // 不在这里扣数：账本在 Battle 上，下一帧 setItemCount 会把新的数画上来。两边各扣一次
    // 看着没事（结果一样），但那时候就有两个地方都自称知道还剩几件了。
    // 效果条上写药的**真名字**，不是"物品 3 效果"。那一条出现的时刻玩家刚按下一个数字键，
    // 他要确认的正是"我刚刚吃下去的是哪一颗" —— 把键位号再拿回来给他看一遍答的不是这个问题。
    // 格子里有图就一定有 id（见 setItem），文本表那一条只是兼底。
    const def = item.options.id ? pickupById(item.options.id) : null;
    return {
      id: item.options.id ?? `item-${index + 1}`,
      icon,
      label: def
        ? this.text.value(def.nameKey)
        : this.text.value('itemEffect', { key: item.options.key }),
      duration,
    };
  }

  private createSlot(text: HudText, options: HudQuickSlotOptions, index: number, count: number,
    skill: boolean): HudQuickSlotView {
    const slot = document.createElement('div');
    const framePart = index === 0 ? 'left' : index === count - 1 ? 'right' : 'middle';
    slot.className = `hud-quick-slot hud-quick-slot--${framePart}`;
    const label = options.icon ? options.label : options.emptyLabel ?? options.label;
    text.bindAttribute(slot, 'aria-label', label, () => ({ key: options.key }));

    const body = document.createElement('span');
    body.className = 'hud-quick-slot-body';
    slot.appendChild(body);

    // 图标元素**一律建**，哪怕这一格现在是空的。
    //
    // 技能槽和物品格现在都是"内容会变"的：Q/W/E 抽到招才长出图标，物品格先捡到的先占。建不
    // 建元素不该取决于**建的那一刻**有没有东西，否则第一次往里放东西时没地方放图。
    let icon: HTMLImageElement | null = null;
    {
      icon = document.createElement('img');
      icon.className = 'hud-quick-slot-icon';
      if (options.icon) icon.src = options.icon;
      icon.alt = '';
      icon.draggable = false;
      icon.hidden = !options.icon;
      slot.appendChild(icon);
    }
    if (!options.icon) {
      slot.classList.add('hud-quick-slot--empty');
    }

    let name: HTMLSpanElement | null = null;
    let levels: HTMLElement | null = null;
    let cooldown: HTMLSpanElement | null = null;
    let cooldownValue: HTMLSpanElement | null = null;
    let countValue: HTMLSpanElement | null = null;
    if (skill) {
      name = document.createElement('span');
      name.className = 'hud-text hud-text--pixel hud-quick-slot-name';
      name.hidden = true;
      levels = createHudSkillLevel(1, SKILL_MAX_LEVEL, 'hud-quick-slot-levels');
      levels.hidden = true;
      cooldown = document.createElement('span');
      cooldown.className = 'hud-quick-slot-cooldown';
      cooldownValue = document.createElement('span');
      cooldownValue.className = 'hud-text hud-text--pixel hud-quick-slot-cooldown-value';
      slot.append(cooldown, cooldownValue, name, levels);
    } else {
      // 件数那个数字和图标一样，**一律建**。原来它挂在 `options.icon` 下面，而开局四格本来就是
      // 空的、没有图 —— 于是这个 span 从来没被建过，之后捧到药也永远没地方写数字。
      // 和上面图标那一段同一条理由：建不建不该取决于建的那一刻有没有东西。
      countValue = document.createElement('span');
      countValue.className = 'hud-text hud-text--pixel hud-quick-slot-count';
      countValue.hidden = true;
      slot.appendChild(countValue);
    }

    const frame = document.createElement('img');
    frame.className = 'hud-quick-slot-frame';
    frame.src = framePart === 'left'
      ? skillFrameLeftUrl
      : framePart === 'right' ? skillFrameRightUrl : skillFrameMiddleUrl;
    frame.alt = '';
    frame.draggable = false;

    const key = document.createElement('span');
    key.className = 'hud-text hud-text--pixel hud-quick-slot-key';
    key.textContent = options.key;
    slot.append(frame, key);
    return {
      root: slot,
      icon,
      name,
      levels,
      cooldown,
      cooldownValue,
      countValue,
      lastCooldownText: '',
      lastCooldownStep: -1,
      lastCooling: false,
      lastBroke: false,
      lastLevel: -1,
      skillId: undefined,
    };
  }

  private refreshSkillPresentation(slot: HudQuickSlotView): void {
    const presentation = slot.skillId ? ACTIVE_SKILL_PRESENTATION[slot.skillId] : undefined;
    if (slot.icon) {
      slot.icon.hidden = !presentation;
      // 图取自全工程那一份表（skillIcons.ts）：快捷栏、三选一、选人界面上同一招是同一张图。
      if (presentation && slot.skillId) slot.icon.src = SKILL_ICONS[slot.skillId];
    }
    if (slot.name) {
      slot.name.hidden = !presentation;
      slot.name.textContent = presentation ? this.text.value(presentation.name) : '';
    }
    if (slot.levels) slot.levels.hidden = !presentation;
    slot.root.classList.toggle('hud-quick-slot--empty', !presentation);
  }

  /**
   * 把一格的件数画出来。**一件都没有时整格空着**，不是把图标压暗。
   *
   * 压暗是原来的做法，那时候快捷栏一进游戏就装着六颗药，压暗说的是"这一格的
   * 药刚用完"。现在开局四格全是 0，一个灰图标读起来仍然是"我有这东西"—— 玩家看到的是一排
   * 药和符，而他手上什么都没有。所以没有就不画，和 Q/W/E 三个空技能槽一个样子：只剩一个
   * 空框，捡到第一件才长出图标来。
   */
  private refreshItemCount(item: HudItemSlot): void {
    const empty = item.count <= 0;
    if (item.view.countValue) {
      // 写成 ×N 而不是光一个数字：和结算、三选一那两排同一个写法（见 itemStrip.ts）。三处说的
      // 本来就是同一件事，一个光杆的"3"在格子角上还要玩家自己猜它是个数还是快捷键。
      item.view.countValue.textContent = `×${item.count}`;
      item.view.countValue.hidden = empty;
    }
    if (item.view.icon) item.view.icon.hidden = empty;
    item.view.root.classList.toggle('hud-quick-slot--empty', empty);
  }
}
