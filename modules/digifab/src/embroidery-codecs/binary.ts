const WHENCE_SET = 0;
const WHENCE_CUR = 1;
const WHENCE_END = 2;

export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get length(): number {
    return this.data.length;
  }

  tell(): number {
    return this.offset;
  }

  seek(offset: number, whence: number = WHENCE_SET): void {
    if (whence === WHENCE_CUR) {
      this.offset += offset;
    } else if (whence === WHENCE_END) {
      this.offset = this.data.length + offset;
    } else {
      this.offset = offset;
    }
    if (!Number.isInteger(this.offset) || this.offset < 0 || this.offset > this.data.length) throw new Error("Incomplete embroidery file.");
  }

  read(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.data.length) throw new Error("Incomplete embroidery file.");
    if (length === 0) return new Uint8Array(0);
    const start = Math.min(this.offset, this.data.length);
    const end = Math.min(start + length, this.data.length);
    this.offset = end;
    return this.data.subarray(start, end);
  }

  readUInt8(): number | null {
    const b = this.read(1);
    return b.length === 1 ? b[0]! : null;
  }
}

export function signed8(b: number): number {
  if (b > 127) return -256 + b;
  return b;
}

export function signed16(v: number): number {
  v &= 0xffff;
  if (v > 0x7fff) return -0x10000 + v;
  return v;
}


export function readSigned(stream: ByteReader, n: number): number[] {
  const bytes = stream.read(n);
  const out: number[] = [];
  for (const b of bytes) out.push(signed8(b));
  return out;
}

function assemble(bytes: Uint8Array, littleEndian: boolean): number {
  let value = 0;
  if (littleEndian) {
    for (let i = bytes.length - 1; i >= 0; i--) {
      value = value * 256 + bytes[i]!;
    }
  } else {
    for (let i = 0; i < bytes.length; i++) {
      value = value * 256 + bytes[i]!;
    }
  }
  return value;
}

function readInt(
  stream: ByteReader,
  n: number,
  littleEndian: boolean,
): number | null {
  const bytes = stream.read(n);
  return bytes.length === n ? assemble(bytes, littleEndian) : null;
}

export function readInt8(stream: ByteReader): number | null {
  return readInt(stream, 1, true);
}


export function readInt16le(stream: ByteReader): number | null {
  return readInt(stream, 2, true);
}

export function readInt16be(stream: ByteReader): number | null {
  return readInt(stream, 2, false);
}

export function readInt24le(stream: ByteReader): number | null {
  return readInt(stream, 3, true);
}

export function readInt24be(stream: ByteReader): number | null {
  return readInt(stream, 3, false);
}

export function readInt32le(stream: ByteReader): number | null {
  return readInt(stream, 4, true);
}

export function readInt32be(stream: ByteReader): number | null {
  return readInt(stream, 4, false);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function readString8(stream: ByteReader, length: number): string | null {
  const bytes = stream.read(length);
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}
