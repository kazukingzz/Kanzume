/**
 * Worker の fetch / WebSocket の宛先の制限。Cloudflare の workerd と同じく、ループバック・リンクローカル（クラウドのメタデータ）・
 * プライベートネットワークなど、インターネットでない宛先には接続させない。
 * 宛先は名前解決した IP アドレスで確かめ、確かめたアドレスにそのまま接続する（確かめたあとで DNS の答えを変えられないように）。
 * リダイレクト先も同じ接続の仕組みを通るので、同じように確かめられる。
 *
 * これは vm の中の Worker に対する制限で、vm から抜け出したコードは子プロセスから直接ソケットを開ける
 * （Node の権限モデルはネットワークを制限しない）。本当の境界にはネットワーク名前空間やファイアウォールが要る
 */
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";

export interface LookupAddress {
  address: string;
  family: number;
}

export interface EgressOptions {
  /** 名前解決（テストで差し替える） */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  /** 確かめずに接続を許す「IP アドレス:ポート」（テスト専用。ループバックのテスト用サーバーに届くように。IPv6 は [::1]:80 の形） */
  allow?: readonly string[];
}

export interface Egress {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

const CONNECT_TIMEOUT_MS = 10_000;
const DENIED = "KANZUME_EGRESS_DENIED";

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  // ::/96 は未指定（::）・ループバック（::1）・IPv4 互換アドレス。::ffff:0:0/96（IPv4 射影）は中の IPv4 で確かめる
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

/** IPv6 アドレスに埋め込まれた IPv4 アドレス（IPv4 射影 ::ffff:0:0/96・NAT64 64:ff9b::/96・6to4 2002::/16） */
function embeddedIpv4(address: string): string | null {
  const words = expandIpv6(address);
  if (!words) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) return v4(words[6], words[7]);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return v4(words[6], words[7]);
  if (words[0] === 0x2002) return v4(words[1], words[2]);
  return null;
}

function expandIpv6(address: string): number[] | null {
  let s = address.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // 末尾が IPv4 の表記（::ffff:127.0.0.1）なら 16 ビット 2 つにする
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    s = `${dotted[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const part = (x: string | undefined) => (x ? x.split(":").map((h) => Number.parseInt(h, 16)) : []);
  const h = part(head);
  const t = part(tail);
  const words = tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** インターネットのアドレスか（ループバック・リンクローカル・プライベート・CGNAT・マルチキャスト・予約済みなどは false） */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const v4 = embeddedIpv4(address);
  if (v4 !== null) return isPublicAddress(v4);
  return !blocked.check(address.split("%")[0], "ipv6");
}

function denied(message: string): Error {
  return Object.assign(new Error(message), { code: DENIED });
}

const systemLookup = async (hostname: string): Promise<LookupAddress[]> => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** 接続してよいアドレスを 1 つ選ぶ。名前解決の答えに 1 つでもインターネットでないものがあれば断る */
async function resolveDestination(hostname: string, port: number, options: EgressOptions): Promise<string> {
  const host = hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  const literal = net.isIP(host) !== 0;
  if (!literal) {
    const lower = host.toLowerCase();
    if (lower === "localhost" || lower.endsWith(".localhost")) throw denied(`${hostname} には接続できません（ローカルホスト）`);
    if (!lower.includes(".")) throw denied(`${hostname} には接続できません（ドメインでない名前）`);
  }
  const addresses = literal ? [{ address: host, family: net.isIP(host) }] : await (options.lookup ?? systemLookup)(host);
  if (addresses.length === 0) throw denied(`${hostname} の IP アドレスが見つかりません`);
  const key = (a: LookupAddress) => (net.isIP(a.address) === 6 ? `[${a.address}]:${port}` : `${a.address}:${port}`);
  const allowed = addresses.find((a) => options.allow?.includes(key(a)));
  if (allowed) return allowed.address;
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) throw denied(`${literal ? `${host} ` : `${host}（${bad.address}）`}はインターネットのアドレスでないので、Worker からは接続できません`);
  return addresses[0].address;
}

interface ConnectOptions {
  hostname: string;
  protocol: string;
  port: string | number;
  servername?: string | null;
}

type Connector = (opts: ConnectOptions, callback: (err: Error | null, socket: net.Socket | null) => void) => void;

/** undici の Agent に渡す接続の仕組み。確かめた IP アドレスに接続する（TLS の証明書は元のホスト名で確かめる） */
function connector(options: EgressOptions): Connector {
  return (opts, callback) => {
    const https = opts.protocol === "https:" || opts.protocol === "wss:";
    const port = Number(opts.port) || (https ? 443 : 80);
    resolveDestination(opts.hostname, port, options).then(
      (address) => {
        const host = opts.hostname.replace(/^\[(.*)\]$/, "$1");
        const servername = opts.servername || (net.isIP(host) ? undefined : host);
        const socket = https ? tls.connect({ host: address, port, servername, ALPNProtocols: ["http/1.1"] }) : net.connect({ host: address, port });
        let settled = false;
        const done = (err: Error | null) => {
          if (settled) return;
          settled = true;
          socket.setTimeout(0);
          socket.off("error", done);
          if (err) {
            socket.destroy();
            callback(err, null);
          } else {
            socket.setNoDelay(true);
            callback(null, socket);
          }
        };
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(new Error(`${opts.hostname} への接続が時間切れになりました`)));
        socket.once(https ? "secureConnect" : "connect", () => done(null));
        socket.once("error", done);
      },
      (err) => callback(err as Error, null),
    );
  };
}

/**
 * Node の fetch が使っている undici の Agent のクラス。npm の undici を足さないのは、Node に入っている fetch と
 * 版を合わせるため（Response などのクラスも Node のものでないと、Worker の返した Response を本体が受け取れない）と、
 * 子プロセスのメモリを増やさないため
 */
async function nodeAgentClass(): Promise<new (options: { connect: Connector }) => object> {
  const key = Symbol.for("undici.globalDispatcher.1");
  const g = globalThis as Record<symbol, unknown>;
  // 既定の Agent は最初の fetch で作られる
  if (!g[key]) await fetch("data:,").catch(() => {});
  const agent = g[key] as { constructor?: unknown } | undefined;
  if (typeof agent?.constructor !== "function") throw new Error("fetch の接続の仕組みを用意できませんでした");
  return agent.constructor as new (options: {
    connect: Connector;
  }) => object;
}

/** 宛先を制限した fetch と WebSocket */
export async function createEgress(options: EgressOptions = {}): Promise<Egress> {
  const Agent = await nodeAgentClass();
  const dispatcher = new Agent({ connect: connector(options) });

  const guardedFetch: typeof fetch = async (input, init) => {
    // Worker が init に別の dispatcher を入れても使わせない（Request にまとめてから、こちらの dispatcher だけを渡す）
    const request = new Request(input, init);
    try {
      return await fetch(request, { dispatcher } as RequestInit);
    } catch (err) {
      const cause = (err as { cause?: { code?: unknown; message?: string } })?.cause;
      if (cause?.code === DENIED) throw new TypeError(cause.message, { cause });
      throw err;
    }
  };

  const NativeWebSocket = globalThis.WebSocket;
  class GuardedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      const init = protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols : { protocols };
      super(url, { ...init, dispatcher } as never);
    }
  }
  return { fetch: guardedFetch, WebSocket: GuardedWebSocket };
}
