import { types } from "node:util";

export async function toBytes(value: unknown): Promise<Buffer> {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value);
  if (types.isAnyArrayBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const v = value as { getReader?: unknown; arrayBuffer?: unknown };
  if (typeof v.getReader === "function") return Buffer.from(await new Response(value as ReadableStream).arrayBuffer());
  if (typeof v.arrayBuffer === "function") return Buffer.from(await (value as Blob).arrayBuffer());
  throw new TypeError("値は string / ArrayBuffer / ArrayBufferView / ReadableStream / Blob のいずれかにしてください");
}

export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function toStream(buf: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (buf.byteLength) controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
