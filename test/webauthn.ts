import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const b64 = (data: Buffer) => data.toString("base64url");

/** テスト用のパスキー（P-256 の鍵を持つ、ソフトウェアの認証器）。ブラウザの navigator.credentials の代わりに応答を作る */
export class SoftAuthenticator {
  readonly id = randomBytes(16);
  #key = generateKeyPairSync("ec", { namedCurve: "P-256" });
  #counter = 0;

  get credentialId(): string {
    return b64(this.id);
  }

  #authData(rpId: string, flags: number, extra: Buffer = Buffer.alloc(0)): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, extra]);
  }

  /** navigator.credentials.create の応答（toJSON の形） */
  create(options: { challenge: string; rp: { id?: string } }, origin: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const jwk = this.#key.publicKey.export({ format: "jwk" });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    // UP・UV・AT（認証器のデータあり）
    const authData = this.#authData(options.rp.id!, 0x45, Buffer.concat([Buffer.alloc(16), idLength, this.id, Buffer.from(cose)]));
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(Buffer.from(attestationObject)), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get の応答（toJSON の形） */
  get(options: { challenge: string; rpId?: string }, origin: string) {
    this.#counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const authenticatorData = this.#authData(options.rpId!, 0x05);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.#key.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) },
      clientExtensionResults: {},
    };
  }
}
