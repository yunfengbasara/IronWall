import { clamp } from '../core/math';
import type { Camera } from '../render/camera';

export interface ControlHooks {
  onKey(code: string): void;
  onActiveChange(active: boolean): void;
  canActivate(): boolean;
  /**
   * 按下了 ESC。
   *
   * 它**不再**等于"暂停"。ESC 归游戏流程管（弹临时结算画面，见 ui/summary.ts），调试
   * 菜单走 F1 —— 两件事从这里就分开，Controls 自己不再替谁做决定。长按不重复触发。
   */
  onEscape(): void;
  /**
   * 按下了 F1：调试菜单。
   *
   * 原来这是 HUD 右上角那个系统按钮。按钮拿掉了 —— 激烈打起来的时候没人会把鼠标挪到
   * 屏幕角上点两个 42 像素的图标，而它们一直占着小地图上方那一条。
   *
   * 和 ESC 一样长按不重复。F1 在浏览器里默认开帮助页，所以这一条**必须** preventDefault。
   */
  onDebugMenu(): void;
}

/**
 * 走路有两条路，看向哪儿一条也没有。
 *
 * 走：WASD，或者按住左键朝光标走。两条路说的是同一件事（"我要往那边挪"），键盘优先 ——
 * 按下方向键的那一刻，手已经明确表态了。翻译成一个方向向量是上层的事（见 main 的 readInput），
 * 这里只管报"键盘指着哪儿"和"左键按着没有"。
 *
 * 打：不归这里管，也不归玩家管。朝向由战斗自己锁最近的敌人（见 Battle.aimPlayer）。
 */
/**
 * 走路那四个键。单独列出来是给 keydown 拦默认行为用的（见构造里那段）。
 *
 * 移动在方向键上而不是 WASD：这个游戏一只手鼠标一只手键盘，而键盘那只手要同时按到走路、
 * Q/W/E 三个技能和 R 跑步 —— 走路挪到方向键之后，字母区整片都留给了技能。
 */
const MOVE_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Controls {
  /** 光标的缓冲坐标，与人物投影保持一致。按住左键时人朝它走。 */
  readonly cursor = { x: 0, y: 0 };
  readonly keys = new Set<string>();
  active = false;
  /** 左键按在画布上、人正朝光标走。 */
  moving = false;

  /**
   * 左键这一刻按着没有。**按在哪儿都算**，包括按在界面上。
   *
   * 和 moving 是两件事：moving 是"人在走"，只有按在画布上才立得起来；这一条是"手指还压着"。
   * 分开记是为了补上一个洞 —— 界面上任何一层弹出物（升级卡那块幕布最典型）都会把 mousedown
   * 吃掉，而玩家往往按着不放就想接着走，结果人钉在原地，直到他松手再按一次。
   */
  private primaryDown = false;
  /**
   * 这一次按下不许触发移动，直到松手。
   *
   * 只有一处会立起来：从暂停里点回来的那一下（resume）。那一下是"继续游戏"，不是"往那边走"
   * —— 否则玩家一回到游戏就朝着他刚才点确认的位置冲出去。
   */
  private holdBlocked = false;

  /** WASD 折出来的世界方向，长度 0 或 1。复用同一份，见 keyboardMove。 */
  private readonly move = { x: 0, y: 0 };

  private readonly canvas: HTMLCanvasElement;
  private readonly camera: Camera;
  private readonly hooks: ControlHooks;
  private clientPosition: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, camera: Camera, hooks: ControlHooks) {
    this.canvas = canvas;
    this.camera = camera;
    this.hooks = hooks;

    // 捕获阶段记"手指压着没有"：界面上的弹出层会在冒泡前把事件吃掉，这一层要在它之前。
    addEventListener('mousedown', (event) => {
      if (event.button === 0) this.primaryDown = true;
    }, true);

    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      this.trackPointer(event);
      if (!this.active) {
        this.resume();
        return; // 继续游戏的这次点击不触发移动。
      }
      this.moving = true;
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('mouseleave', () => { this.moving = false; });
    addEventListener('mouseup', (event) => {
      if (event.button !== 0) return;
      this.primaryDown = false;
      this.holdBlocked = false;
      this.moving = false;
    });
    addEventListener('mousemove', (event) => {
      this.trackPointer(event);
      /*
       * 按着不放的补漏：手指压着、光标已经在画布上、可就是没在走，那就开始走。
       *
       * 这一条专治"mousedown 被别人吃了"。弹出层（升级卡）、刚消失的按钮、浏览器自己的一些
       * 手势，都可能让画布收不到那一下按下，而玩家的手指明明还压着。只认 target 是画布本身，
       * 所以从 HUD 按钮上拖出来不会误触发。
       */
      if (this.active && this.primaryDown && !this.moving && !this.holdBlocked
        && event.target === this.canvas) {
        this.moving = true;
      }
    });
    addEventListener('blur', () => this.pause());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });
    addEventListener('resize', () => this.syncCursor());

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      camera.zoom(event.deltaY <= 0);
    }, { passive: false });

    addEventListener('keydown', (event) => {
      if (event.code === 'Escape') {
        event.preventDefault();
        if (!event.repeat) hooks.onEscape();
        return;
      }
      if (event.code === 'F1') {
        // 不拦的话浏览器会开一个帮助页，游戏当场失焦 —— 那等于按一下 F1 就掉出游戏。
        event.preventDefault();
        if (!event.repeat) hooks.onDebugMenu();
        return;
      }
      /*
       * 方向键要拦下来。**这一条不是可选的**：发布出去的游戏跑在 iframe 里（itch、
       * CrazyGames、Poki 都是），不拦的话按上下会去滚外层页面 —— 人在走，页面也在动。
       *
       * **只在真的在打的时候拦。** 备战、商店、战绩、结算那几屏是能滚的 DOM 面板，
       * 在那儿把方向键吃掉等于把键盘滚动也吃掉；而那时候方向键本来也不驱动任何人。
       */
      if (this.active && MOVE_CODES.has(event.code)) event.preventDefault();
      if (!this.keys.has(event.code)) hooks.onKey(event.code);
      this.keys.add(event.code);
      // 空格本身已经不干任何事（自动攻击是常态，不需要手动挥），但仍然要拦：不拦的话它会
      // 去按 HUD 上刚刚被点过、还留着焦点的那个按钮。
      if (event.code === 'Space') event.preventDefault();
    });
    addEventListener('keyup', (event) => this.keys.delete(event.code));
  }

  private trackPointer(event: MouseEvent): void {
    this.clientPosition = { x: event.clientX, y: event.clientY };
    this.syncCursor();
  }

  private syncCursor(): void {
    if (!this.clientPosition) return;
    const rect = this.canvas.getBoundingClientRect();
    this.placeCursor(
      (this.clientPosition.x - rect.left) / Math.max(1, rect.width) * this.camera.viewWidth,
      (this.clientPosition.y - rect.top) / Math.max(1, rect.height) * this.camera.viewHeight,
    );
  }

  /** 这个键这一帧按着没有。按住型的技能（疾走）靠它，见 main.ts 的 readInput。 */
  held(code: string): boolean {
    return this.keys.has(code);
  }

  /**
   * 疾走这一帧按着没有。**R 和 Shift 都算**，左右两个 Shift 也都算。
   *
   * R 是主键：它和 Q/W/E 排在同一行，手不用离开那一片就能跑。Shift 留着是因为"按住 Shift
   * 跑"是这一类游戏几十年的肌肉记忆，掰它没有任何好处 —— 一个动作有两个键不会让谁迷路，
   * 而少了任一个都会有人按不到。
   */
  get sprintHeld(): boolean {
    return this.keys.has('KeyR')
      || this.keys.has('ShiftLeft')
      || this.keys.has('ShiftRight');
  }

  /**
   * 这一帧方向键指着世界的哪个方向；一个键都没按就是 (0, 0)。返回的是复用的那一份，别长期
   * 持有。
   *
   * 世界的 +x 是屏幕右、+y 是屏幕下（见 Camera.worldToScreen），所以"上"是 -y。斜着按要
   * 归一化：不归一化的话对角线快出 41%，"斜着走"就成了唯一正确的走法。
   *
   * 对着按（左右一起压住）互相抵消，读作没按。比"后按的赢"简单，而且松开其中一个之后
   * 立刻回到另一个方向，手上不会空一帧。
   */
  keyboardMove(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('ArrowDown')) y += 1;
    if (this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, y);
    this.move.x = len > 0 ? x / len : 0;
    this.move.y = len > 0 ? y / len : 0;
    return this.move;
  }

  resume(): void {
    if (this.active || !this.hooks.canActivate()) return;
    this.moving = false;
    // 点回来的这一下按住不放也不许走，直到松手 —— 见 holdBlocked。
    this.holdBlocked = this.primaryDown;
    // 回来时键盘当成一个都没按。切出去时压着的那些键收不到 keyup，留着就是几个永远弹不
    // 起来的方向。
    this.keys.clear();
    this.syncCursor();
    this.active = true;
    this.hooks.onActiveChange(true);
  }

  pause(): void {
    this.moving = false;
    this.primaryDown = false;
    this.holdBlocked = false;
    this.keys.clear();
    if (!this.active) return;
    this.active = false;
    this.hooks.onActiveChange(false);
  }

  placeCursor(x: number, y: number): void {
    this.cursor.x = clamp(x, 0, this.camera.viewWidth);
    this.cursor.y = clamp(y, 0, this.camera.viewHeight);
  }

  /** 缓冲分辨率变化后，仍然对准真实鼠标当前的屏幕位置。 */
  resizeCursor(previousWidth: number, previousHeight: number): void {
    if (previousWidth <= 0 || previousHeight <= 0) return;
    if (previousWidth === this.camera.viewWidth && previousHeight === this.camera.viewHeight) return;
    if (this.clientPosition) {
      this.syncCursor();
    } else {
      this.placeCursor(
        this.cursor.x / previousWidth * this.camera.viewWidth,
        this.cursor.y / previousHeight * this.camera.viewHeight,
      );
    }
  }
}
