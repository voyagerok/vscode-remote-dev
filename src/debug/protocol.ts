// Wire format between pipeProxy (spawned by cppdbg) and the extension's bridge server.
//
// Client → server: one JSON line `{"token","folder","command"}\n`, then raw stdin bytes;
//   half-close means stdin EOF.
// Server → client: frames `[kind:u8][len:u32be][payload]`; kind 1 = stdout, 2 = stderr,
//   3 = exit (payload = decimal exit code).

export const FRAME_STDOUT = 1;
export const FRAME_STDERR = 2;
export const FRAME_EXIT = 3;

export interface BridgeHello {
  token: string;
  folder: string;
  command: string;
}

export function frame(kind: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Incremental frame decoder. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly onFrame: (kind: number, payload: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const kind = this.buf.readUInt8(0);
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      this.onFrame(kind, payload);
    }
  }
}
