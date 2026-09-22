import skill01Url from '../../assets/hud/item/skill/skill-01.png';
import skill02Url from '../../assets/hud/item/skill/skill-02.png';
import skill03Url from '../../assets/hud/item/skill/skill-03.png';
import skill04Url from '../../assets/hud/item/skill/skill-04.png';
import skill05Url from '../../assets/hud/item/skill/skill-05.png';
import skill06Url from '../../assets/hud/item/skill/skill-06.png';
import skill07Url from '../../assets/hud/item/skill/skill-07.png';
import skill08Url from '../../assets/hud/item/skill/skill-08.png';
import skill09Url from '../../assets/hud/item/skill/skill-09.png';
import skill10Url from '../../assets/hud/item/skill/skill-10.png';
import bootsUrl from '../../assets/hud/icon/boots.png';
import type { SkillId } from '../game/skills';
import { HUD_ICON_URLS } from './hudIcons';

/**
 * 一招一张图，全工程只有这一份。
 *
 * 以前是三份：快捷栏一份、三选一的牌一份、选人界面按**类别**给一张 HUD 小图标。结果同一招
 * 在三个地方长着三个样子 —— 突进在快捷栏上是 skill-01、在牌上是 skill-10，而在选人界面上
 * 它和横扫、破空共用一张"火"。玩家要记的不是招的名字就是招的样子，而那样他记住的东西到了
 * 下一个界面就不认得了。
 *
 * 谁是对的以牌为准：牌那一份本来就是十招十张、互不重样的，另外两处跟着它改。
 *
 * **会出现在牌里的那十个互不重样。** 原来有三处共用：金钟罩和开天同一张、天地法相和穿云箭
 * 同一张、铁布衫和磐石同一张。于是三选一里明明是三件不同的东西，牌面上却摆着两张一模一样的图
 * —— 玩家读牌先看图，第一反应就是"这一轮出重复了"。符篓图一共十张，正好够那十个一人一张。
 *
 * 剩下三个借 HUD 那套图标：疾走本来就不会出现在牌里（它不进牌库），而且用一双靴子是有意的 ——
 * 它本来也不是一招，是走位；锋锐和疾锋则和某张属性牌撞图 —— 那比和另一个技能撞图轻得多，
 * 因为它们说的本来就是同一件事（剑＝攻击、火＝频率），而抽牌那边还会保证同一轮里不会两张都出现。
 */
export const SKILL_ICONS: Record<SkillId, string> = {
  sweep: skill01Url,
  spin: skill09Url,
  wave: skill03Url,
  lunge: skill10Url,
  aegis: skill05Url,
  dharma: skill08Url,
  heavenSplit: skill02Url,
  skyArrow: skill04Url,
  ironBody: skill06Url,
  bulwark: skill07Url,
  sprint: bootsUrl,
  /*
   * 回春借 HUD 那块肉。符篓图一共十张，已经被十招占满了，所以它只能在 HUD 这套里挑一张。
   *
   * **原来用的是那个瓶子，而那个瓶子就是一瓶药。** 蓝色的玻璃瓶加木塞是"喝下去"的样子，
   * 不是"一招"的样子 —— 快捷栏里同时还摆着真的丹（pickupIcons 那几张），于是玩家看到的是
   * 技能格里混进了一件消耗品。而且它和法力回复那张属性牌本来就撞图（hudCardPicker）。
   *
   * 肉是这套图标里唯一一个"回血"读得出来、又不像药的：它是所有游戏都在用的那个回血信号，
   * 而且是**吃下去慢慢长回来**的那一种，正好是回春在场上的样子（十秒里一秒回一口，不是
   * 一口闷）。和疾走那双靴子是同一个做法 —— 用一件读得懂的东西，而不是一张看不出是什么的符。
   */
  mend: HUD_ICON_URLS.meat,
  // 狂暴借那张火：它和攻击频率那张属性牌撞图，而两者说的本来就是同一件事。
  berserk: HUD_ICON_URLS.fire,
  // 饮血借 HUD 那张心：符篓图一共十张，已经被十招占满。心和回血本来就是同一件事。
  bloodthirst: HUD_ICON_URLS.heart,
  // 神兵天降借 HUD 那面盾。它和防御那张属性牌撞图，而这一招的全部内容正是**一排盾**推过来 ——
  // 十张符箓早就占满了，而在剩下那几张里，没有比一面盾更贴的。
  heavenGuard: HUD_ICON_URLS.shield,
};

/** 一个 `<img>`，图是这一招的。三处界面共用，省得各自去拼 img 的那几个属性。 */
export function createSkillIcon(id: SkillId, className?: string): HTMLImageElement {
  const image = document.createElement('img');
  image.className = ['skill-icon', className].filter(Boolean).join(' ');
  image.src = SKILL_ICONS[id];
  image.alt = '';
  image.draggable = false;
  return image;
}
