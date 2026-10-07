import { EmbConstant, type Command } from "./constants.js";
import { pyRound } from "./pyMath.js";
import type { EmbPattern, Stitch } from "./pattern.js";
import {
  getIdentity,
  getScale,
  getTranslate,
  getRotate,
  matrixMultiply,
  pointInMatrixSpace,
  distance,
  towards,
  oriented,
  type Matrix,
} from "./matrix.js";

const {
  NO_COMMAND,
  STITCH,
  JUMP,
  TRIM,
  STOP,
  END,
  COLOR_CHANGE,
  SEQUIN_MODE,
  SEQUIN_EJECT,
  SLOW,
  FAST,
  SEW_TO,
  NEEDLE_AT,
  STITCH_BREAK,
  SEQUENCE_BREAK,
  COLOR_BREAK,
  TIE_OFF,
  TIE_ON,
  FRAME_EJECT,
  MATRIX_TRANSLATE,
  MATRIX_SCALE,
  MATRIX_ROTATE,
  MATRIX_RESET,
  OPTION_ENABLE_TIE_ON,
  OPTION_ENABLE_TIE_OFF,
  OPTION_DISABLE_TIE_ON,
  OPTION_DISABLE_TIE_OFF,
  OPTION_MAX_STITCH_LENGTH,
  OPTION_MAX_JUMP_LENGTH,
  OPTION_EXPLICIT_TRIM,
  OPTION_IMPLICIT_TRIM,
  CONTINGENCY_NONE,
  CONTINGENCY_JUMP_NEEDLE,
  CONTINGENCY_SEW_TO,
  CONTINGENCY_SEQUIN_UTILIZE,
  CONTINGENCY_SEQUIN_JUMP,
  CONTINGENCY_SEQUIN_STITCH,
  CONTINGENCY_SEQUIN_REMOVE,
} = EmbConstant;

/** A point as `[x, y]` or `{ x, y }`. */
export type PointLike = [number, ...number[]] | { x: number; y: number };

/** Options of the stitch encoder (pyembroidery's names). Lengths in 0.1 mm. */
export interface EncoderSettings {
  /** Longer stitches are split. */
  max_stitch?: number;
  /** Longer jumps are split. */
  max_jump?: number;
  /** Always jump all the way to the next block's start. */
  full_jump?: boolean;
  /** Round positions to whole units before encoding. */
  round?: boolean;
  strip_sequins?: boolean;
  /** An `EmbConstant.CONTINGENCY_SEQUIN_*` value. */
  sequin_contingency?: number;
  /** Drop SLOW/FAST commands. Default true. */
  strip_speeds?: boolean;
  /** Trim before color changes. Default true. */
  explicit_trim?: boolean;
  /** Add lock stitches at the start of each block. */
  tie_on?: boolean;
  /** Add lock stitches at the end of each block. */
  tie_off?: boolean;
  /** An `EmbConstant.CONTINGENCY_*` value for stitches longer than `max_stitch`. */
  long_stitch_contingency?: number;
  translate?: PointLike;
  /** A factor, or separate x and y factors. */
  scale?: number | PointLike;
  /** Degrees. */
  rotate?: number;
}

/** Commands that end a run of stitches; a tie-off doesn't look past them. */
const BREAKS = new Set<number>([JUMP, TRIM, STOP, END, COLOR_CHANGE, STITCH_BREAK, SEQUENCE_BREAK, COLOR_BREAK, FRAME_EJECT]);

export class Transcoder {
  maxStitch: number;
  maxJump: number;
  fullJump: boolean;
  round: boolean;
  sequinContingency: number;
  stripSpeeds: boolean;
  explicitTrim: boolean;
  hasTieOn: boolean;
  hasTieOff: boolean;
  longStitchContingency: number;
  matrix: Matrix;
  sourcePattern: EmbPattern | null = null;
  destinationPattern: EmbPattern | null = null;
  position = 0;
  colorIndex = -1;
  stitch: Stitch | null = null;
  stateTrimmed = true;
  stateSequinMode = false;
  needleX = 0;
  needleY = 0;
  stateJumping = false;

  constructor(settings: EncoderSettings = {}) {
    this.maxStitch = settings.max_stitch ?? Infinity;
    this.maxJump = settings.max_jump ?? Infinity;
    this.fullJump = settings.full_jump ?? false;
    this.round = settings.round ?? false;
    const stripSequins = settings.strip_sequins ?? true;
    let sequinContingency: number = stripSequins
      ? CONTINGENCY_SEQUIN_UTILIZE
      : CONTINGENCY_SEQUIN_JUMP;
    sequinContingency = settings.sequin_contingency ?? sequinContingency;
    this.sequinContingency = sequinContingency;

    this.stripSpeeds = settings.strip_speeds ?? true;
    this.explicitTrim = settings.explicit_trim ?? true;

    this.hasTieOn = settings.tie_on ?? false;
    this.hasTieOff = settings.tie_off ?? false;
    this.longStitchContingency =
      settings.long_stitch_contingency ?? CONTINGENCY_JUMP_NEEDLE;

    this.matrix = getIdentity();
    const translate = settings.translate;
    if (translate !== null && translate !== undefined) {
      this.applyTranslate(translate);
    }
    const scale = settings.scale;
    if (scale !== null && scale !== undefined) {
      this.applyScale(scale);
    }
    const rotate = settings.rotate;
    if (rotate !== null && rotate !== undefined) {
      if (typeof rotate !== "number") {
        throw new TypeError("rotate must be a number of degrees");
      }
      this.matrix = matrixMultiply(this.matrix, getRotate(rotate));
    }
  }

  private applyTranslate(translate: unknown): void {
    if (Array.isArray(translate)) {
      if (translate.length >= 2) {
        this.matrix = matrixMultiply(
          this.matrix,
          getTranslate(translate[0]!, translate[1]!)
        );
        return;
      }
      const point = translate as unknown as { x?: unknown; y?: unknown };
      if (typeof point.x === "number" && typeof point.y === "number") {
        this.matrix = matrixMultiply(
          this.matrix,
          getTranslate(point.x, point.y)
        );
      }
      return;
    }
    if (typeof translate === "object") {
      const point = translate as { x?: unknown; y?: unknown };
      if (typeof point.x === "number" && typeof point.y === "number") {
        this.matrix = matrixMultiply(
          this.matrix,
          getTranslate(point.x, point.y)
        );
      }
      return;
    }
    throw new TypeError(
      "translate must be [x, y] or {x, y} (python raises TypeError for scalars here)"
    );
  }

  private applyScale(scale: unknown): void {
    if (typeof scale === "number") {
      this.matrix = matrixMultiply(this.matrix, getScale(scale, scale));
      return;
    }
    if (Array.isArray(scale)) {
      if (scale.length >= 2) {
        this.matrix = matrixMultiply(
          this.matrix,
          getScale(scale[0]!, scale[1]!)
        );
        return;
      }
      throw new TypeError("scale: cannot build a matrix from a short array");
    }
    if (typeof scale === "object") {
      const point = scale as { x?: unknown; y?: unknown };
      if (typeof point.x === "number" && typeof point.y === "number") {
        this.matrix = matrixMultiply(this.matrix, getScale(point.x, point.y));
        return;
      }
      throw new TypeError("scale: cannot build a matrix from this value");
    }
    throw new TypeError("scale: cannot build a matrix from this value");
  }

  transcode(sourcePattern: EmbPattern, destinationPattern: EmbPattern): EmbPattern {
    this.sourcePattern = sourcePattern;
    this.destinationPattern = destinationPattern;
    this.transcodeMetadata();
    this.transcodeThreads();
    this.transcodeStitches();
    return destinationPattern;
  }

  transcodeMetadata(): void {
    const source = this.sourcePattern!.extras;
    const dest = this.destinationPattern!.extras;
    Object.assign(dest, source);
  }

  transcodeThreads(): void {
    const source = this.sourcePattern!.threadlist;
    const dest = this.destinationPattern!.threadlist;
    dest.push(...source);
  }

  transcodeStitches(): void {
    const source = this.sourcePattern!.stitches;
    this.stateTrimmed = true;
    this.needleX = 0;
    this.needleY = 0;
    this.position = 0;
    this.colorIndex = -1;

    let flags: Command | number = NO_COMMAND;
    for (const [index, stitch] of source.entries()) {
      this.position = index;
      this.stitch = stitch;
      const p = pointInMatrixSpace(this.matrix, stitch);
      const x = this.round ? pyRound(p[0]!) : p[0]!;
      const y = this.round ? pyRound(p[1]!) : p[1]!;
      // x/y are transformed; flags and option values come from the raw stitch.
      flags = stitch[2]!;

      if (flags === NO_COMMAND) {
        continue;
      } else if (flags === STITCH) {
        if (this.stateTrimmed) {
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          if (this.hasTieOn) this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.stitchWithContingency(x, y);
        }
      } else if (flags === NEEDLE_AT) {
        if (this.stateTrimmed) {
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          if (this.hasTieOn) this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.needleTo(x, y);
        }
      } else if (flags === SEW_TO) {
        if (this.stateTrimmed) {
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          if (this.hasTieOn) this.tieOn();
        } else if (this.stateJumping) {
          this.needleTo(x, y);
          this.stateJumping = false;
        } else {
          this.sewTo(x, y);
        }
      } else if (flags === STITCH_BREAK) {
        this.stateJumping = true;
      } else if (flags === FRAME_EJECT) {
        this.tieOffAndTrimIfNeeded();
        this.jumpTo(x, y);
        this.stopHere();
      } else if (flags === SEQUENCE_BREAK) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === COLOR_BREAK) {
        this.colorBreak();
      } else if (flags === TIE_OFF) {
        this.tieOff();
      } else if (flags === TIE_ON) {
        this.tieOn();
      } else if (flags === TRIM) {
        this.tieOffAndTrimIfNeeded();
      } else if (flags === JUMP) {
        if (!this.stateJumping) {
          this.jumpTo(x, y);
        }
      } else if (flags === SEQUIN_MODE) {
        this.toggleSequins();
      } else if (flags === SEQUIN_EJECT) {
        if (this.stateTrimmed) {
          this.jumpToWithinStitchrange(x, y);
          this.stitchAt(x, y);
          if (this.hasTieOn) this.tieOn();
        }
        if (!this.stateSequinMode) this.toggleSequins();
        this.sequinAt(x, y);
      } else if (flags === COLOR_CHANGE) {
        this.tieOffTrimColorChange();
      } else if (flags === STOP) {
        this.stopHere();
      } else if (flags === SLOW) {
        this.slowCommandHere();
      } else if (flags === FAST) {
        this.fastCommandHere();
      } else if (flags === END) {
        this.endHere();
        break;
      } else if (flags === OPTION_ENABLE_TIE_ON) {
        this.hasTieOn = true;
      } else if (flags === OPTION_ENABLE_TIE_OFF) {
        this.hasTieOff = true;
      } else if (flags === OPTION_DISABLE_TIE_ON) {
        this.hasTieOn = false;
      } else if (flags === OPTION_DISABLE_TIE_OFF) {
        this.hasTieOff = false;
      } else if (flags === OPTION_MAX_JUMP_LENGTH) {
        this.maxJump = stitch[0]!;
      } else if (flags === OPTION_MAX_STITCH_LENGTH) {
        this.maxStitch = stitch[0]!;
      } else if (flags === OPTION_EXPLICIT_TRIM) {
        this.explicitTrim = true;
      } else if (flags === OPTION_IMPLICIT_TRIM) {
        this.explicitTrim = false;
      } else if (flags === CONTINGENCY_NONE) {
        this.longStitchContingency = CONTINGENCY_NONE;
      } else if (flags === CONTINGENCY_JUMP_NEEDLE) {
        this.longStitchContingency = CONTINGENCY_JUMP_NEEDLE;
      } else if (flags === CONTINGENCY_SEW_TO) {
        this.longStitchContingency = CONTINGENCY_SEW_TO;
      } else if (flags === CONTINGENCY_SEQUIN_REMOVE) {
        if (this.stateSequinMode) this.toggleSequins();
        this.sequinContingency = CONTINGENCY_SEQUIN_REMOVE;
      } else if (flags === CONTINGENCY_SEQUIN_STITCH) {
        if (this.stateSequinMode) this.toggleSequins();
        this.sequinContingency = CONTINGENCY_SEQUIN_STITCH;
      } else if (flags === CONTINGENCY_SEQUIN_JUMP) {
        if (this.stateSequinMode) this.toggleSequins();
        // pyembroidery sets SEQUIN_REMOVE here, a copy-paste bug.
        this.sequinContingency = CONTINGENCY_SEQUIN_JUMP;
      } else if (flags === CONTINGENCY_SEQUIN_UTILIZE) {
        this.sequinContingency = CONTINGENCY_SEQUIN_UTILIZE;
      } else if (flags === MATRIX_TRANSLATE) {
        this.matrix = matrixMultiply(
          this.matrix,
          getTranslate(stitch[0]!, stitch[1]!)
        );
      } else if (flags === MATRIX_SCALE) {
        this.matrix = matrixMultiply(
          this.matrix,
          getScale(stitch[0]!, stitch[1]!)
        );
      } else if (flags === MATRIX_ROTATE) {
        this.matrix = matrixMultiply(
          this.matrix,
          getRotate(stitch[0]!)
        );
      } else if (flags === MATRIX_RESET) {
        this.matrix = getIdentity();
      }
    }
    if (flags !== END) {
      this.endHere();
    }
  }

  updateNeedlePosition(x: number, y: number): void {
    this.needleX = x;
    this.needleY = y;
  }

  declareNotTrimmed(): void {
    if (this.stateTrimmed) {
      this.stateTrimmed = false;
      if (this.colorIndex === -1) {
        this.colorIndex = 0;
      }
    }
  }

  add(flags: Command | number, x: number | null = null, y: number | null = null): void {
    const ax = x === null ? this.needleX : x;
    const ay = y === null ? this.needleY : y;
    this.destinationPattern!.stitches.push([ax, ay, flags]);
  }

  lookaheadStitch(): boolean {
    const source = this.sourcePattern!.stitches;
    for (let pos = this.position; pos < source.length; pos++) {
      const flags = source[pos]![2]!;
      if (
        flags === STITCH ||
        flags === NEEDLE_AT ||
        flags === SEW_TO ||
        flags === TIE_ON ||
        flags === SEQUIN_EJECT
      ) {
        return true;
      } else if (flags === END) {
        return false;
      }
    }
    return false;
  }

  colorBreak(): void {
    if (this.colorIndex < 0) {
      return;
    }
    if (!this.stateTrimmed) {
      if (this.hasTieOff) this.tieOff();
      if (this.explicitTrim) this.trimHere();
    }
    if (!this.lookaheadStitch()) {
      return;
    }
    this.add(COLOR_CHANGE);
    this.colorIndex += 1;
    this.stateTrimmed = true;
  }

  tieOffTrimColorChange(): void {
    if (!this.stateTrimmed) {
      if (this.hasTieOff) this.tieOff();
      if (this.explicitTrim) this.trimHere();
    }
    this.add(COLOR_CHANGE);
    this.colorIndex += 1;
    this.stateTrimmed = true;
  }

  tieOffAndTrimIfNeeded(): void {
    if (!this.stateTrimmed) {
      this.tieOffAndTrim();
    }
  }

  tieOffAndTrim(): void {
    if (this.hasTieOff) this.tieOff();
    this.trimHere();
  }

  tieOff(): void {
    const source = this.sourcePattern!.stitches;
    // pyembroidery anchors on the stitch just before, which is usually where the needle already is,
    // so its lock stitches don't move. Anchor on the last stitch away from the needle instead.
    // Position 0 wraps to the last stitch, like Python's stitches[-1].
    for (let offset = 1; offset <= source.length; offset += 1) {
      let index = this.position - offset;
      if (index < 0) index += source.length;
      const b = pointInMatrixSpace(this.matrix, source[index]!);
      const flags = b[2]! as Command | number;
      if (flags === STITCH || flags === NEEDLE_AT || flags === SEW_TO || flags === SEQUIN_EJECT) {
        if (b[0]! !== this.needleX || b[1]! !== this.needleY) {
          this.lockStitch(this.needleX, this.needleY, b[0]!, b[1]!, this.maxStitch);
          return;
        }
      } else if (BREAKS.has(flags)) {
        return;
      }
    }
  }

  tieOn(): void {
    const source = this.sourcePattern!.stitches;
    const next = source[this.position + 1]!;
    if (next === undefined) {
      return;
    }
    const b = pointInMatrixSpace(this.matrix, next);
    const flags = b[2]! as Command | number;
    if (
      flags === STITCH ||
      flags === NEEDLE_AT ||
      flags === SEW_TO ||
      flags === SEQUIN_EJECT
    ) {
      this.lockStitch(this.needleX, this.needleY, b[0]!, b[1]!, this.maxStitch);
    }
  }

  trimHere(): void {
    if (this.stateSequinMode) {
      this.toggleSequins();
    }
    this.add(TRIM);
    this.stateTrimmed = true;
  }

  toggleSequins(): void {
    const contingency = this.sequinContingency;
    if (contingency === CONTINGENCY_SEQUIN_UTILIZE) {
      this.add(SEQUIN_MODE);
      this.stateSequinMode = !this.stateSequinMode;
    }
  }

  jumpToWithinStitchrange(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxJump;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    if (this.fullJump) {
      if (this.needleX !== newX || this.needleY !== newY) {
        this.jumpAt(newX, newY);
      }
    }
  }

  jumpTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxJump;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    this.jumpAt(newX, newY);
  }

  jumpAt(newX: number, newY: number): void {
    if (this.stateSequinMode) {
      this.toggleSequins();
    }
    this.add(JUMP, newX, newY);
    this.updateNeedlePosition(newX, newY);
  }

  stitchWithContingency(newX: number, newY: number): void {
    if (this.longStitchContingency === CONTINGENCY_SEW_TO) {
      this.sewTo(newX, newY);
    } else if (this.longStitchContingency === CONTINGENCY_JUMP_NEEDLE) {
      this.needleTo(newX, newY);
    } else {
      this.stitchAt(newX, newY);
    }
  }

  sewTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxStitch;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, STITCH);
    this.stitchAt(newX, newY);
  }

  needleTo(newX: number, newY: number): void {
    const x0 = this.needleX;
    const y0 = this.needleY;
    const maxLength = this.maxStitch;
    this.interpolateGapStitches(x0, y0, newX, newY, maxLength, JUMP);
    this.stitchAt(newX, newY);
  }

  stitchAt(newX: number, newY: number): void {
    this.add(STITCH, newX, newY);
    this.updateNeedlePosition(newX, newY);
    this.declareNotTrimmed();
  }

  sequinAt(newX: number, newY: number): void {
    const contingency = this.sequinContingency;
    if (contingency === CONTINGENCY_SEQUIN_UTILIZE) {
      this.add(SEQUIN_EJECT, newX, newY);
    } else if (contingency === CONTINGENCY_SEQUIN_JUMP) {
      this.add(JUMP, newX, newY);
    } else if (contingency === CONTINGENCY_SEQUIN_STITCH) {
      this.add(STITCH, newX, newY);
    } else if (contingency === CONTINGENCY_SEQUIN_REMOVE) {
      return;
    }
    this.updateNeedlePosition(newX, newY);
    this.declareNotTrimmed();
  }

  slowCommandHere(): void {
    if (!this.stripSpeeds) {
      this.add(SLOW);
    }
  }

  fastCommandHere(): void {
    if (!this.stripSpeeds) {
      this.add(FAST);
    }
  }

  stopHere(): void {
    this.add(STOP);
    this.stateTrimmed = true;
  }

  endHere(): void {
    this.add(END);
    this.stateTrimmed = true;
  }

  colorChangeHere(): void {
    this.add(COLOR_CHANGE);
    this.colorIndex += 1;
    this.stateTrimmed = true;
  }

  positionWillExceedConstraint(
    length: number | null = null,
    newX: number | null = null,
    newY: number | null = null
  ): boolean {
    const limit = length === null ? this.maxStitch : length;
    if (newX === null || newY === null) {
      const stitch = this.stitch!;
      const p = pointInMatrixSpace(this.matrix, stitch[0]!, stitch[1]!);
      newX = p[0]! as number;
      newY = p[1]! as number;
    }
    const distanceX = newX - this.needleX;
    const distanceY = newY - this.needleY;
    return Math.abs(distanceX) > limit || Math.abs(distanceY) > limit;
  }

  interpolateGapStitches(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    maxLength: number,
    data: Command | number
  ): void {
    const transcode = this.destinationPattern!.stitches;
    const distanceX = x1 - x0;
    const distanceY = y1 - y0;
    if (Math.abs(distanceX) > maxLength || Math.abs(distanceY) > maxLength) {
      if (data === JUMP && this.stateSequinMode) {
        this.toggleSequins();
      }

      const stepsX = Math.ceil(Math.abs(distanceX / (maxLength * 1.0)));
      const stepsY = Math.ceil(Math.abs(distanceY / (maxLength * 1.0)));
      const steps = stepsX > stepsY ? stepsX : stepsY;
      const stepSizeX = distanceX / steps;
      const stepSizeY = distanceY / steps;
      let qx = x0;
      let qy = y0;
      for (let q = 1; q < steps; q++) {
        qx += stepSizeX;
        qy += stepSizeY;
        const stitch: Stitch = [qx, qy, data];
        transcode.push(stitch);
        this.updateNeedlePosition(stitch[0]!, stitch[1]!);
      }
    }
  }

  lockStitch(
    x: number,
    y: number,
    anchorX: number,
    anchorY: number,
    maxLength: number | null = null
  ): void {
    const limit = maxLength === null ? this.maxStitch : maxLength;
    const transcode = this.destinationPattern!.stitches;
    let length = distance(x, y, anchorX, anchorY);
    if (length > limit) {
      const p = oriented(x, y, anchorX, anchorY, limit);
      anchorX = p[0]!;
      anchorY = p[1]!;
    }
    for (const amount of [0.33, 0.66, 0.33, 0]) {
      transcode.push([
        towards(x, anchorX, amount),
        towards(y, anchorY, amount),
        STITCH,
      ]);
    }
  }
}
