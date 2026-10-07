export class ByteWriter {
  private bytes = new Uint8Array(1024);
  private view = new DataView(this.bytes.buffer);
  private offset = 0;
  private end = 0;

  get length(): number {
    return this.end;
  }

  tell(): number {
    return this.offset;
  }

  seek(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`ByteWriter.seek: invalid offset ${offset}`);
    }
    this.ensure(offset);
    this.offset = offset;
  }

  writeBytes(bytes: Uint8Array | readonly number[]): void {
    this.ensure(this.offset + bytes.length);
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  writeUint8(value: number): void {
    this.ensure(this.offset + 1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  writeInt16le(value: number): void {
    this.ensure(this.offset + 2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint16le(value: number): void {
    this.ensure(this.offset + 2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeInt24le(value: number): void {
    this.writeUint8(value);
    this.writeUint8(Math.floor(value / 0x100));
    this.writeUint8(Math.floor(value / 0x10000));
  }

  writeUint32le(value: number): void {
    this.ensure(this.offset + 4);
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
  }

  writeUint16be(value: number): void {
    this.ensure(this.offset + 2);
    this.view.setUint16(this.offset, value & 0xffff, false);
    this.offset += 2;
  }

  writeUint24be(value: number): void {
    this.writeUint8((value >> 16) & 0xff);
    this.writeUint8((value >> 8) & 0xff);
    this.writeUint8(value & 0xff);
  }

  writeUint32be(value: number): void {
    this.ensure(this.offset + 4);
    this.view.setUint32(this.offset, value >>> 0, false);
    this.offset += 4;
  }

  writeFloat32le(value: number): void {
    this.ensure(this.offset + 4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  toUint8Array(): Uint8Array {
    return this.bytes.slice(0, this.end);
  }

  private ensure(size: number): void {
    this.end = Math.max(this.end, size);
    if (size <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < size) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
}
