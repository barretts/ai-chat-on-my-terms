import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  PAIRING_PROTOCOL,
  PairingQrV1Schema,
  type PairingQrV1,
} from "@locallab/service-contracts/pairing";
import {
  EncryptedPayloadSchema,
  EncryptedRelayFrameV1Schema,
  validateRelayFrameSize,
  type EncryptedPayload,
  type EncryptedRelayFrameV1,
} from "@locallab/service-contracts/relay";

/**
 * T093: project pairing QR v1 crypto (RE-01/RE-06). Wire shapes are frozen in
 * @locallab/service-contracts; the KDF/HKDF layout below is the cross-language
 * contract shared with apps/companion/remote/crypto through
 * fixtures/pairing-vectors.json:
 * - IKM = 32-byte pairing secret; salt = mobileSalt(16) || companionSalt(16).
 * - Session/nonce keys mix per-connection ephemerals into the salt:
 *   mobileEphemeral(16) || companionEphemeral(16) appended after the salts.
 *   Each side contributes a fresh random 16-byte ephemeral in its handshake
 *   frame, so every connection derives fresh session keys and replay
 *   windows — two sessions from one saved pairing can never reuse a
 *   (key, nonce) pair even though the QR-derived salts are deterministic.
 * - info strings include the protocol level and route/direction labels.
 *   with flow in {"mobile->companion","companion->mobile"} and hello has no flow.
 * - Hello proof = HMAC-SHA256(helloKey, "v1|<routeId>|<mobileSalt b64url>|<companionSalt b64url>").
 * - The handshake channel (labels handshake/handshake-nonce, deterministic
 *   salts only) seals hello/ready using a fresh random 96-bit nonce on
 *   every encryption. Protocol 1.2 rotates the formerly reused keys.
 *   Data frames retain counter-derived nonces under ephemeral-mixed keys.
 * - Frame nonce12 = HMAC-SHA256(nonceKey(flow), "c:" + u64be(sequence))[0..12],
 *   so the nonce field equals deriveNonce(frame.sequence) and the receiver
 *   rejects frames whose advertised nonce is not the derived one.
 * - AAD = utf8("v1|<routeId>|<requestId>|<sequence>|<contentTag>|<declaredSize>|<nonce16>").
 * - ciphertext = AES-256-GCM(directionKey, iv=nonce12, aad, payloadJson utf8) || tag(16).
 * Counters/nonce space are per session (fresh ephemeral-mixed keys) and per
 * direction; the receiver rejects duplicate, stale and beyond-window sequences.
 */

export type { EncryptedPayload, EncryptedRelayFrameV1 };

export function createUuidV7(): string {
  const bytes = Buffer.allocUnsafe(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  Buffer.from(randomBytes(10)).copy(bytes, 6);
  bytes.writeUInt8(0x70 | (bytes.readUInt8(6) & 0x0f), 6);
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class PairingCryptoError extends Error {
  constructor(
    readonly code: "malformed" | "unauthorized",
    message: string,
  ) {
    super(message);
    this.name = "PairingCryptoError";
  }
}

const PROTOCOL_LABEL = `${PAIRING_PROTOCOL.major}.${PAIRING_PROTOCOL.minor}`;

export type SessionSalt = Uint8Array;

function requireBytes(value: Uint8Array, length: number, what: string): void {
  if (value.length !== length)
    throw new PairingCryptoError(
      "malformed",
      `${what} must be exactly ${length} bytes`,
    );
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value)
    throw new PairingCryptoError("malformed", "Invalid base64url value");
  return bytes;
}

function hkdf(secret: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", secret, salt, Buffer.from(info, "utf8"), length),
  );
}

export type PairingRole = "mobile" | "companion";

function flowLabel(from: PairingRole, to: PairingRole): string {
  if (from === to)
    throw new PairingCryptoError("malformed", "Direction needs two distinct roles");
  return `${from}->${to}`;
}

function sessionSalt(mobileSalt: SessionSalt, companionSalt: SessionSalt): Uint8Array {
  requireBytes(mobileSalt, 16, "mobileSalt");
  requireBytes(companionSalt, 16, "companionSalt");
  return new Uint8Array([...mobileSalt, ...companionSalt]);
}

function keyInfo(kind: "hello" | "key" | "nonce" | "handshake" | "handshake-nonce", routeId: string, flow?: string): string {
  return flow === undefined
    ? `locallab-pairing-${kind}-v1|${PROTOCOL_LABEL}|${routeId}`
    : `locallab-pairing-${kind}-v1|${PROTOCOL_LABEL}|${routeId}|${flow}`;
}
/**
 * R007: per-connection ephemerals mixed into the session key derivation.
 * Each side contributes a fresh random 16-byte value in its handshake frame
 * (hello carries mobileEphemeral, ready carries companionEphemeral), so
 * session keys and replay windows are fresh per connection while the
 * long-lived pairing secret and QR-derived salts never travel on the wire.
 */
export interface SessionEntropy {
  mobileEphemeral: SessionSalt;
  companionEphemeral: SessionSalt;
}

function entropyBytes(mobileSalt: SessionSalt, companionSalt: SessionSalt, entropy: SessionEntropy): Uint8Array {
  if (entropy.mobileEphemeral.length !== 16)
    throw new PairingCryptoError("malformed", "mobileEphemeral must be a 16-byte ephemeral");
  if (entropy.companionEphemeral.length !== 16)
    throw new PairingCryptoError("malformed", "companionEphemeral must be a 16-byte ephemeral");
  return Buffer.concat([sessionSalt(mobileSalt, companionSalt), entropy.mobileEphemeral, entropy.companionEphemeral]);
}

export function deriveHelloKey(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string): Uint8Array {
  requireBytes(pairingSecret, 32, "pairingSecret");
  return hkdf(pairingSecret, sessionSalt(mobileSalt, companionSalt), keyInfo("hello", routeId), 32);
}

export function deriveSessionKey(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, entropy: SessionEntropy, routeId: string, from: PairingRole, to: PairingRole): Uint8Array {
  requireBytes(pairingSecret, 32, "pairingSecret");
  return hkdf(pairingSecret, entropyBytes(mobileSalt, companionSalt, entropy), keyInfo("key", routeId, flowLabel(from, to)), 32);
}

export function deriveHandshakeKey(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string, from: PairingRole, to: PairingRole): Uint8Array {
  requireBytes(pairingSecret, 32, "pairingSecret");
  return hkdf(pairingSecret, sessionSalt(mobileSalt, companionSalt), keyInfo("handshake", routeId, flowLabel(from, to)), 32);
}

export function deriveHandshakeNonceKey(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string, from: PairingRole, to: PairingRole): Uint8Array {
  requireBytes(pairingSecret, 32, "pairingSecret");
  return hkdf(pairingSecret, sessionSalt(mobileSalt, companionSalt), keyInfo("handshake-nonce", routeId, flowLabel(from, to)), 32);
}

export function helloProof(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string): string {
  const key = deriveHelloKey(pairingSecret, mobileSalt, companionSalt, routeId);
  const transcript = `v1|${routeId}|${toBase64Url(mobileSalt)}|${toBase64Url(companionSalt)}`;
  return toBase64Url(createHmac("sha256", key).update(transcript, "utf8").digest());
}

export function verifyHelloProof(proof: string, pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string): boolean {
  let expected: Uint8Array;
  try {
    expected = fromBase64Url(helloProof(pairingSecret, mobileSalt, companionSalt, routeId));
  } catch {
    return false;
  }
  let presented: Uint8Array;
  try {
    presented = fromBase64Url(proof);
  } catch {
    return false;
  }
  return expected.length === 32 && presented.length === 32 && timingSafeEqual(expected, presented);
}

export function deriveNonceKey(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, entropy: SessionEntropy, routeId: string, from: PairingRole, to: PairingRole): Uint8Array {
  return hkdf(pairingSecret, entropyBytes(mobileSalt, companionSalt, entropy), keyInfo("nonce", routeId, flowLabel(from, to)), 32);
}

export function deriveNonce(nonceKey: Uint8Array, sequence: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new PairingCryptoError("malformed", "sequence must be a nonnegative safe integer");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(sequence));
  return createHmac("sha256", nonceKey).update(Buffer.concat([Buffer.from("c:", "utf8"), counter])).digest().subarray(0, 12);
}

function frameAad(frame: Pick<EncryptedRelayFrameV1, "routeId" | "requestId" | "sequence" | "contentTag" | "declaredSize" | "nonceBase64Url">): Buffer {
  return Buffer.from(
    `v1|${frame.routeId}|${frame.requestId}|${frame.sequence}|${frame.contentTag}|${frame.declaredSize}|${frame.nonceBase64Url}`,
    "utf8",
  );
}

function sealBytes(directionKey: Uint8Array, nonceKey: Uint8Array, plaintext: Uint8Array, routeId: string, requestId: string, sequence: number, contentTag: EncryptedPayload["tag"], nonce = deriveNonce(nonceKey, sequence)): EncryptedRelayFrameV1 {
  requireBytes(nonce, 12, "nonce");
  const nonceBase64Url = toBase64Url(nonce);
  const cipher = createCipheriv("aes-256-gcm", directionKey, nonce);
  cipher.setAAD(
    frameAad({ routeId, requestId, sequence, contentTag, declaredSize: plaintext.length + 16, nonceBase64Url }),
    { plaintextLength: plaintext.length },
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const frame: EncryptedRelayFrameV1 = {
    protocol: { major: PAIRING_PROTOCOL.major, minor: PAIRING_PROTOCOL.minor },
    routeId,
    requestId,
    sequence,
    nonceBase64Url,
    contentTag,
    declaredSize: ciphertext.length,
    ciphertextBase64Url: toBase64Url(ciphertext),
  };
  EncryptedRelayFrameV1Schema.parse(frame);
  validateRelayFrameSize(frame);
  return frame;
}

export function sealPayload(payload: EncryptedPayload, directionKey: Uint8Array, nonceKey: Uint8Array, routeId: string, requestId: string, sequence: number): EncryptedRelayFrameV1 {
  const checked = EncryptedPayloadSchema.parse(payload);
  return sealBytes(directionKey, nonceKey, Buffer.from(JSON.stringify(checked), "utf8"), routeId, requestId, sequence, checked.tag);
}

export function sealHandshakePayload(
  payload: EncryptedPayload, directionKey: Uint8Array, nonceKey: Uint8Array,
  routeId: string, requestId: string, sequence: number,
  nonce: Uint8Array = randomBytes(12),
): EncryptedRelayFrameV1 {
  const checked = EncryptedPayloadSchema.parse(payload);
  return sealBytes(directionKey, nonceKey, Buffer.from(JSON.stringify(checked), "utf8"), routeId, requestId, sequence, checked.tag, nonce);
}

/** Sender side: hands out frames with strictly increasing per-direction sequences. */
export class SealingChannel {
  private nextSequence = 0;

  constructor(
    private readonly directionKey: Uint8Array,
    private readonly nonceKey: Uint8Array,
    private readonly routeId: string,
    private readonly randomNonce = false,
  ) {
    requireBytes(directionKey, 32, "directionKey");
    requireBytes(nonceKey, 32, "nonceKey");
  }

  seal(payload: EncryptedPayload, requestId: string): EncryptedRelayFrameV1 {
    const seal = this.randomNonce ? sealHandshakePayload : sealPayload;
    const frame = seal(payload, this.directionKey, this.nonceKey, this.routeId, requestId, this.nextSequence);
    this.nextSequence += 1;
    return frame;
  }
}

export const REPLAY_WINDOW = 1000;
export const REPLAY_TRACK = 64;

/** Receiver side: validates one direction, rejecting stale/duplicate/out-of-window sequences. */
export class OpeningChannel {
  private highSequence = -1;
  private seenMask = 0n;

  constructor(
    private readonly directionKey: Uint8Array,
    private readonly nonceKey: Uint8Array,
    private readonly routeId: string,
    private readonly randomNonce = false,
  ) {
    requireBytes(directionKey, 32, "directionKey");
    requireBytes(nonceKey, 32, "nonceKey");
  }

  // R021: validation and commitment are separate so authentication can
  // happen in between — a frame only consumes replay state once it has
  // authenticated, and an accepted older sequence is marked seen just
  // like a new high-water sequence.
  private checkSequence(sequence: number): void {
    if (sequence > this.highSequence + REPLAY_WINDOW)
      throw new PairingCryptoError("unauthorized", "frame sequence is beyond the replay window");
    if (sequence <= this.highSequence) {
      const back = this.highSequence - sequence;
      if (back >= REPLAY_TRACK)
        throw new PairingCryptoError("unauthorized", "frame sequence is below the replay window");
      if ((this.seenMask >> BigInt(back)) & 1n)
        throw new PairingCryptoError("unauthorized", "frame sequence was already used");
    }
  }

  private commitSequence(sequence: number): void {
    if (sequence > this.highSequence) {
      const forward = sequence - this.highSequence;
      this.seenMask = ((this.seenMask << BigInt(forward)) | 1n) & (1n << BigInt(REPLAY_TRACK)) - 1n;
      this.highSequence = sequence;
      return;
    }
    const back = this.highSequence - sequence;
    if (back < REPLAY_TRACK) this.seenMask |= 1n << BigInt(back);
  }

  open(frame: EncryptedRelayFrameV1): EncryptedPayload {
    const checked = EncryptedRelayFrameV1Schema.parse(frame);
    if (checked.routeId !== this.routeId)
      throw new PairingCryptoError("unauthorized", "frame route does not match this session");
    if (checked.protocol.major !== PAIRING_PROTOCOL.major || checked.protocol.minor !== PAIRING_PROTOCOL.minor)
      throw new PairingCryptoError("unauthorized", "frame protocol does not match this session");
    validateRelayFrameSize(checked);
    const expectedNonce = deriveNonce(this.nonceKey, checked.sequence);
    const advertised = fromBase64Url(checked.nonceBase64Url);
    if (advertised.length !== 12 || (!this.randomNonce && !timingSafeEqual(advertised, expectedNonce)))
      throw new PairingCryptoError("unauthorized", "frame nonce does not match its sequence");
    const ciphertext = fromBase64Url(checked.ciphertextBase64Url);
    if (ciphertext.length < 16)
      throw new PairingCryptoError("unauthorized", "frame ciphertext is too short");
    this.checkSequence(checked.sequence);
    const decipher = createDecipheriv("aes-256-gcm", this.directionKey, advertised);
    decipher.setAAD(frameAad(checked), { plaintextLength: ciphertext.length - 16 });
    let plaintext: Buffer;
    try {
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    } catch {
      throw new PairingCryptoError("unauthorized", "frame authentication failed");
    }
    // Authenticated = spent, even if the payload envelope is malformed.
    this.commitSequence(checked.sequence);
    return EncryptedPayloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
  }
}

export function createSessionPairing(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, entropy: SessionEntropy, routeId: string): {
  mobile: { toCompanion: SealingChannel; fromCompanion: OpeningChannel };
  companion: { toMobile: SealingChannel; fromMobile: OpeningChannel };
} {
  const channel = (from: PairingRole, to: PairingRole) => ({
    seal: new SealingChannel(
      deriveSessionKey(pairingSecret, mobileSalt, companionSalt, entropy, routeId, from, to),
      deriveNonceKey(pairingSecret, mobileSalt, companionSalt, entropy, routeId, from, to),
      routeId,
    ),
    open: new OpeningChannel(
      deriveSessionKey(pairingSecret, mobileSalt, companionSalt, entropy, routeId, to, from),
      deriveNonceKey(pairingSecret, mobileSalt, companionSalt, entropy, routeId, to, from),
      routeId,
    ),
  });
  const mobile = channel("mobile", "companion");
  const companion = channel("companion", "mobile");
  return {
    mobile: { toCompanion: mobile.seal, fromCompanion: mobile.open },
    companion: { toMobile: companion.seal, fromMobile: companion.open },
  };
}

/**
 * Handshake keys are pairing-derived, but every encryption has a fresh
 * random nonce, carried in the authenticated frame. Data traffic must
 * ride createSessionPairing built from the ephemerals these frames carry.
 */
export function createHandshakePairing(pairingSecret: Uint8Array, mobileSalt: SessionSalt, companionSalt: SessionSalt, routeId: string): {
  mobile: { toCompanion: SealingChannel; fromCompanion: OpeningChannel };
  companion: { toMobile: SealingChannel; fromMobile: OpeningChannel };
} {
  const channel = (from: PairingRole, to: PairingRole) => ({
    seal: new SealingChannel(
      deriveHandshakeKey(pairingSecret, mobileSalt, companionSalt, routeId, from, to),
      deriveHandshakeNonceKey(pairingSecret, mobileSalt, companionSalt, routeId, from, to),
      routeId,
      true,
    ),
    open: new OpeningChannel(
      deriveHandshakeKey(pairingSecret, mobileSalt, companionSalt, routeId, to, from),
      deriveHandshakeNonceKey(pairingSecret, mobileSalt, companionSalt, routeId, to, from),
      routeId,
      true,
    ),
  });
  const mobile = channel("mobile", "companion");
  const companion = channel("companion", "mobile");
  return {
    mobile: { toCompanion: mobile.seal, fromCompanion: mobile.open },
    companion: { toMobile: companion.seal, fromMobile: companion.open },
  };
}

export function generatePairingSecret(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function generateSessionSalt(): Uint8Array {
  return new Uint8Array(randomBytes(16));
}

/**
 * T096 handshake salts: deterministic per pairing, derived from the QR
 * secret + route id with ASCII labels "mobile"/"companion" as HKDF info.
 * Both peers derive the identical pair from QR data alone — the opaque
 * relay only ever carries sealed frames, so salts never travel on the
 * wire. Pairing secret and route id rotate together (regeneratePairing),
 * so every pairing gets fresh salts.
 */
export function deriveSessionSalts(
  pairingSecret: Uint8Array,
  routeId: string,
): { mobileSalt: SessionSalt; companionSalt: SessionSalt } {
  requireBytes(pairingSecret, 32, "pairingSecret");
  const salt = Buffer.from(
    `locallab-pairing-salt-v1|${PROTOCOL_LABEL}|${routeId}`,
    "utf8",
  );
  return {
    mobileSalt: hkdf(pairingSecret, salt, "mobile", 16),
    companionSalt: hkdf(pairingSecret, salt, "companion", 16),
  };
}

export function createPairingQrV1(input: {
  relayUrl: string;
  companionRouteId?: string;
  serverIdentityFingerprint: string;
}): PairingQrV1 {
  const qr: PairingQrV1 = {
    protocol: { major: PAIRING_PROTOCOL.major, minor: PAIRING_PROTOCOL.minor },
    companionRouteId: input.companionRouteId ?? createUuidV7(),
    relayUrl: input.relayUrl,
    mobileRouteTicket: toBase64Url(new Uint8Array(randomBytes(32))),
    pairingSecret: toBase64Url(generatePairingSecret()),
    serverIdentityFingerprint: input.serverIdentityFingerprint,
  };
  return PairingQrV1Schema.parse(qr);
}

export function encodePairingQrPayload(qr: PairingQrV1): string {
  return JSON.stringify(PairingQrV1Schema.parse(qr));
}

export function parsePairingQrPayload(text: string): PairingQrV1 {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new PairingCryptoError("malformed", "Pairing QR payload is not valid JSON");
  }
  const payload = PairingQrV1Schema.safeParse(decoded);
  if (!payload.success)
    throw new PairingCryptoError("malformed", "Pairing QR payload is not a LocalLab pairing v1");
  return payload.data;
}

export function mobileRouteTicketHash(mobileRouteTicket: string): string {
  const bytes = fromBase64Url(mobileRouteTicket);
  requireBytes(bytes, 32, "mobileRouteTicket");
  return createHmac("sha256", "locallab-pairing-route-ticket-v1").update(bytes).digest("hex");
}

export type PairingRecord = {
  qr: PairingQrV1;
  createdAt: string;
  revokedAt: string | null;
  label: string;
};

export function createPairingRecord(input: {
  relayUrl: string;
  serverIdentityFingerprint: string;
  label: string;
  now: string;
}): PairingRecord {
  return {
    qr: createPairingQrV1(input),
    createdAt: input.now,
    revokedAt: null,
    label: input.label,
  };
}

export function editPairingLabel(record: PairingRecord, label: string): PairingRecord {
  return { ...record, label };
}

/** Regenerate rotates the secret AND the route (key rotation revokes the old route). */
export function regeneratePairing(record: PairingRecord, now: string): { old: PairingRecord; next: PairingRecord } {
  const old: PairingRecord = { ...record, revokedAt: now };
  const next = createPairingRecord({
    relayUrl: record.qr.relayUrl,
    serverIdentityFingerprint: record.qr.serverIdentityFingerprint,
    label: record.label,
    now,
  });
  return { old, next };
}

export function assertPairingUsable(record: PairingRecord): void {
  if (record.revokedAt !== null)
    throw new PairingCryptoError("unauthorized", "This pairing was invalidated; show a new QR code.");
}
