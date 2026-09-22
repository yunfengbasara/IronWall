/**
  * 支持的语言。
  *
  * 放在这个文件而不是 hudText.ts，因为存档（game/profile.ts）要存玩家选的语言，而
  * hudText.ts 第一行就 import 了一张 css —— 那会把一张样式表拖进纯数据那一侧，连带
  * 把离线跑数的那几个脚本弄坏（esbuild 打 node 包时没有 css 的 loader）。这个文件只有类型。
  */
export type HudLocale = 'zh-CN' | 'en';

/**
 * 全部文案。**这是"这个游戏说哪些话"的唯一清单。**
 *
 * 界面上的每一句话都从这里取，包括数据层里那些名字和说明 —— data/ 和 game/ 下的定义
 * 不再写死中文，改成写一个 key（类型就是下面的 HudTextKey），由界面拿着 HudText 去解。
 * 数据那一侧只 import 这个文件的**类型**，所以不会把 css 拖进 node 脚本里（见上面那段）。
 *
 * 加一句话要动三个文件：这里加键、两个语言包各加一行。少一个 tsc 就不过 —— 那正是要的：
 * 漏翻译在编译期就被拦住，而不是等到英文玩家看见一句中文。
 */
export interface HudMessages {
  // ------------------------------------------------------------------ 战斗 HUD
  gameTitle: string;
  playerLevel: string;
  health: string;
  mana: string;
  experience: string;
  experienceValue: string;
  wavePanel: string;
  waveTitle: string;
  finalStandTitle: string;
  nextWaveCountdown: string;
  waveProgress: string;
  /** 左上角那行淡字：告诉玩家 ESC 能暂停。按钮没了，这是唯一还说这件事的地方。 */
  pauseHint: string;
  language: string;
  sound: string;
  music: string;
  on: string;
  off: string;
  currencyInfo: string;
  gold: string;
  energy: string;
  gemProgress: string;
  activeSkills: string;
  activeSkillSlot: string;
  emptyActiveSkillSlot: string;
  itemQuickbar: string;
  itemSlot: string;
  itemEffect: string;
  cooldownPanel: string;
  currentItems: string;

  // ------------------------------------------------------------------ 通用按钮
  back: string;
  confirm: string;

  // ------------------------------------------------------------------ 技能名
  skillSweep: string;
  skillSpin: string;
  skillWave: string;
  skillHeavenSplit: string;
  skillSkyArrow: string;
  skillLunge: string;
  skillAegis: string;
  skillDharma: string;
  skillHeavenGuard: string;
  skillSprint: string;
  skillIronBody: string;
  skillBulwark: string;
  skillMend: string;
  skillBerserk: string;
  skillBloodthirst: string;

  // 技能说明。牌面上名字下面那一行，也是快捷栏悬停时看到的那句。
  skillSweepNote: string;
  skillSpinNote: string;
  skillWaveNote: string;
  skillHeavenSplitNote: string;
  skillSkyArrowNote: string;
  skillLungeNote: string;
  skillAegisNote: string;
  skillDharmaNote: string;
  skillHeavenGuardNote: string;
  skillSprintNote: string;
  skillIronBodyNote: string;
  skillBulwarkNote: string;
  skillMendNote: string;
  skillBerserkNote: string;
  skillBloodthirstNote: string;

  /** 技能的四个类别。配招界面和调试面板按这个分组。 */
  skillKindAttack: string;
  skillKindProjectile: string;
  skillKindGuard: string;
  skillKindActive: string;

  // ------------------------------------------------------------------ 商店
  shopTitle: string;
  shelfRoots: string;
  shelfRootsNote: string;
  shelfMastery: string;
  shelfMasteryNote: string;
  shelfSupply: string;
  shelfSupplyNote: string;
  rootOwnedBonus: string;
  rootPerRankBonus: string;
  masteryStartLevel: string;
  supplyStock: string;
  supplyFull: string;
  rankFull: string;

  /** 六项根基。和三选一属性牌说的是同一批属性，但那边是一局之内、这边是永久。 */
  rootMaxHp: string;
  rootAttack: string;
  rootDefense: string;
  rootMoveSpeed: string;
  rootAttackSpeed: string;
  rootAttackRange: string;

  // ------------------------------------------------------------------ 丹与符（补给）
  pickupHealName: string;
  pickupHealNote: string;
  pickupManaName: string;
  pickupManaNote: string;
  pickupRegenName: string;
  pickupRegenNote: string;
  pickupFocusName: string;
  pickupFocusNote: string;
  pickupHasteName: string;
  pickupHasteNote: string;
  pickupWardName: string;
  pickupWardNote: string;
  pickupRageName: string;
  pickupRageNote: string;
  pickupGaleName: string;
  pickupGaleNote: string;
  pickupGoldenName: string;
  pickupGoldenNote: string;
  pickupFortuneName: string;
  pickupFortuneNote: string;

  // ------------------------------------------------------------------ 清档
  resetTitle: string;
  resetConfirm: string;
  resetDone: string;

  // ------------------------------------------------------------------ 战绩
  historyTitle: string;
  historyRuns: string;
  historyNotPlayed: string;
  historyTotal: string;
  historyWinRate: string;
  historyWinRateValue: string;
  historyKills: string;
  historyBosses: string;
  historyDamageTaken: string;
  historyTotalTime: string;
  historyBestWave: string;
  historyLastRun: string;
  historyNeverPlayed: string;
  historyResult: string;
  historyWon: string;
  historyLost: string;
  historyKillsOne: string;
  historyTimeOne: string;
  historyWave: string;
  /** "多久以前"。超过一周就退回系统日期格式，不走这几条。 */
  agoJustNow: string;
  agoMinutes: string;
  agoHours: string;
  agoDays: string;

  // ------------------------------------------------------------------ 结算 / 暂停
  summaryResume: string;
  summaryEnd: string;
  summaryEndConfirm: string;
  summaryWonTitle: string;
  summaryDefeatedTitle: string;
  summaryOverTitle: string;
  summaryPausedTitle: string;
  summaryVerdictWon: string;
  summaryVerdictLost: string;
  summaryWaves: string;
  summaryNoteWon: string;
  summaryNoteDefeated: string;
  summaryNoteEnded: string;
  summaryNotePaused: string;
  statKills: string;
  statDeaths: string;
  statDamageTaken: string;
  statTime: string;
  statWave: string;
  statCleared: string;
  statLoot: string;
  statExp: string;
  statLevel: string;
  /** 战绩和结算里的金币/灵石。和 HUD 那两条分开：那边是全大写的像素标签，这边混在一屏句式大小写的表格里。 */
  statGold: string;
  statGems: string;

  // ------------------------------------------------------------------ 备战界面
  setupStart: string;
  setupEntering: string;
  setupLead: string;
  setupGrowth: string;
  setupEnvironment: string;
  setupTerrain: string;
  setupSight: string;
  setupWeather: string;
  setupObjective: string;
  setupFoes: string;
  setupBossTag: string;
  setupSpawn: string;
  setupCamp: string;
  setupMapHint: string;
  setupEnteringMap: string;
  setupEnteringHero: string;
  setupPreparing: string;
  /** 属性行。和卡牌、商店说的是同一批属性，名字必须一致。 */
  statHp: string;
  statAttack: string;
  statDefense: string;
  statSpeed: string;
  statAgility: string;
  statCrit: string;
  statRange: string;
  statPickup: string;
  archetypeOffense: string;
  archetypeDefense: string;
  archetypeSpeed: string;
  archetypeBalanced: string;
  weatherClear: string;
  weatherRain: string;
  weatherSnow: string;

  // ------------------------------------------------------------------ 三选一属性牌
  cardPicker: string;
  cardAttack: string;
  cardAttackDetail: string;
  cardAttackSpeed: string;
  cardAttackSpeedDetail: string;
  cardAttackRange: string;
  cardAttackRangeDetail: string;
  cardPickupRange: string;
  cardPickupRangeDetail: string;
  cardDefense: string;
  cardDefenseDetail: string;
  cardMoveSpeed: string;
  cardMoveSpeedDetail: string;
  cardMaxHp: string;
  cardMaxHpDetail: string;
  cardMpRegen: string;
  cardMpRegenDetail: string;
  cardLevelUp: string;
  /** 获取牌底下那一行：这一招属于哪一类。 */
  cardObtain: string;
  cardSkillUpgrade: string;

  // ------------------------------------------------------------------ 角色
  heroWarlordName: string;
  heroWarlordTagline: string;
  heroWarlordBlurb: string;
  heroKnightName: string;
  heroKnightTagline: string;
  heroKnightBlurb: string;
  heroBladeName: string;
  heroBladeTagline: string;
  heroBladeBlurb: string;
  heroLancerName: string;
  heroLancerTagline: string;
  heroLancerBlurb: string;

  // ------------------------------------------------------------------ 敌人
  unitThugName: string;
  unitThugNote: string;
  unitPeasantName: string;
  unitPeasantNote: string;
  unitSpearmanName: string;
  unitSpearmanNote: string;
  unitShieldmanName: string;
  unitShieldmanNote: string;
  unitBulwarkName: string;
  unitBulwarkNote: string;
  unitArcherName: string;
  unitArcherNote: string;
  unitHalberdierName: string;
  unitHalberdierNote: string;
  unitCavalryName: string;
  unitCavalryNote: string;
  unitLancerName: string;
  unitLancerNote: string;
  unitHorseArcherName: string;
  unitHorseArcherNote: string;
  unitEliteName: string;
  unitEliteNote: string;
  unitKnightBossName: string;
  unitKnightBossNote: string;

  // ------------------------------------------------------------------ 地图
  mapProvingName: string;
  mapProvingTag: string;
  mapProvingBlurb: string;
  mapProvingTerrain: string;
  mapProvingWeather: string;
  mapProvingSight: string;
  mapProvingObjective: string;
  mapProvingBossName: string;
  mapPassName: string;
  mapPassTag: string;
  mapPassBlurb: string;
  mapPassTerrain: string;
  mapPassWeather: string;
  mapPassSight: string;
  mapPassObjective: string;
  mapPassBossName: string;
  mapSteppeName: string;
  mapSteppeTag: string;
  mapSteppeBlurb: string;
  mapSteppeTerrain: string;
  mapSteppeWeather: string;
  mapSteppeSight: string;
  mapSteppeObjective: string;
  mapSteppeBossName: string;
  mapSnowName: string;
  mapSnowTag: string;
  mapSnowBlurb: string;
  mapSnowTerrain: string;
  mapSnowWeather: string;
  mapSnowSight: string;
  mapSnowObjective: string;
  mapSnowBossName: string;
  /** 首领在出兵表里还没安排上，四张图共用这一句。 */
  mapBossPending: string;

  // ------------------------------------------------------------------ 加载
  loadingTitle: string;
  bootRenderer: string;
  bootTerrain: string;
  bootBake: string;
  bootItems: string;
  bootAudio: string;
  bootField: string;
}

export type HudTextKey = keyof HudMessages;
export type HudTextParams = Readonly<Record<string, string | number>>;
