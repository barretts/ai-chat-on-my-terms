import { describe, expect, it } from "vitest";
import {
  connectionNote,
  pairedDeviceViews,
  pairingBlockedReason,
  parsePairingScanNote,
  recordFromScan,
  revokeStoredPairing,
  storeStoredPairing,
  type PairingQrV1,
  type StoredPairing,
} from ".";

const ROUTE_A = "0198f2a3-0000-7000-8000-00000000000a";
const ROUTE_B = "0198f2a3-0000-7000-8000-00000000000b";

const qr = (routeId: string): PairingQrV1 => ({
  protocol: { major: 1, minor: 0 },
  companionRouteId: routeId,
  relayUrl: "https://relay.example.internal/ws",
  mobileRouteTicket: "A-9_z".padEnd(43, "x"),
  pairingSecret: "B8k_Q".padEnd(43, "y"),
  serverIdentityFingerprint: `sha256:${"ab12cd34".repeat(8)}`,
});

describe("parsePairingScanNote", () => {
  it("accepts the project-owned pairing v1 payload", () => {
    const note = parsePairingScanNote(JSON.stringify(qr(ROUTE_A)));
    expect(note.kind).toBe("valid");
    if (note.kind !== "valid") return;
    expect(note.summary.host).toBe("relay.example.internal");
    expect(note.summary.fingerprintTail).toBe("ab12cd34");
    expect(note.summary.routeId).toBe(ROUTE_A);
  });

  it("rejects official LM Mini pairing payloads without claiming interop", () => {
    const note = parsePairingScanNote(JSON.stringify({ pairingCode: "LM-MINI-4821", pin: "123456" }));
    expect(note.kind).toBe("invalid");
    if (note.kind !== "invalid") return;
    expect(note.message).toMatch(/not supported/i);
    expect(note.message).toMatch(/LM Mini/);
  });

  it("rejects pre-v1 and malformed payloads", () => {
    expect(parsePairingScanNote("").kind).toBe("invalid");
    expect(parsePairingScanNote("not json").kind).toBe("invalid");
    expect(parsePairingScanNote(JSON.stringify({ version: 0, secret: "x" })).kind).toBe("invalid");
    const staleMajor = { ...qr(ROUTE_A), protocol: { major: 2, minor: 0 } };
    expect(parsePairingScanNote(JSON.stringify(staleMajor)).kind).toBe("invalid");
  });
});

describe("pairing consent gate", () => {
  it("blocks pairing until sharing is opted in", () => {
    const valid = parsePairingScanNote(JSON.stringify(qr(ROUTE_A)));
    expect(pairingBlockedReason(false, valid)).toMatch(/opt-in|Turn on sharing/i);
    expect(pairingBlockedReason(true, valid)).toBe("");
  });

  it("surfaces scan errors ahead of consent", () => {
    const invalid = parsePairingScanNote("nope");
    expect(pairingBlockedReason(true, invalid)).toMatch(/not a LocalLab|not supported/i);
  });
});

describe("paired device lifecycle", () => {
  const first: StoredPairing = { ...recordFromScan(qr(ROUTE_A), "Studio Mac", "2026-10-14T10:00:00.000Z") };
  const second: StoredPairing = { ...recordFromScan(qr(ROUTE_B), "Work Mac", "2026-10-14T11:00:00.000Z") };

  it("stores one record per pairing route, replacing re-scans", () => {
    let records: StoredPairing[] = [];
    records = storeStoredPairing(records, first);
    records = storeStoredPairing(records, second);
    records = storeStoredPairing(records, recordFromScan(qr(ROUTE_A), "Studio Mac (renamed)", "2026-10-14T12:00:00.000Z"));
    expect(records).toHaveLength(2);
    const rows = pairedDeviceViews(records);
    expect(rows[0]?.routeId).toBe(ROUTE_A);
    expect(rows[0]?.label).toBe("Studio Mac (renamed)");
    expect(rows.map((row) => row.status)).toEqual(["active", "active"]);
  });

  it("revokes a pairing without deleting history", () => {
    const revoked = revokeStoredPairing([first, second], ROUTE_A, "2026-10-14T12:30:00.000Z");
    expect(revoked.find((r) => r.qr.companionRouteId === ROUTE_A)?.revokedAt).toBe("2026-10-14T12:30:00.000Z");
    expect(revoked.find((r) => r.qr.companionRouteId === ROUTE_B)?.revokedAt).toBeNull();
    const rows = pairedDeviceViews(revoked);
    expect(rows.find((row) => row.routeId === ROUTE_A)?.status).toBe("revoked");
    // Revoking twice never rewrites the first stamp.
    const twice = revokeStoredPairing(revoked, ROUTE_A, "2026-10-14T13:00:00.000Z");
    expect(twice.find((r) => r.qr.companionRouteId === ROUTE_A)?.revokedAt).toBe("2026-10-14T12:30:00.000Z");
  });
});

describe("connectionNote", () => {
  it("maps every client state to user-meaningful help", () => {
    expect(connectionNote("idle", "")).toMatch(/Scan a QR/);
    expect(connectionNote("connecting", "")).toMatch(/relay/i);
    expect(connectionNote("awaiting-peer", "")).toMatch(/desktop/i);
    expect(connectionNote("ready", "")).toBe("Paired and connected.");
    expect(connectionNote("closed", "Relay closed: bye.")).toBe("Relay closed: bye.");
  });

  it("terminal failures always demand a fresh LocalLab QR and never promise LM Mini interop", () => {
    for (const state of ["re-pair-required", "version-mismatch"]) {
      const note = connectionNote(state, "");
      expect(note).toMatch(/QR/i);
      expect(note).toMatch(/LocalLab/i);
      expect(note).not.toMatch(/works with LM Mini/i);
    }
  });
});
