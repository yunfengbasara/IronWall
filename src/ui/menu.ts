import './menu.css';
import { SkillCategoryRules, type SkillCategory, type SkillId } from '../game/skills';
import { ACTIVE_SKILL_KEYS, type SkillLoadoutSnapshot } from '../game/skillLoadout';
import type { WaveStatus } from '../game/battle';
import { startCursorBreathing } from './cursorImage';
import { HudText } from './text/hudText';
import type { WeatherKind } from '../world/weather';

/**
 * 加载条 + 暂停，两样东西共用一块面板。
 *
 * 合成一块是因为它们本来就是同一件事的两个阶段：开局要先烘完地面（加载），ESC 或窗口失焦时
 * 回到暂停面板。两者的区别只是主按钮上写什么、以及下面那半屏数据要不要显示 —— 拆成两个面板
 * 会得到两份一模一样的布局。
 *
 * 原来这里还有第三个阶段"准备开始"：烘完之后停在一个只有一个按钮的标题页上。那一页现在被
 * 备战界面（ui/setup.ts）取代了 —— 加载完直接进选人。
 *
 * 顺带把原来钉在左上角的 HUD 收了进来。那行字在游戏里一直亮着，而它上面的东西 —— 帧率、
 * 图元数、键位表 —— 没有一样是玩家在挥锤子的时候需要读的。收进来之后游戏画面里一个字都没有。
 */

/** 面板要显示的全部内容。每次刷新时游戏算一份交过来。 */
export interface MenuState {
  kills: number;
  deaths: number;
  /** 场上活着的敌人数，以及其中真正画出来的（视野外的被裁掉）。 */
  alive: number;
  drawn: number;
  hp: number;
  maxHp: number;
  /** 生命顶到了"无敌"那一档，显示成文字而不是一串九。 */
  invincible: boolean;

  /** 出兵速度倍率的档位，顶满是模板原速。菜单里可调。 */
  spawnBatch: number;
  /** 当前波次快照，出兵模板给的。 */
  wave: WaveStatus;
  /** 这一局回收掉多少人（走出回收框、看不见了的）。用来看跑步机转得对不对。 */
  recycled: number;
  /** 其中有多少是玩家回头之后按预留位置放回去的。 */
  restored: number;

  fps: number;
  /** 逻辑和绘制各自花掉的毫秒。暂停时世界是冻住的，这里是暂停那一刻的值。 */
  simMs: number;
  buildMs: number;
  primitives: number;

  preset: number;
  skillLoadout: SkillLoadoutSnapshot;
  autoAttack: boolean;
  /** 倒下自动重开。关着的时候倒下会走结算流程，见 Battle.autoRespawn。 */
  autoRespawn: boolean;
  /** 物品图鉴开着的时候面板要让开，见 showGallery。 */
  showItems: boolean;
  /** 灵石收满是否弹升级卡牌。关掉就是接这个功能之前的样子。 */
  showCards: boolean;
  skeleton: boolean;
  maxEnemies: number;

  weather: WeatherKind;
  cloudy: boolean;
  windy: boolean;

  grain: number;
  magnify: number;
  /** 人在缓冲里有多少像素高，以及放大到屏幕上是多少。 */
  figurePixels: number;
  figureScreen: number;
}

export interface MenuBridge {
  /** 八个角色预设的名字。面板搭起来的时候就要，所以不走 read()。 */
  readonly presets: string[];
  /** 技能目录。category 决定菜单分组，cooldown 用于直接核对每招自己的周期。 */
  readonly skills: { id: SkillId; name: string; note: string; category: SkillCategory; cooldown: number }[];
  /**
   * 手上的药和符，以及各自是干什么的。每次打开面板现问一次 —— 它一局里一直在变。
   *
   * 和技能摆在同一块：对玩家来说"我身上带着什么"是一个问题，不是两个。快捷栏上那几格只有
   * 图和数字，说不出按下去会发生什么，而这里是他能读到字的地方。
   */
  items(): { name: string; note: string; count: number }[];
  /**
   * 点菜单里的一项 = 按对应的那个键。
   *
   * 菜单不自己实现任何一个功能，只把点击翻译成键码丢回去走 onKeyPressed。于是键盘和鼠标
   * 走的是同一段代码，不会分叉成"菜单里的自动攻击开着、但按 F 又是另一套状态"，以后加
   * 功能也只用改一处。
   */
  press(code: string): void;
  /** 天气是唯一直接选而不是循环切的：三档并排摆着，让人点三次绕回去很蠢。 */
  setWeather(kind: WeatherKind): void;
  /** 按类别规则选择、开关或装入主动槽。 */
  toggleSkill(id: SkillId): void;
  read(): MenuState;
  /** 开始或继续游戏，保持鼠标当前的屏幕位置。 */
  resume(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 一格数据：上面一行小标签，下面一行大数字。返回那个大数字，留着后面改。 */
function stat(parent: HTMLElement, label: string): HTMLElement {
  const box = el('div', 'menu-stat');
  box.appendChild(el('span', 'menu-stat-k', label));
  const value = el('span', 'menu-stat-v', '-');
  box.appendChild(value);
  parent.appendChild(box);
  return value;
}

/** 一行开关：左边一个窄标签，右边一排控件。 */
function row(parent: HTMLElement, label: string): HTMLElement {
  const line = el('div', 'menu-row');
  line.appendChild(el('span', 'menu-row-k', label));
  const slot = el('div', 'menu-row-v');
  line.appendChild(slot);
  parent.appendChild(line);
  return slot;
}

export class Menu {
  private readonly bridge: MenuBridge;
  readonly text: HudText;

  readonly root = el('div', 'menu');
  private readonly mode = el('span', 'menu-mode');

  private readonly loading = el('div');
  private readonly loadLabel = el('span');
  private readonly loadPercent = el('span');
  private readonly barFill = el('div', 'menu-bar-fill');

  /**
   * 图鉴状态下顶上那条窄栏。挂在 root 上而不是卡片里 —— 卡片这时候是收起来的。
   */
  private readonly peek = el('div', 'menu-peek');
  private readonly peekLabel = el('span', 'menu-peek-k');

  private readonly startBox = el('div');
  private readonly startButton = el('button', 'menu-start');

  /** 数据和开关：只有暂停时才有意义，开始画面上是收起来的。 */
  private readonly detail = el('div');
  private readonly stats: Record<string, HTMLElement> = {};
  /** 每个可切换按钮的"当前是否生效"判据，刷新时统一跑一遍。 */
  private readonly toggles: { node: HTMLElement; on: (s: MenuState) => boolean }[] = [];
  private readonly presetButtons: HTMLButtonElement[] = [];
  private readonly spins: Record<string, HTMLElement> = {};
  /** 技能那一行下面的说明，跟着当前选中的技能变。 */
  private skillNote = el('div');
  private itemRow: HTMLElement = el('div');
  private itemNote: HTMLElement = el('div');
  /** 键位表那一条。加载时收起来 —— 那时候一个键都还按不了。 */
  private readonly keysBox = el('div');


  constructor(bridge: MenuBridge, text: HudText = new HudText()) {
    this.bridge = bridge;
    this.text = text;
    this.build();
    document.body.appendChild(this.root);

    // 光标在这儿就装上：菜单比 HUD 先建，加载那几秒也该是那把剑。重复调用无效，
    // HUD 那边再调一次只是为了不依赖两者的先后顺序。
    startCursorBreathing();
  }

  // ---------------------------------------------------------------- 三个状态

  /** @param progress 0..1。 */
  showLoading(label: string, progress: number): void {
    this.root.hidden = false;
    this.setPeek(false);
    this.mode.textContent = this.text.value('loadingTitle');
    this.loading.hidden = false;
    this.startBox.hidden = true;
    this.detail.hidden = true;
    // 加载就是加载：进度条以外什么都不摆。键位表在这个时候一个键都还按不了，摆出来只是
    // 让人以为已经能操作了。
    this.keysBox.hidden = true;
    this.loadLabel.textContent = label;
    const pct = Math.round(progress * 100);
    this.loadPercent.textContent = `${pct}%`;
    this.barFill.style.width = `${pct}%`;
  }

  showPause(): void {
    this.root.hidden = false;
    this.setPeek(false);
    this.mode.textContent = '已暂停';
    this.loading.hidden = true;
    this.startBox.hidden = false;
    this.detail.hidden = false;
    this.startButton.textContent = '继续游戏';
    this.startButton.disabled = false;
    this.keysBox.hidden = false;
    this.refresh();
  }

  hide(): void {
    this.root.hidden = true;
    this.setPeek(false);
  }

  /**
   * 物品图鉴：面板让开，让画布上那张图露出来。
   *
   * 不做成第四个"模式"，因为它和载入/开始/暂停不是一个维度的东西 —— 那三个是游戏所处的
   * 阶段，图鉴只是暂停时临时把面板挪走看一眼。回来还是暂停。
   */
  showGallery(count: number): void {
    this.root.hidden = false;
    this.setPeek(true);
    // 一件都画不出来时，窄栏就是唯一能说清楚"为什么是空的"的地方 —— 画布上写不了字，
    // 那是像素缓冲，十三号字过一遍就没法看了（见这个文件顶上那段）。
    this.peekLabel.textContent =
      count > 0
        ? `物品图鉴 · ${count} 件`
        : '物品图鉴 · 空 —— 把精灵表放到 public/items.png，再到 src/items/catalog.ts 登记帧矩形';
  }

  private setPeek(on: boolean): void {
    this.root.classList.toggle('peek', on);
    this.peek.hidden = !on;
  }

  // ---------------------------------------------------------------- 刷新

  /**
   * 把当前状态刷进面板。
   *
   * 暂停时世界是冻住的，所以不需要定时刷 —— 打开面板时刷一次、之后每次点击再刷一次就够了。
   */
  refresh(): void {
    if (this.detail.hidden) return;
    const s = this.bridge.read();

    this.stats.kills.textContent = String(s.kills);
    this.stats.alive.textContent = `${s.alive} 画 ${s.drawn}`;
    this.stats.recycled.textContent = `${s.recycled} 回 ${s.restored}`;
    this.stats.deaths.textContent = String(s.deaths);
    this.stats.hp.textContent = s.invincible
      ? '无敌'
      : `${Math.max(0, Math.ceil(s.hp))} / ${s.maxHp}`;

    this.stats.fps.textContent = String(Math.round(s.fps));
    this.stats.sim.textContent = `${s.simMs.toFixed(1)} ms`;
    this.stats.build.textContent = `${s.buildMs.toFixed(1)} ms`;
    this.stats.primitives.textContent = String(s.primitives);

    for (let i = 0; i < this.presetButtons.length; i++) {
      this.presetButtons[i].classList.toggle('on', i === s.preset);
    }
    for (const t of this.toggles) t.node.classList.toggle('on', t.on(s));

    this.spins.grain.textContent = `颗粒度 ${s.grain.toFixed(1)} · 人高 ${s.figurePixels} px`;
    this.spins.magnify.textContent = `放大 ${s.magnify}x · 屏幕 ${s.figureScreen} px`;
    this.spins.hp.textContent = s.invincible ? '生命 无敌' : `生命 ${s.maxHp}`;
    const wave = s.wave;
    this.spins.spawn.textContent = `出兵 x${s.spawnBatch}`;
    const pinned = wave.pinned > 0 ? ' · 已钉住' : '';
    this.spins.wave.textContent = wave.holding
      ? `第 ${wave.wave}/${wave.waves} 波 · 末波续出 · 出兵目标 ${wave.crowd}${pinned}`
      : `第 ${wave.wave}/${wave.waves} 波 · 下一波 ${Math.ceil(wave.countdown)}s · 出兵目标 ${wave.crowd}${pinned}`;
    this.spins.enemies.textContent = `完整怪物上限 ${s.maxEnemies}`;

    const equipped = this.bridge.skills
      .filter((skill) => s.skillLoadout.equipped.includes(skill.id))
      .map((skill) => skill.name)
      .join('、');
    const active = ACTIVE_SKILL_KEYS.map((key, index) => {
      const id = s.skillLoadout.active[index];
      const skill = id ? this.bridge.skills.find((entry) => entry.id === id) : null;
      return `${key} ${skill?.name ?? '空'}`;
    }).join(' · ');
    // 满级那句写在这儿而不是每个按钮的 title 上：它是这排按钮的规则，不是某一招的属性。
    this.skillNote.textContent =
      `已装备：${equipped || '无'} ｜ 主动槽：${active} ｜ 点上直接给满级`;

    // 药和符：一格一个小牌子，名字加个数，说明挂在 title 上，下面那行再摊开写一遍。
    const items = this.bridge.items();
    this.itemRow.replaceChildren();
    for (const item of items) {
      const tag = el('span', 'menu-tag', `${item.name} ×${item.count}`);
      tag.title = item.note;
      this.itemRow.appendChild(tag);
    }
    this.itemNote.textContent = items.length === 0
      ? '手上没有药物或符咒。它们由敌人掉落，走过去捡。'
      : items.map((item) => `${item.name}：${item.note}`).join(' ｜ ');
  }

  // ---------------------------------------------------------------- 搭面板

  private build(): void {
    const card = el('div', 'menu-card');
    this.root.appendChild(card);

    const head = el('div', 'menu-head');
    const title = el('span', 'menu-title');
    this.text.bindText(title, 'gameTitle');
    head.appendChild(title);
    head.appendChild(this.mode);
    card.appendChild(head);
    card.appendChild(el('div', 'menu-rule'));

    // ---- 加载条

    const label = el('div', 'menu-load-label');
    label.appendChild(this.loadLabel);
    label.appendChild(this.loadPercent);
    this.loading.appendChild(label);
    const bar = el('div', 'menu-bar');
    bar.appendChild(this.barFill);
    this.loading.appendChild(bar);
    card.appendChild(this.loading);

    // ---- 主按钮

    this.startButton.addEventListener('click', () => this.bridge.resume());
    this.startBox.appendChild(this.startButton);
    card.appendChild(this.startBox);

    // ---- 数据和开关

    this.detail.appendChild(el('div', 'menu-rule'));

    // 三列三行，一行一组：战况 / 场面 / 性能。
    const stats = el('div', 'menu-stats');
    this.stats.kills = stat(stats, '击杀');
    this.stats.deaths = stat(stats, '阵亡');
    this.stats.hp = stat(stats, '生命');
    this.stats.alive = stat(stats, '场上');
    this.stats.recycled = stat(stats, '回收');
    this.stats.primitives = stat(stats, '图元');
    this.stats.fps = stat(stats, '帧率');
    this.stats.sim = stat(stats, '逻辑');
    this.stats.build = stat(stats, '绘制');
    this.detail.appendChild(stats);

    this.detail.appendChild(el('div', 'menu-rule'));
    this.buildControls(this.detail);
    card.appendChild(this.detail);

    // ---- 图鉴那条窄栏
    //
    // 挂在 root 上而不是卡片里：图鉴状态下卡片整个是收起来的，挂在里面就跟着一起没了。
    this.peek.hidden = true;
    this.peek.appendChild(this.peekLabel);
    this.peek.appendChild(this.button('返回菜单', 'I', 'KeyI'));
    this.root.appendChild(this.peek);

    this.keysBox.appendChild(el('div', 'menu-rule'));
    const keys = el('div', 'menu-keys');
    keys.innerHTML =
      '<b>方向键</b> / <b>按住左键</b> 移动（打哪边自动锁最近的人） · <b>按住 R</b> 跑（耗蓝） · ' +
      '<b>Q/E/R</b> 主动技能 · ' +
      '<b>J</b> 换自动攻击 · <b>O/P</b> 上下一波 · <b>\\</b> 末波压测 · <b>滚轮</b> 缩放 · <b>I</b> 物品图鉴 · ' +
      '<b>ESC</b> 结算画面　<b>F1</b> 这块调试菜单';
    this.keysBox.appendChild(keys);
    card.appendChild(this.keysBox);
  }

  private buildControls(parent: HTMLElement): void {
    // ---- 角色

    const roles = row(parent, '角色');
    const names = this.bridge.presets;
    for (let i = 0; i < names.length; i++) {
      const b = this.button(`${i + 1} ${names[i]}`, '', `Digit${i + 1}`);
      this.presetButtons.push(b);
      roles.appendChild(b);
    }

    // ---- 战斗

    const fight = row(parent, '战斗');
    fight.appendChild(this.toggle('自动挥击', 'F', 'KeyF', (s) => s.autoAttack));
    // 倒下重开：开着就是接结算流程之前的样子，压力测试要它 —— 测末波必然要死很多次，
    // 每死一次弹一屏结算就测不下去了。
    fight.appendChild(this.toggle('倒下重开', 'V', 'KeyV', (s) => s.autoRespawn));
    fight.appendChild(this.toggle('骨架', 'K', 'KeyK', (s) => s.skeleton));
    fight.appendChild(this.toggle('升级卡牌', 'B', 'KeyB', (s) => s.showCards));
    fight.appendChild(this.button('清场重来', 'X', 'KeyX'));
    // 两个独立的旋钮：出兵管**涌得多快**，同屏上限管**场上能挤多少**。
    fight.appendChild(this.spin('hp', 'KeyN', 'KeyM'));
    fight.appendChild(this.spin('spawn', 'Semicolon', 'Quote'));
    fight.appendChild(this.spin('enemies', 'Comma', 'Period'));

    // 波次：想测哪一波就跳哪一波，跳的同时把人海补到那一波的预算，不用干等四十秒。
    const waves = row(parent, '波次');
    waves.appendChild(this.spin('wave', 'KeyO', 'KeyP'));
    waves.appendChild(this.button('末波压测', '\\', 'Backslash'));

    // ---- 技能装备
    //
    // 每个类别单独成行：自动攻击和护身是单选，发射是多选，主动技依次占 Q/W/E/R 四个槽。
    // 菜单只展示并转发选择，真正的互斥与容量限制由 SkillLoadout 统一执行。
    const categories: SkillCategory[] = ['attack', 'projectile', 'guard', 'active'];
    for (const category of categories) {
      const rule = SkillCategoryRules[category];
      const skills = row(parent, this.text.value(rule.nameKey));
      for (const skill of this.bridge.skills.filter((entry) => entry.category === category)) {
        const b = this.button(skill.name, '');
        b.title = skill.cooldown > 0 ? `${skill.note} · 冷却 ${skill.cooldown.toFixed(1)} 秒` : `${skill.note} · 无冷却`;
        b.addEventListener('click', () => {
          this.bridge.toggleSkill(skill.id);
          this.refresh();
        });
        this.toggles.push({
          node: b,
          on: (state) => state.skillLoadout.equipped.includes(skill.id),
        });
        skills.appendChild(b);
      }
      if (category === 'attack') skills.appendChild(this.button('切换', 'J', 'KeyJ'));
    }
    this.skillNote = el('div', 'menu-note');
    parent.appendChild(this.skillNote);

    // ---- 药物与符咒
    //
    // 只读，不是按钮：这一块回答的是"我手上这几样是干什么的"，用不用得在战场上按数字键。
    this.itemRow = row(parent, '药物符咒');
    this.itemNote = el('div', 'menu-note');
    parent.appendChild(this.itemNote);

    // ---- 天气

    const sky = row(parent, '天气');
    const kinds: { kind: WeatherKind; name: string }[] = [
      { kind: 'clear', name: '晴' },
      { kind: 'rain', name: '雨' },
      { kind: 'snow', name: '雪' },
    ];
    for (const { kind, name } of kinds) {
      const b = this.button(name, '');
      b.addEventListener('click', () => {
        this.bridge.setWeather(kind);
        this.refresh();
      });
      this.toggles.push({ node: b, on: (s) => s.weather === kind });
      sky.appendChild(b);
    }
    sky.appendChild(this.toggle('云', 'C', 'KeyC', (s) => s.cloudy));
    sky.appendChild(this.toggle('风', 'G', 'KeyG', (s) => s.windy));

    // ---- 画面

    const view = row(parent, '画面');
    view.appendChild(this.spin('grain', 'Minus', 'Equal'));
    view.appendChild(this.button('复位', '0', 'Digit0'));
    view.appendChild(this.spin('magnify', 'BracketLeft', 'BracketRight'));
    // 图鉴归"画面"而不是"战斗"：它看的是东西画成什么样，和场上打得怎么样无关。
    view.appendChild(this.toggle('物品图鉴', 'I', 'KeyI', (s) => s.showItems));
  }

  /** 一个普通按钮。给了 code 就等于按下那个键。 */
  private button(text: string, key: string, code?: string): HTMLButtonElement {
    const b = el('button', 'menu-btn');
    b.appendChild(document.createTextNode(text));
    if (key) b.appendChild(el('span', 'menu-key', key));
    if (code) {
      b.addEventListener('click', () => {
        this.bridge.press(code);
        this.refresh();
      });
    }
    return b;
  }

  /** 一个开关按钮：亮起来表示当前是开的。 */
  private toggle(text: string, key: string, code: string, on: (s: MenuState) => boolean): HTMLButtonElement {
    const b = this.button(text, key, code);
    this.toggles.push({ node: b, on });
    return b;
  }

  /** 一个 [− 值 +] 控件。两个键码分别是减和加。 */
  private spin(name: string, downCode: string, upCode: string): HTMLElement {
    const box = el('div', 'menu-spin');
    const down = el('button', undefined, '−');
    const value = el('span');
    const up = el('button', undefined, '+');
    down.addEventListener('click', () => {
      this.bridge.press(downCode);
      this.refresh();
    });
    up.addEventListener('click', () => {
      this.bridge.press(upCode);
      this.refresh();
    });
    box.appendChild(down);
    box.appendChild(value);
    box.appendChild(up);
    this.spins[name] = value;
    return box;
  }

}
