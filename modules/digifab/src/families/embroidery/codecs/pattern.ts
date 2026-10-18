/** Port of pyembroidery's EmbPattern. Stitches are absolute [x, y, command], in 0.1 mm. */
import { EmbConstant, type Command } from "./constants.js";
import { EmbThread } from "./thread.js";
import { pyRound } from "./pyMath.js";
import { Transcoder, type EncoderSettings } from "./encoder.js";

/** Value equality: PES v6 reads equal threads as separate objects. */
function sameThread(a: EmbThread, b: EmbThread): boolean {
  return (
    a === b ||
    ((a.color & 0xffffff) === (b.color & 0xffffff) &&
      a.description === b.description &&
      a.catalog_number === b.catalog_number &&
      a.details === b.details &&
      a.brand === b.brand &&
      a.chart === b.chart &&
      a.weight === b.weight)
  );
}

export type Stitch = [number, number, Command | number];

export type StitchBlock = [Stitch[], EmbThread];

export interface ThreadSpec {
  name?: string;
  description?: string;
  desc?: string;
  brand?: string;
  manufacturer?: string;
  color?: number | string | [number, number, number];
  rgb?: number | string | [number, number, number];
  hex?: string;
  id?: string;
  catalog?: string;
}

export interface Extents {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class EmbPattern {
  stitches: Stitch[] = [];
  threadlist: EmbThread[] = [];
  extras: Record<string | number, unknown> = {};
  _previousX = 0;
  _previousY = 0;

  move(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.JUMP, dx, dy);
  }

  moveAbs(x: number, y: number): void {
    this.addStitchAbsolute(EmbConstant.JUMP, x, y);
  }

  stitch(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.STITCH, dx, dy);
  }

  stitchAbs(x: number, y: number): void {
    this.addStitchAbsolute(EmbConstant.STITCH, x, y);
  }

  stop(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.STOP, dx, dy);
  }

  trim(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.TRIM, dx, dy);
  }

  colorChange(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.COLOR_CHANGE, dx, dy);
  }

  sequinEject(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.SEQUIN_EJECT, dx, dy);
  }

  sequinMode(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.SEQUIN_MODE, dx, dy);
  }

  end(dx = 0, dy = 0): void {
    this.addStitchRelative(EmbConstant.END, dx, dy);
  }

  addThread(thread: EmbThread | number | ThreadSpec): void {
    if (thread instanceof EmbThread) {
      this.threadlist.push(thread);
      return;
    }
    if (typeof thread === "number") {
      const threadObject = new EmbThread();
      threadObject.color = thread;
      this.threadlist.push(threadObject);
      return;
    }
    const spec = thread;
    const threadObject = new EmbThread();
    if (spec.name) threadObject.description = spec.name;
    if (spec.description) threadObject.description = spec.description;
    if (spec.desc) threadObject.description = spec.desc;
    if (spec.brand) threadObject.brand = spec.brand;
    if (spec.manufacturer) threadObject.brand = spec.manufacturer;
    const color = spec.color !== undefined ? spec.color : spec.rgb;
    if (color !== undefined) {
      if (typeof color === "number") {
        threadObject.color = color;
      } else if (typeof color === "string") {
        if (color === "random") {
          threadObject.color =
            (0xff000000 | Math.floor(Math.random() * 0x1000000)) >>> 0;
        }
        if (color[0]! === "#") threadObject.setHexColor(color.substring(1));
      } else if (Array.isArray(color)) {
        threadObject.color =
          ((color[0]! & 0xff) << 16) | ((color[1]! & 0xff) << 8) | (color[2]! & 0xff);
      }
    }
    if (spec.hex) threadObject.setHexColor(spec.hex);
    if (spec.id) threadObject.catalog_number = spec.id;
    if (spec.catalog) threadObject.catalog_number = spec.catalog;
    this.threadlist.push(threadObject);
  }

  metadata(name: string | number, data: unknown): void {
    this.extras[name] = data;
  }

  getMetadata<T = unknown>(name: string | number, fallback?: T): T | undefined {
    return this.extras[name]! !== undefined
      ? (this.extras[name]! as T)
      : fallback;
  }

  addStitchAbsolute(cmd: Command | number, x = 0, y = 0): void {
    this.stitches.push([x, y, cmd]);
    this._previousX = x;
    this._previousY = y;
  }

  addStitchRelative(cmd: Command | number, dx = 0, dy = 0): void {
    const x = this._previousX + dx;
    const y = this._previousY + dy;
    this.addStitchAbsolute(cmd, x, y);
  }

  /** Appends without moving the relative-position cursor. */
  addCommand(cmd: Command | number, x = 0, y = 0): void {
    this.stitches.push([x, y, cmd]);
  }

  /** Inserts a command relative to the stitch before `position`. */
  insertStitchRelative(position: number, cmd: Command | number, dx = 0, dy = 0): void {
    if (position < 0) position += this.stitches.length;
    if (position === 0) {
      this.stitches.unshift([dx, dy, cmd]);
    } else if (position === this.stitches.length) {
      this.addStitchRelative(cmd, dx, dy);
    } else if (position > 0 && position < this.stitches.length) {
      const [x, y] = this.stitches[position - 1]!;
      this.stitches.splice(position, 0, [x + dx, y + dy, cmd]);
    }
  }

  addStitchblock(stitchblock: StitchBlock): void {
    const threadlist = this.threadlist;
    const block = stitchblock[0]!;
    const thread = stitchblock[1]!;
    if (threadlist.length === 0 || thread !== threadlist[threadlist.length - 1]!) {
      threadlist.push(thread);
      this.addStitchRelative(EmbConstant.COLOR_BREAK);
    } else {
      this.addStitchRelative(EmbConstant.SEQUENCE_BREAK);
    }
    for (const stitch of block) {
      this.addStitchAbsolute(stitch[2]!, stitch[0]!, stitch[1]!);
    }
  }

  extents(): Extents {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stitch of this.stitches) {
      if (stitch[0]! > maxX) maxX = stitch[0]!;
      if (stitch[0]! < minX) minX = stitch[0]!;
      if (stitch[1]! > maxY) maxY = stitch[1]!;
      if (stitch[1]! < minY) minY = stitch[1]!;
    }
    return { minX, minY, maxX, maxY };
  }

  extends = this.extents;

  countStitchCommands(command: Command | number): number {
    let count = 0;
    for (const stitch of this.stitches) {
      if (stitch[2]! === command) count += 1;
    }
    return count;
  }

  countColorChanges(): number {
    return this.countStitchCommands(EmbConstant.COLOR_CHANGE);
  }

  countStitches(): number {
    return this.stitches.length;
  }

  countThreads(): number {
    return this.threadlist.length;
  }

  static getRandomThread(): EmbThread {
    const thread = new EmbThread();
    thread.color = (0xff000000 | Math.floor(Math.random() * 0x1000000)) >>> 0;
    thread.description = "Random";
    return thread;
  }

  /** Missing threads get a fresh black filler (pyembroidery uses a random color). */
  getThreadOrFiller(index: number): EmbThread {
    if (this.threadlist.length <= index) return EmbPattern.getFillerThread();
    return this.threadlist[index]!;
  }

  private static getFillerThread(): EmbThread {
    const thread = new EmbThread();
    thread.setColor(0, 0, 0);
    thread.description = "Filler";
    return thread;
  }

  *getAsStitchblock(): Generator<StitchBlock> {
    let stitchblock: Stitch[] = [];
    let thread = this.getThreadOrFiller(0);
    let threadIndex = 1;
    for (const stitch of this.stitches) {
      const flags = stitch[2]!;
      if (flags === EmbConstant.STITCH) {
        stitchblock.push(stitch);
      } else {
        if (stitchblock.length > 0) {
          yield [stitchblock, thread];
          stitchblock = [];
        }
        if (flags === EmbConstant.COLOR_CHANGE) {
          thread = this.getThreadOrFiller(threadIndex);
          threadIndex += 1;
        }
      }
    }
    if (stitchblock.length > 0) yield [stitchblock, thread];
  }

  *getAsCommandBlocks(): Generator<Stitch[]> {
    let lastPos = 0;
    let lastCommand: Command | number = EmbConstant.NO_COMMAND;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      const stitch = this.stitches[pos]!;
      const command = stitch[2]!;
      if (command === lastCommand || lastCommand === EmbConstant.NO_COMMAND) {
        lastCommand = command;
        continue;
      }
      lastCommand = command;
      yield this.stitches.slice(lastPos, pos);
      lastPos = pos;
    }
    yield this.stitches.slice(lastPos);
  }

  *getAsColorblocks(): Generator<[Stitch[], EmbThread]> {
    let threadIndex = 0;
    let lastPos = 0;
    let thread: EmbThread;
    for (let pos = 0; pos < this.stitches.length; pos++) {
      if (this.stitches[pos]![2]! !== EmbConstant.COLOR_CHANGE) continue;
      thread = this.getThreadOrFiller(threadIndex);
      threadIndex += 1;
      yield [this.stitches.slice(lastPos, pos), thread];
      lastPos = pos;
    }
    thread = this.getThreadOrFiller(threadIndex);
    yield [this.stitches.slice(lastPos), thread];
  }

  getUniqueThreadlist(): EmbThread[] {
    return [...new Set(this.threadlist)];
  }

  getSingletonThreadlist(): EmbThread[] {
    const singleton: EmbThread[] = [];
    let lastThread: EmbThread | null = null;
    for (const thread of this.threadlist) {
      if (thread !== lastThread) singleton.push(thread);
      lastThread = thread;
    }
    return singleton;
  }

  moveCenterToOrigin(): void {
    const extents = this.extents();
    const cx = pyRound((extents.maxX + extents.minX) / 2);
    const cy = pyRound((extents.maxY + extents.minY) / 2);
    this.translate(-cx, -cy);
  }

  translate(dx: number, dy: number): void {
    for (const stitch of this.stitches) {
      stitch[0]! += dx;
      stitch[1]! += dy;
    }
  }

  fixColorCount(): void {
    let threadIndex = 0;
    let initColor = true;
    for (const stitch of this.stitches) {
      const data = stitch[2]! & EmbConstant.COMMAND_MASK;
      if (
        data === EmbConstant.STITCH ||
        data === EmbConstant.SEW_TO ||
        data === EmbConstant.NEEDLE_AT
      ) {
        if (initColor) {
          threadIndex += 1;
          initColor = false;
        }
      } else if (data === EmbConstant.COLOR_CHANGE || data === EmbConstant.COLOR_BREAK) {
        initColor = true;
      }
    }
    while (this.threadlist.length < threadIndex) {
      this.addThread(this.getThreadOrFiller(this.threadlist.length));
    }
  }

  /**
   * Adds a TRIM before runs of `jumpsToRequireTrim` jumps, or of jumps going further than
   * `distanceToRequireTrim`, and drops runs of jumps that end where they started (with `clipping`).
   * Formats without a trim command (like DST) encode trims this way.
   */
  interpolateTrims(
    jumpsToRequireTrim: number | null = null,
    distanceToRequireTrim: number | null = null,
    clipping = true
  ): void {
    let i = -1;
    let ie = this.stitches.length - 1;
    let x = 0;
    let y = 0;
    let jumpCount = 0;
    let jumpStart = 0;
    let jumpDx = 0;
    let jumpDy = 0;
    let jumping = false;
    let trimmed = true;
    while (i < ie) {
      i += 1;
      const stitch = this.stitches[i]!;
      const dx = stitch[0]! - x;
      const dy = stitch[1]! - y;
      [x, y] = stitch;
      const command = stitch[2]! & EmbConstant.COMMAND_MASK;
      if (command === EmbConstant.STITCH || command === EmbConstant.SEQUIN_EJECT) {
        trimmed = false;
        jumping = false;
      } else if (command === EmbConstant.COLOR_CHANGE || command === EmbConstant.TRIM) {
        trimmed = true;
        jumping = false;
      }
      if (command !== EmbConstant.JUMP) continue;
      if (!jumping) {
        [jumpDx, jumpDy, jumpCount, jumpStart] = [0, 0, 0, i];
        jumping = true;
      }
      jumpCount += 1;
      jumpDx += dx;
      jumpDy += dy;
      if (
        !trimmed &&
        (jumpCount === jumpsToRequireTrim ||
          (distanceToRequireTrim !== null &&
            (Math.abs(jumpDy) > distanceToRequireTrim || Math.abs(jumpDx) > distanceToRequireTrim)))
      ) {
        this.insertStitchRelative(jumpStart, EmbConstant.TRIM);
        jumpStart += 1;
        i += 1;
        ie += 1;
        trimmed = true;
      }
      if (clipping && jumpDx === 0 && jumpDy === 0) {
        // The jumps went nowhere: drop them, keeping any trim added before them.
        this.stitches.splice(jumpStart, i + 1 - jumpStart);
        i = jumpStart - 1;
        ie = this.stitches.length - 1;
      }
    }
  }

  convertJumpsToTrim(jumpsToRequireTrim = 3): void {
    const tempPattern = new EmbPattern();
    let i = -1;
    const ie = this.stitches.length - 1;
    let count = 0;
    let trimmed = true;
    while (i < ie) {
      i += 1;
      let stitch = this.stitches[i]!;
      let command = stitch[2]!;
      if (command === EmbConstant.STITCH || command === EmbConstant.SEQUIN_EJECT) {
        trimmed = false;
      } else if (command === EmbConstant.COLOR_CHANGE || command === EmbConstant.TRIM) {
        trimmed = true;
      }
      if (trimmed || stitch[2]! !== EmbConstant.JUMP) {
        tempPattern.addStitchAbsolute(stitch[2]!, stitch[0]!, stitch[1]!);
        continue;
      }
      while (i < ie && command === EmbConstant.JUMP) {
        i += 1;
        stitch = this.stitches[i]!;
        command = stitch[2]!;
        count += 1;
      }
      if (command !== EmbConstant.JUMP) {
        i -= 1;
      }
      stitch = this.stitches[i]!;
      if (count >= jumpsToRequireTrim) {
        tempPattern.trim();
      }
      count = 0;
      tempPattern.addStitchAbsolute(stitch[2]!, stitch[0]!, stitch[1]!);
    }
    this.stitches = tempPattern.stitches;
  }

  convertDuplicateColorChangeToStop(): void {
    const newPattern = new EmbPattern();
    newPattern.addThread(this.getThreadOrFiller(0));

    let threadIndex = 0;
    for (const [x, y, command] of this.stitches) {
      if (
        command === EmbConstant.COLOR_CHANGE ||
        command === EmbConstant.COLOR_BREAK
      ) {
        threadIndex += 1;
        const thread = this.getThreadOrFiller(threadIndex);
        const last =
          newPattern.threadlist[newPattern.threadlist.length - 1]!;
        if (sameThread(thread, last)) {
          newPattern.stop();
        } else {
          newPattern.colorChange();
          newPattern.addThread(thread);
        }
      } else {
        newPattern.addStitchAbsolute(command, x, y);
      }
    }

    this.stitches = newPattern.stitches;
    this.threadlist = newPattern.threadlist;
  }

  convertStopToColorChange(): void {
    const newPattern = new EmbPattern();
    newPattern.addThread(this.getThreadOrFiller(0));
    let threadIndex = 1;

    for (const [x, y, command] of this.stitches) {
      if (command === EmbConstant.COLOR_CHANGE || command === EmbConstant.COLOR_BREAK) {
        newPattern.addThread(this.getThreadOrFiller(threadIndex));
        newPattern.addStitchAbsolute(command, x, y);
        threadIndex += 1;
      } else if (command === EmbConstant.STOP) {
        newPattern.colorChange();
        newPattern.addThread(this.getThreadOrFiller(threadIndex));
      } else {
        newPattern.addStitchAbsolute(command, x, y);
      }
    }

    this.stitches = newPattern.stitches;
    this.threadlist = newPattern.threadlist;
  }

  getPatternMergeJumps(): EmbPattern {
    const newPattern = new EmbPattern();
    let i = -1;
    const ie = this.stitches.length - 1;
    let stitchBreak = false;
    while (i < ie) {
      i += 1;
      const stitch = this.stitches[i]!;
      if (stitch[2]! === EmbConstant.JUMP) {
        if (stitchBreak) continue;
        newPattern.addCommand(EmbConstant.STITCH_BREAK);
        stitchBreak = true;
        continue;
      }
      newPattern.addStitchAbsolute(stitch[2]!, stitch[0]!, stitch[1]!);
    }
    newPattern.threadlist.push(...this.threadlist);
    Object.assign(newPattern.extras, this.extras);
    return newPattern;
  }

  getStablePattern(): EmbPattern {
    const stablePattern = new EmbPattern();
    for (const stitchblock of this.getAsStitchblock()) {
      stablePattern.addStitchblock(stitchblock);
    }
    Object.assign(stablePattern.extras, this.extras);
    return stablePattern;
  }

  getNormalizedPattern(encodeSettings?: EncoderSettings): EmbPattern {
    const normalPattern = new EmbPattern();
    const transcoder = new Transcoder(encodeSettings);
    transcoder.transcode(this, normalPattern);
    return normalPattern;
  }

  appendTranslation(x: number, y: number): void {
    this.addStitchRelative(EmbConstant.MATRIX_TRANSLATE, x, y);
  }

  appendEnableTieOn(x = 0, y = 0): void {
    this.addStitchRelative(EmbConstant.OPTION_ENABLE_TIE_ON, x, y);
  }

  appendEnableTieOff(x = 0, y = 0): void {
    this.addStitchRelative(EmbConstant.OPTION_ENABLE_TIE_OFF, x, y);
  }

  appendDisableTieOn(x = 0, y = 0): void {
    this.addStitchRelative(EmbConstant.OPTION_DISABLE_TIE_ON, x, y);
  }

  appendDisableTieOff(x = 0, y = 0): void {
    this.addStitchRelative(EmbConstant.OPTION_DISABLE_TIE_OFF, x, y);
  }
}
