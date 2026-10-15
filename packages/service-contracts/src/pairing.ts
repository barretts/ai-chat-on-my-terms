import { z } from "zod";
import { EntityIdSchema } from "@locallab/contracts/identity";

export const PAIRING_PROTOCOL = Object.freeze({ major: 1, minor: 1 });
const Base64UrlBytes32Schema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected 32 base64url bytes");

export const PairingQrV1Schema = z
  .object({
    protocol: z
      .object({ major: z.literal(1), minor: z.number().int().nonnegative() })
      .strict(),
    companionRouteId: EntityIdSchema,
    relayUrl: z.string().url(),
    mobileRouteTicket: Base64UrlBytes32Schema,
    pairingSecret: Base64UrlBytes32Schema,
    serverIdentityFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  })
  .strict();
export type PairingQrV1 = z.infer<typeof PairingQrV1Schema>;

export type ProtocolVersion = { major: number; minor: number };

/** Major versions must match; this client supports only minor levels it knows. */
export function assertProtocolCompatible(
  local: ProtocolVersion,
  peer: ProtocolVersion,
): void {
  if (
    !Number.isInteger(local.major) ||
    !Number.isInteger(local.minor) ||
    !Number.isInteger(peer.major) ||
    !Number.isInteger(peer.minor)
  ) {
    throw new Error("Protocol versions must be integer major/minor pairs");
  }
  if (local.major !== peer.major) {
    throw new Error(
      `Incompatible protocol major version: local ${local.major}, peer ${peer.major}`,
    );
  }
  if (peer.minor > local.minor) {
    throw new Error(
      `Peer requires unsupported protocol minor version ${peer.minor}`,
    );
  }
}
