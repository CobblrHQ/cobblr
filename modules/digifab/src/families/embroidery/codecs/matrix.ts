/** Row-major 3x3 matrices applied to row vectors, as in pyembroidery. */
import { pyRound } from "./pyMath.js";

export type Matrix = [number,number,number,number,number,number,number,number,number];

export function getIdentity(): Matrix {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function getScale(sx: number, sy: number | null = null): Matrix {
  const y = sy === null ? sx : sy;
  return [sx, 0, 0, 0, y, 0, 0, 0, 1];
}

export function getTranslate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 0, 1, 0, tx, ty, 1];
}

export function getRotate(theta: number): Matrix {
  const tau = Math.PI * 2;
  theta *= tau / 360;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return [ct, st, 0, -st, ct, 0, 0, 0, 1];
}

export function matrixMultiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0]! * b[0]! + a[1]! * b[3]! + a[2]! * b[6]!,
    a[0]! * b[1]! + a[1]! * b[4]! + a[2]! * b[7]!,
    a[0]! * b[2]! + a[1]! * b[5]! + a[2]! * b[8]!,
    a[3]! * b[0]! + a[4]! * b[3]! + a[5]! * b[6]!,
    a[3]! * b[1]! + a[4]! * b[4]! + a[5]! * b[7]!,
    a[3]! * b[2]! + a[4]! * b[5]! + a[5]! * b[8]!,
    a[6]! * b[0]! + a[7]! * b[3]! + a[8]! * b[6]!,
    a[6]! * b[1]! + a[7]! * b[4]! + a[8]! * b[7]!,
    a[6]! * b[2]! + a[7]! * b[5]! + a[8]! * b[8]!,
  ];
}

/** Keeps a third element (the stitch command) when given one. */
export function pointInMatrixSpace(
  matrix: Matrix,
  v0: number | [number, number, ...unknown[]],
  v1?: number
): [number, number] | [number, number, unknown] {
  if (v1 === undefined) {
    const p = v0 as [number, number, ...unknown[]];
    const x = p[0]! * matrix[0]! + p[1]! * matrix[3]! + 1 * matrix[6]!;
    const y = p[0]! * matrix[1]! + p[1]! * matrix[4]! + 1 * matrix[7]!;
    if (p.length >= 3) return [x, y, p[2]!];
    return [x, y];
  }
  const a = v0 as number;
  return [
    a * matrix[0]! + v1 * matrix[3]! + 1 * matrix[6]!,
    a * matrix[1]! + v1 * matrix[4]! + 1 * matrix[7]!,
  ];
}

export function distanceSquared(x0: number, y0: number, x1: number, y1: number): number {
  let dx = x1 - x0;
  let dy = y1 - y0;
  dx *= dx;
  dy *= dy;
  return dx + dy;
}

export function distance(x0: number, y0: number, x1: number, y1: number): number {
  return Math.sqrt(distanceSquared(x0, y0, x1, y1));
}

export function towards(a: number, b: number, amount: number): number {
  return amount * (b - a) + a;
}

export function angleRadians(x0: number, y0: number, x1: number, y1: number): number {
  return Math.atan2(y1 - y0, x1 - x0);
}

export function oriented(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number
): [number, number] {
  const radians = angleRadians(x0, y0, x1, y1);
  return [x0 + r * Math.cos(radians), y0 + r * Math.sin(radians)];
}

export { pyRound };
