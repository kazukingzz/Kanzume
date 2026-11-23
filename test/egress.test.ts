import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createEgress, isPublicAddress } from "../src/runtime/egress.ts";

/** ループバックで待ち受けるテスト用のサーバー。届いた接続の数を数える */
async function server(t: TestContext, handler: http.RequestListener = (_, res) => res.end("ok")) {
  const s = http.createServer(handler);
  let connections = 0;
  s.on("connection", () => connections++);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  return { port: (s.address() as AddressInfo).port, connections: () => connections };
}

async function refused(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (err: Error) => {
    assert.equal(err.name, "TypeError");
    assert.match(err.message, pattern);
    return true;
  });
}

test("インターネットのアドレスだけを接続してよいアドレスとみなす", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(a), true, a);
  for (const a of [
    "127.0.0.1",
    "127.255.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "240.0.0.1",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%lo0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:0101::1",
    "not an ip",
  ]) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test("Worker の fetch はループバック・localhost・リンクローカル・ドメインでない名前に接続しない", async (t) => {
  const target = await server(t);
  const egress = await createEgress();
  await refused(egress.fetch(`http://127.0.0.1:${target.port}/`), /127\.0\.0\.1 はインターネットのアドレスでない/);
  await refused(egress.fetch(`http://localhost:${target.port}/`), /localhost には接続できません/);
  await refused(egress.fetch(`http://[::1]:${target.port}/`), /::1 はインターネットのアドレスでない/);
  await refused(egress.fetch(`http://2130706433:${target.port}/`), /127\.0\.0\.1 はインターネットのアドレスでない/);
  await refused(egress.fetch("http://169.254.169.254/latest/meta-data/"), /169\.254\.169\.254 はインターネットのアドレスでない/);
  await refused(egress.fetch("http://intranet/"), /ドメインでない名前/);
  assert.equal(target.connections(), 0, "テスト用のサーバーには 1 度も接続していない");
});

test("名前解決の答えに 1 つでもインターネットでないアドレスがあれば接続しない", async (t) => {
  const target = await server(t);
  const toLoopback = await createEgress({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  await refused(toLoopback.fetch(`http://rebind.example:${target.port}/`), /rebind\.example（127\.0\.0\.1）はインターネットのアドレスでない/);
  const mixed = await createEgress({
    lookup: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:10.0.0.1", family: 6 },
    ],
  });
  await refused(mixed.fetch("http://mixed.example/"), /::ffff:10\.0\.0\.1/);
  assert.equal(target.connections(), 0);
});

test("許可した宛先からのリダイレクトでも、その先がプライベートなアドレスなら接続しない", async (t) => {
  const other = await server(t);
  const allowed = await server(t, (req, res) => {
    if (req.url === "/redirect") res.writeHead(302, { location: `http://127.0.0.1:${other.port}/` });
    res.end("allowed");
  });
  const egress = await createEgress({ allow: [`127.0.0.1:${allowed.port}`] });
  assert.equal(await (await egress.fetch(`http://127.0.0.1:${allowed.port}/`)).text(), "allowed");
  await refused(egress.fetch(`http://127.0.0.1:${allowed.port}/redirect`), /127\.0\.0\.1 はインターネットのアドレスでない/);
  assert.equal(other.connections(), 0);
});

test("Worker の WebSocket もプライベートなアドレスに接続しない", async (t) => {
  let connections = 0;
  const s = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(() => s.close());
  const egress = await createEgress();
  for (const protocols of [undefined, "chat", { protocols: ["chat"] }]) {
    const ws = new egress.WebSocket(`ws://127.0.0.1:${(s.address() as AddressInfo).port}/`, protocols as never);
    assert.ok(ws instanceof WebSocket);
    assert.equal(await new Promise((resolve) => ws.addEventListener("close", () => resolve("closed"))), "closed");
  }
  assert.equal(connections, 0);
});
