import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const secretHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const opaqueSecret = (prefix: string): string =>
  `${prefix}_${randomBytes(32).toString("base64url")}`;

export class SecretBox {
  public constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("SecretBox requires a 32-byte key");
  }

  public seal(value: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", nonce.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
  }

  public open(value: string, context: string): string {
    const [version, nonceText, ciphertextText, tagText, extra] = value.split(".");
    if (version !== "v1" || !nonceText || !ciphertextText || !tagText || extra !== undefined) {
      throw new Error("Encrypted value is malformed");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonceText, "base64url"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
