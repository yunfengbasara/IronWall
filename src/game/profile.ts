/**
 * 跨局存档：金币、每个角色各自的等级与经验、已经解锁的主动技。
 *
 * 这是整个工程里第一份**离开这一局还活着**的数据。分界线画在这里：
 *
 *   灵石   一局之内的东西。收满一轮弹一次三选一，这一局结束就清零，不写进存档。
 *   金币   跨局的东西。一局打完加进总数，后面的商店拿它消费。
 *   等级   跨局的东西，而且**每个角色各记各的** —— 练满的双锤武将不该让第一次上手的骑士
 *          直接满级。存档里按角色 id 开键，加一个新角色不用动这里。
 *
 * 存在 localStorage 里。读不出来就当作一份全新的存档，不报错也不弹窗：存档丢了最多是从头
 * 练，而一个打不开的游戏比一份空存档糟得多。
 */

import { MAX_LEVEL, expToNextLevel } from '../data/balance';
import { MASTERY_MAX, ROOT_MAX_RANK, Roots, SUPPLY_MAX } from '../data/shop';
import type { StatBonus } from '../data/types';
import { Heroes } from '../data/heroes';
import type { HudLocale } from '../ui/text/hudText.types';

const STORAGE_KEY = 'ironwall.profile.v1';

/**
 * 一个角色的进度。
 *
 * **没有技能。** 技能是一局之内的东西：每一局都从一个自动攻击技加一双靴子开始，别的靠场上
 * 收灵石抽牌拿，打完就清（见 game/skillLoadout.ts 的 startRun）。存档里留下的只有练出来的
 * 等级，以及跨局的家底金币 —— 后者以后由商店换成永久的属性。
 */
export interface HeroProgress {
  level: number;
  /** 当前这一级已经攒了多少经验，不是累计值。经验条直接画它。 */
  exp: number;
}

/**
 * 一局打完留下来的战绩。
 *
 * **只记总数和最近一局，不记每一局。** 一份存档要活很久，按局追加的话它会一直长，
 * 而玩家在这一屏上要问的只有两件事："我上一局打得怎么样"和"我拿这个人打得怎么样"。
 * 一张按局的流水帐回答不了第二件，而总数两件都回答得了。
 */
export interface HeroRecord {
  /** 打了几局。中途自己退出的也算 —— 那也是一局。 */
  runs: number;
  /** 赢了几局（清完所有首领）。 */
  wins: number;
  kills: number;
  /** 砍掉的首领数。 */
  bosses: number;
  /** 挺了多少伤害（减免之后真正掉的血）。 */
  damageTaken: number;
  /** 打了多久，秒。 */
  time: number;
  coins: number;
  gems: number;
  /** 最远打到第几波。 */
  bestWave: number;
  /** 最近那一局。没打过就是 null。 */
  last: RunRecord | null;
}

/** 一局的战绩。结算那一屏上写的那几个数，原样存一份。 */
export interface RunRecord {
  map: string;
  won: boolean;
  kills: number;
  bosses: number;
  damageTaken: number;
  time: number;
  coins: number;
  gems: number;
  wave: number;
  waves: number;
  /** 打完的时间戳，毫秒。界面上写成"几天前"。 */
  at: number;
}

/** 存档里那一份设置。 */
export interface ProfileSettings {
  locale: HudLocale;
  /** 音效开关。 */
  sfx: boolean;
  /** 音乐开关。和音效分开：常有人只想关掉音乐、留着打击声。 */
  music: boolean;
}

export interface ProfileData {
  version: number;
  coins: number;
  heroes: Record<string, HeroProgress>;
  /** 每个角色的战绩。老存档里没有，读的时候补一份空的。 */
  records: Record<string, HeroRecord>;
  /**
   * 商店买的三样东西。都是**全账号**的，不按角色分。
   *
   * 金币本来就是一个公共池，按角色分的话四个角色等于四条独立的长线，而练满一个角色
   * 已经要八十五万经验了。
   */
  roots: Partial<Record<string, number>>;
  mastery: Partial<Record<string, number>>;
  /** 屯着的补给，进图那一刻发到快捷栏。 */
  supplies: Partial<Record<string, number>>;
  /**
   * 设置。全账号一份，和角色无关。
   *
   * 单独一个对象而不是几个平铺的字段：以后要加的音效、音乐开关是同一类东西，加在这里面
   * 只动一行，而 load 那边的补默认值也只补这一个对象。
   */
  settings: ProfileSettings;
  /** 上次选的角色和地图，回到备战界面时停在原处。 */
  lastHero: string;
  lastMap: string;
}

/** 一次升级里发生了什么。界面拿它弹提示。 */
export interface LevelUpResult {
  levels: number;
  level: number;
}

function freshProgress(): HeroProgress {
  return { level: 1, exp: 0 };
}

function freshRecord(): HeroRecord {
  return {
    runs: 0, wins: 0, kills: 0, bosses: 0, damageTaken: 0,
    time: 0, coins: 0, gems: 0, bestWave: 0, last: null,
  };
}

/**
 * 第一次打开时说哪种话：**中文浏览器给中文，其余一律英文**。
 *
 * 看不懂界面的人不会去翻设置，只会关掉页面 —— 而这个游戏发在 itch.io 这类国际平台上，
 * 打开它的人大多数不读中文。猜对了省一次切语言，猜错了也只是 ESC 页上点一下，而且会存进存档。
 *
 * **只看排在第一位的那一个语言标签。** 不扫整个 navigator.languages：一个主语言是英文、
 * 列表里带着 zh 的人，要的是英文。languages[0] 比 language 优先，因为有些浏览器里
 * 后者是界面语言、前者才是用户排过序的偏好。
 *
 * zh-TW / zh-HK 也落到 zh-CN 这一档：简繁是两回事，但看得懂的简体比看不懂的英文近。
 * 哪天补了繁体语言包，这里按 zh-Hant / TW / HK 再分一支。
 *
 * typeof 守卫：profile.ts 现在只被浏览器那一侧引用，但 game/ 下的东西被 node 脚本
 * （bench、figures）拉进去过，那边没有 navigator —— 留一道守卫，哪天被引到也不会当场炸。
 */
function detectLocale(): HudLocale {
  if (typeof navigator === 'undefined') return 'en';
  const tag = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase();
  return tag.startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 一份全新存档的默认设置。语言跟着浏览器走（见 detectLocale），只算一次 ——
 * 存下来之后就是玩家自己的选择，换了浏览器语言也不会把他手动改过的设置推翻。
 */
function freshSettings(): ProfileSettings {
  return { locale: detectLocale(), sfx: true, music: true };
}

function freshProfile(): ProfileData {
  const heroes: Record<string, HeroProgress> = {};
  const records: Record<string, HeroRecord> = {};
  for (const hero of Heroes) {
    heroes[hero.id] = freshProgress();
    records[hero.id] = freshRecord();
  }
  return {
    version: 1,
    coins: 0,
    heroes,
    records,
    roots: {},
    mastery: {},
    supplies: {},
    settings: freshSettings(),
    lastHero: Heroes[0].id,
    lastMap: 'proving',
  };
}

/**
 * 存档。
 *
 * 每次写都整份序列化 —— 这份数据只有几百字节，为它做增量写入不值得，而且整份写保证磁盘上
 * 永远是一个自洽的快照。
 */
export class Profile {
  private data: ProfileData;

  constructor(data: ProfileData = freshProfile()) {
    this.data = data;
  }

  /**
   * 从 localStorage 读。读不出来、解析不了、或者版本对不上都退回一份新的。
   *
   * 无痕窗口和禁用站点数据的浏览器里连读都会抛，所以整段包在 try 里。存档不是这个游戏能不能
   * 跑起来的前提。
   */
  static load(): Profile {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Profile();
      const parsed = JSON.parse(raw) as Partial<ProfileData>;
      if (parsed.version !== 1) return new Profile();
      const profile = new Profile({ ...freshProfile(), ...parsed } as ProfileData);
      // 存档是上一版写的时候，新加的角色在里面没有记录。补齐而不是整份作废。
      // 存档是上一版写的时候，新加的角色在里面没有记录。补齐而不是整份作废。
      // 战绩那一块是后加的，旧存档里整个不存在 —— 同样补一份空的，不当作版本不匹配。
      profile.data.records ??= {};
      // 商店那三块也是后加的，同样补空而不是整份作废。
      profile.data.roots ??= {};
      profile.data.mastery ??= {};
      profile.data.supplies ??= {};
      // 设置也是后加的。整份补默认，再把旧存档里已有的字段盖回去。
      profile.data.settings = { ...freshSettings(), ...(parsed.settings ?? {}) };
      for (const hero of Heroes) {
        if (!profile.data.heroes[hero.id]) profile.data.heroes[hero.id] = freshProgress();
        if (!profile.data.records[hero.id]) profile.data.records[hero.id] = freshRecord();
      }
      return profile;
    } catch {
      return new Profile();
    }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // 写不进去就算了。这一局照常能打完，只是下次打开回到上一个存档点。
    }
  }

  /**
   * 抹掉整份存档，回到第一次打开游戏的状态：金币、等级、战绩、根基、师承、补给全清。
   *
   * **就地换掉 data，而不是让调用方去 new 一个 Profile。** 这一份 Profile 的引用已经散在
   * main.ts、商店、备战界面和战绩屏里了，换一个新对象的话那几处还攥着旧的，界面上会出现
   * 一半清了一半没清 —— 比不清更糟。
   *
   * **设置那一块留着**（语言、音效、音乐）：玩家点的是"重新开始"，不是"把我的浏览器调回
   * 出厂"。把界面语言也一起清掉，一个英文玩家会在一屏中文里找不到回去的路。
   *
   * 先写盘再返回：这一下要是没落地，玩家下次打开会发现进度又回来了，而他明明已经确认过了。
   */
  resetProgress(): void {
    const settings = this.data.settings;
    this.data = freshProfile();
    this.data.settings = { ...settings };
    this.save();
  }

  get coins(): number {
    return this.data.coins;
  }

  /** 一局打完把这一局收的金币并进总数。以后商店那边会有对应的 spend。 */
  addCoins(amount: number): void {
    if (amount <= 0) return;
    this.data.coins += Math.floor(amount);
    this.save();
  }

  /**
   * 花钱。余额不够就什么也不做，返回 false。
   *
   * 商店模块还没有，先把这个口留在这里 —— 花钱这件事只该有一个出口，散在各个界面里迟早会
   * 出现一处忘了 save 的。
   */
  spendCoins(amount: number): boolean {
    if (amount <= 0 || this.data.coins < amount) return false;
    this.data.coins -= amount;
    this.save();
    return true;
  }

  progress(heroId: string): HeroProgress {
    let entry = this.data.heroes[heroId];
    if (!entry) {
      entry = freshProgress();
      this.data.heroes[heroId] = entry;
    }
    return entry;
  }

  level(heroId: string): number {
    return this.progress(heroId).level;
  }

  /**
   * 给这个角色加经验，够了就升级。
   *
   * 一次可能连升几级 —— 打首领或者一局结束一次性结算时都会发生，所以是循环而不是一个 if。
   * 返回这次升了几级，没升就是 0。
   */
  addExp(heroId: string, amount: number): LevelUpResult {
    const entry = this.progress(heroId);
    if (amount <= 0 || entry.level >= MAX_LEVEL) return { levels: 0, level: entry.level };
    entry.exp += amount;
    let levels = 0;
    while (entry.level < MAX_LEVEL) {
      const need = expToNextLevel(entry.level);
      if (entry.exp < need) break;
      entry.exp -= need;
      entry.level++;
      levels++;
    }
    // 满级之后经验不再累计，进度条停在满格。
    if (entry.level >= MAX_LEVEL) entry.exp = 0;
    this.save();
    return { levels, level: entry.level };
  }

  /** 这个角色的战绩。没打过也给一份空的，界面那边不用写分支。 */
  record(heroId: string): HeroRecord {
    let entry = this.data.records[heroId];
    if (!entry) {
      entry = freshRecord();
      this.data.records[heroId] = entry;
    }
    return entry;
  }

  /**
   * 一局打完，记一笔。
   *
   * 和 addCoins/addExp 分开调：那两条是"带得走的东西"，这一条是"发生过的事"。同一个
   * settleRun 里前后脚调，但它们回答的不是同一个问题，以后商店改金币也不该动到战绩。
   */
  recordRun(heroId: string, run: RunRecord): void {
    const entry = this.record(heroId);
    entry.runs++;
    if (run.won) entry.wins++;
    entry.kills += run.kills;
    entry.bosses += run.bosses;
    entry.damageTaken += run.damageTaken;
    entry.time += run.time;
    entry.coins += run.coins;
    entry.gems += run.gems;
    entry.bestWave = Math.max(entry.bestWave, run.wave);
    entry.last = run;
    this.save();
  }

  // ------------------------------------------------------------ 商店

  /** 这一项根基买到几级。0 = 没买。 */
  root(key: string): number {
    return Math.max(0, Math.min(ROOT_MAX_RANK, this.data.roots[key] ?? 0));
  }

  /** 这一招的师承买到几级。0 = 没买，起始等级就是 1。 */
  mastery(id: string): number {
    return Math.max(0, Math.min(MASTERY_MAX, this.data.mastery[id] ?? 0));
  }

  /** 手上屯着几个这种补给。 */
  supply(id: string): number {
    return Math.max(0, Math.min(SUPPLY_MAX, this.data.supplies[id] ?? 0));
  }

  /**
   * 根基那一包加成。算在角色属性的**第四层**（见 game/stats.ts）。
   *
   * 每帧都会被问到，但里面只有六项，现算比缓存一份再想着什么时候失效便宜得多。
   */
  rootBonus(): StatBonus {
    const out: StatBonus = {};
    for (const def of Roots) {
      const rank = this.root(def.key);
      if (rank > 0) out[def.key] = def.perRank * rank;
    }
    return out;
  }

  /** 买一级根基。钱不够或者已满返回 false。 */
  buyRoot(key: string, price: number): boolean {
    if (this.root(key) >= ROOT_MAX_RANK || !this.spendCoins(price)) return false;
    this.data.roots[key] = this.root(key) + 1;
    this.save();
    return true;
  }

  buyMastery(id: string, price: number): boolean {
    if (this.mastery(id) >= MASTERY_MAX || !this.spendCoins(price)) return false;
    this.data.mastery[id] = this.mastery(id) + 1;
    this.save();
    return true;
  }

  buySupply(id: string, price: number): boolean {
    if (this.supply(id) >= SUPPLY_MAX || !this.spendCoins(price)) return false;
    this.data.supplies[id] = this.supply(id) + 1;
    this.save();
    return true;
  }

  /**
   * 进图那一刻把屯着的补给全发出去，存档里清空。
   *
   * **发出去就算花了，没用完也不退。** 这是故意的：局内打出来的符和买来的符摧在同一排
   * 格子里，要分出"剩下的这两张是买的还是损的"就得给每一张符记一个来历，
   * 而那一整套账只为了退几枚金币。"这一局的补给"本来就该随这一局一起结束。
   */
  takeSupplies(): { id: string; count: number }[] {
    const out: { id: string; count: number }[] = [];
    for (const [id, count] of Object.entries(this.data.supplies)) {
      if ((count ?? 0) > 0) out.push({ id, count: count as number });
    }
    this.data.supplies = {};
    if (out.length > 0) this.save();
    return out;
  }

  get locale(): HudLocale {
    return this.data.settings.locale;
  }

  setLocale(locale: HudLocale): void {
    if (this.data.settings.locale === locale) return;
    this.data.settings.locale = locale;
    this.save();
  }

  get sfxEnabled(): boolean {
    return this.data.settings.sfx;
  }

  setSfxEnabled(on: boolean): void {
    if (this.data.settings.sfx === on) return;
    this.data.settings.sfx = on;
    this.save();
  }

  get musicEnabled(): boolean {
    return this.data.settings.music;
  }

  setMusicEnabled(on: boolean): void {
    if (this.data.settings.music === on) return;
    this.data.settings.music = on;
    this.save();
  }

  get lastHero(): string {
    return this.data.lastHero;
  }

  get lastMap(): string {
    return this.data.lastMap;
  }

  remember(heroId: string, mapId: string): void {
    this.data.lastHero = heroId;
    this.data.lastMap = mapId;
    this.save();
  }
}
