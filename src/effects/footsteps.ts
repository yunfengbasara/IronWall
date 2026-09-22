import { clamp, lerp, v2 } from '../core/math';
import { rgba } from '../render/color';
import { Projection } from '../render/projection';
import { Projector } from '../render/projector';
import type { ShapeBatch } from '../render/shapeBatch';
import type { Character } from '../game/character';
import type { Terrain } from '../world/terrain';
import type { Weather } from '../world/weather';

/**
 * 由真实的步态触地驱动的水花和雪印。移植自 overlord 的 Effects.FootstepEffects。
 *
 * 关键在**触地是从步态相位的跨越读出来的**，不是从脚离地面多近读出来的。看高度会在脚
 * 贴着地面的每一帧都喷一次，而走路时那是大多数帧；看相位跨越则一步正好一次。
 *
 * 三个池子都是有界的，满了就覆盖最老的那个 —— 一场跑很久的仗不能让特效无限堆积。
 */

const MAX_PRINTS = 420;
const MAX_RIPPLES = 160;
const MAX_DROPS = 480;
// 玩家和人群各占一段固定容量。白岭雪原的大湖会让几百个敌人同时踩水；共用环形池时，
// 后处理的敌人能在同一帧覆盖玩家刚生成的反馈。独立池既保住玩家效果，也避免池满后扫描槽位。
const FOCUS_PRINTS = 96;
const FOCUS_RIPPLES = 16;
const FOCUS_DROPS = 48;
/** 雪印留多久。它是"持续"的那一种：雪地上的脚印不会自己消失，只会被新雪盖住。 */
const PRINT_LIFE = 48;

interface Print {
  x: number;
  y: number;
  facing: number;
  age: number;
  strength: number;
  /** 印子的长宽。靴子细长、指着人朝的方向。 */
  long: number;
  wide: number;
}

interface Ripple {
  x: number;
  y: number;
  age: number;
  life: number;
  strength: number;
}

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  height: number;
  vz: number;
  age: number;
  life: number;
  radius: number;
}

export class FootstepEffects {
  /** 0 是人群池，1 是玩家池；两边相加仍等于原来的总容量。 */
  private readonly prints: [Print[], Print[]] = [[], []];
  private readonly ripples: [Ripple[], Ripple[]] = [[], []];
  private readonly drops: [Drop[], Drop[]] = [[], []];

  // 池子满了之后从哪里开始覆盖。
  private readonly printAt = [0, 0];
  private readonly rippleAt = [0, 0];
  private readonly dropAt = [0, 0];

  /** 每个单位上一帧的步态相位。跨越检测要用。 */
  private readonly phase = new WeakMap<Character, number>();
  /**
   * main 每帧取走的纯数据触地数。这里不能 import 浏览器音频层，离线验证也会走 Field。
   *
   * **只数焦点角色。** 场上几百个人都有真实步态，全报出来就是一片白噪音，玩家自己的落脚
   * 反而听不见了 —— 而脚步声唯一的用处就是让玩家听见自己在跑。
   */
  private stepContacts = 0;
  private seed = 20260810;

  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  get count(): number {
    return (
      this.prints[0].length + this.prints[1].length +
      this.ripples[0].length + this.ripples[1].length +
      this.drops[0].length + this.drops[1].length
    );
  }

  reset(): void {
    for (const pool of this.prints) pool.length = 0;
    for (const pool of this.ripples) pool.length = 0;
    for (const pool of this.drops) pool.length = 0;
    this.printAt.fill(0);
    this.rippleAt.fill(0);
    this.dropAt.fill(0);
    this.stepContacts = 0;
  }

  /**
   * 取走玩家这一帧的落脚次数。音频是否可用、播哪一条采样都由 main 决定。
   *
   * 触发时刻就是脚**踩实的那一刻**：相位跨过 0 是左脚、跨过 0.5 是右脚，而动画器里
   * 相位的前半程恰好是支撑段（stepTarget 里 z=0 的那一半）。量过：触发瞬间那只脚的
   * 离地高度是 0.000，且还在身前（y 为正），正是刚落地、还没往身后滑的那一帧。
   */
  drainStepContacts(): number {
    const count = this.stepContacts;
    this.stepContacts = 0;
    return count;
  }

  update(
    actors: Iterable<Character>,
    dt: number,
    terrain: Terrain,
    weather: Weather,
    focus: Character | null = null,
  ): void {
    this.age(dt);

    for (const man of actors) {
      const now = man.gaitPhase;
      const before = this.phase.get(man);
      this.phase.set(man, now);
      if (before === undefined) continue;

      // 站着不动的人不该在原地踩水。1.25 是"确实在走"的下限。
      if (!man.alive || man.speed < 1.25) continue;

      // 相位 0 开始左脚的支撑段，0.5 开始右脚的。跨过这两个瞬间各产生一次触地。
      if (now < before) this.contact(man, man.pose.footL, terrain, weather, man === focus);
      if (before < 0.5 && now >= 0.5) this.contact(man, man.pose.footR, terrain, weather, man === focus);
    }
  }

  private contact(
    man: Character,
    localFoot: { x: number; y: number; z: number },
    terrain: Terrain,
    weather: Weather,
    focus: boolean,
  ): void {
    // 脚是身体局部坐标（x 右、y 前），转到世界用的基和 Projector.ground 完全相同。
    const sin = Math.sin(man.facing);
    const cos = Math.cos(man.facing);
    const wx = man.x + localFoot.x * sin + localFoot.y * cos;
    const wy = man.y - localFoot.x * cos + localFoot.y * sin;

    // 声音不分地面：只有一套脚步素材，踩水踩雪踩土都报。画面那边才分 —— 水面起波纹、
    // 雪地留印子，各走各的分支。
    if (focus) this.stepContacts++;

    const water = clamp(terrain.standingWater(wx, wy, weather), 0, 1);
    if (water > 0.14) {
      this.addRipple(wx, wy, water, focus);
      this.addDrops(wx, wy, man, water, focus);
    } else if (weather.snowCover > 0.12) {
      this.addPrint(wx, wy, man.facing, weather.snowCover, focus);
    }
  }

  private addPrint(x: number, y: number, facing: number, strength: number, focus: boolean): void {
    const group = focus ? 1 : 0;
    push(
      this.prints[group],
      focus ? FOCUS_PRINTS : MAX_PRINTS - FOCUS_PRINTS,
      (i) => (this.printAt[group] = i),
      this.printAt[group],
      { x, y, facing, age: 0, strength: clamp(strength, 0.25, 1), long: 1.45, wide: 0.68 },
    );
  }

  private addRipple(x: number, y: number, strength: number, focus: boolean): void {
    const group = focus ? 1 : 0;
    push(this.ripples[group], focus ? FOCUS_RIPPLES : MAX_RIPPLES - FOCUS_RIPPLES, (i) => (this.rippleAt[group] = i), this.rippleAt[group], {
      x,
      y,
      age: 0,
      life: 0.42 + strength * 0.18,
      strength,
    });
  }

  private addDrops(x: number, y: number, man: Character, strength: number, focus: boolean): void {
    const group = focus ? 1 : 0;
    const count = 3 + Math.round(strength * 3);
    // 水往他走的那一边溅，不是往他脸朝的那一边 —— 玩家用方向键之后这是两个方向了（见
    // Character.moveDir）。
    const vx = Math.cos(man.moveDir) * man.speed;
    const vy = Math.sin(man.moveDir) * man.speed;
    for (let i = 0; i < count; i++) {
      const angle = this.rand() * Math.PI * 2;
      const speed = 5 + this.rand() * (8 + strength * 5);
      push(this.drops[group], focus ? FOCUS_DROPS : MAX_DROPS - FOCUS_DROPS, (n) => (this.dropAt[group] = n), this.dropAt[group], {
        x,
        y,
        vx: Math.cos(angle) * speed + vx * 0.1,
        vy: Math.sin(angle) * speed + vy * 0.1,
        height: 0.15,
        vz: 7 + this.rand() * 8,
        age: 0,
        life: 0.34 + this.rand() * 0.18,
        radius: 0.45 + this.rand() * 0.48,
      });
    }
  }

  private age(dt: number): void {
    for (const pool of this.prints) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i];
        p.age += dt;
        if (p.age >= PRINT_LIFE) discard(pool, i);
      }
    }
    for (const pool of this.ripples) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const r = pool[i];
        r.age += dt;
        if (r.age >= r.life) discard(pool, i);
      }
    }
    for (const pool of this.drops) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const d = pool[i];
        d.age += dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.height += d.vz * dt;
        d.vz -= 42 * dt;
        if (d.age >= d.life || d.height < 0) discard(pool, i);
      }
    }
  }

  /** 平贴在地上的印子和涟漪：压在地形之上，草、影子和脚之下。 */
  drawGround(shapes: ShapeBatch, camX: number, camY: number, rootX: number, rootY: number, scale: number): void {
    const sx = (wx: number) => rootX + (wx - camX) * scale;
    const sy = (wy: number) => rootY + (wy - camY) * Projection.groundSquash * scale;

    for (const pool of this.prints) {
      for (const p of pool) {
        const fade = clamp((PRINT_LIFE - p.age) / 10, 0, 1);
        const alpha = Math.round(fade * lerp(80, 155, p.strength));
        if (alpha <= 2) continue;
        const x = sx(p.x);
        const y = sy(p.y);
        // 印子指着人当时朝的方向，但方向本身要投影：地面被压扁了，一个朝向 45 度的脚印
        // 在屏幕上不是 45 度。
        const rot = Math.atan2(Math.sin(p.facing) * Projection.groundSquash, Math.cos(p.facing));
        shapes.ellipse(
          v2(x, y),
          Math.max(p.long * scale, 0.65),
          Math.max(p.wide * scale, 0.42),
          rot,
          rgba(66, 79, 88, alpha),
          y * Projector.DEPTH_PER_ROW - 25,
        );
      }
    }

    for (const pool of this.ripples) {
      for (const r of pool) {
        const t = r.age / r.life;
        const x = sx(r.x);
        const y = sy(r.y);
        const radius = lerp(1, 6.2 + r.strength * 2.5, t) * scale;
        const alpha = Math.round((1 - t) * lerp(105, 190, r.strength));
        if (alpha <= 2) continue;
        shapes.ellipseRing(
          v2(x, y),
          Math.max(radius, 0.8),
          Math.max(radius * Projection.groundSquash, 0.5),
          0,
          Math.max(0.55, scale * 0.72),
          rgba(177, 222, 232, alpha),
          y * Projector.DEPTH_PER_ROW - 24,
          16,
        );
      }
    }
  }

  /** 飞在空中的水珠。按落点那一行排序，所以它们和溅起它们的人是同一层。 */
  drawSplashes(shapes: ShapeBatch, camX: number, camY: number, rootX: number, rootY: number, scale: number): void {
    for (const pool of this.drops) {
      for (const d of pool) {
        const fade = 1 - d.age / d.life;
        const gx = rootX + (d.x - camX) * scale;
        const gy = rootY + (d.y - camY) * Projection.groundSquash * scale;
        shapes.disc(
          v2(gx, gy - d.height * Projection.heightSquash * scale),
          Math.max(0.48, d.radius * scale),
          rgba(205, 238, 244, Math.round(fade * 220)),
          gy * Projector.DEPTH_PER_ROW + 3,
        );
      }
    }
  }
}

/**
 * 没满就追加，满了就原地覆盖最老的一个。
 *
 * 原版一开始是 RemoveAt(0) 把整个列表往前挪一格，在"每人两只脚"的时候还行；一旦水花
 * 变多，每一次添加都是一次几百项的内存搬移。这里画出来的东西没有任何顺序含义，所以
 * 最老的那个槽直接重用就行。
 */
function push<T>(
  pool: T[],
  limit: number,
  setCursor: (i: number) => void,
  cursor: number,
  item: T,
): void {
  if (pool.length < limit) {
    pool.push(item);
    return;
  }

  const at = cursor >= limit ? 0 : cursor;
  pool[at] = item;
  setCursor((at + 1) % limit);
}

/**
 * 用最后一个填洞。在上面那些倒序循环里是安全的：换进来的项来自本帧已经处理过的下标，
 * 不会被处理两次也不会被跳过。
 */
function discard<T>(pool: T[], index: number): void {
  pool[index] = pool[pool.length - 1];
  pool.pop();
}
