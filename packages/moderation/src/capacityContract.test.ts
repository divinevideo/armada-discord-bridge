import { describe, expect, it } from "bun:test";
import { capacityReportHash, REQUIRED_CAPACITY_CASES, validateCapacityContract } from "./capacityContract";
import type { CapacityMeasurementReport, PublicCapacityContract } from "./capacityContract";

// Synthetic contract inputs test validation; these values certify no deployment.
function fixture(): PublicCapacityContract {
  const sourceSha = "1".repeat(40), harnessSha = "2".repeat(40), imageId = "sha256:" + "3".repeat(64);
  const resources = { cpus: 1, memoryBytes: 536870912, database: "synthetic-postgres-envelope" };
  const report: CapacityMeasurementReport = {
    version: 1, sourceSha, harnessSha, imageId, platform: "linux/amd64", resourceEnvelope: resources,
    fixtureHash: "4".repeat(64), matrixHash: "5".repeat(64), startedAt: 1000, finishedAt: 2000,
    emulated: false, certified: false, provenance: { destinationMatched: true, controllerModelVerified: true },
    cases: REQUIRED_CAPACITY_CASES.map((id) => ({ id, status: "measured", samples: [{
      caseId: id, historyCount: 64, historyBytes: 65536, rekeyCount: 2, streamCount: 8, inFlight: 4,
      wallMs: 100, innerAdmissionMs: 60, expectedAccept: true, accepted: true, okReceived: true,
      persisted: true, fanout: true, lateDatabaseWrite: false, unsafeEffect: false,
    }] })),
  };
  for (const entry of report.cases.filter((c) => ["plugin_failure", "sql_timeout", "external_timeout"].includes(c.id))) {
    Object.assign(entry.samples[0], { expectedAccept: false, accepted: false, persisted: false, fanout: false });
  }
  return { version: 1, sourceSha, harnessSha, imageId, platform: "linux/amd64", reportHash: capacityReportHash(report),
    resourceEnvelope: resources, maxima: { historyCount: 64, historyBytes: 65536, rekeyCount: 2, streamCount: 8, inFlight: 4, innerAdmissionMs: 60 },
    thresholds: { warningHistoryCount: 16, pauseHistoryCount: 32, urgentReserve: 8 },
    deadlines: { sqlMs: 1500, pluginMs: 2000, externalMs: 3000, observedMaxMs: 100 },
    maxSampleAgeMs: 30000, measuredAt: 2000, measurement: report };
}
const identity = { sourceSha: "1".repeat(40), platform: "linux/amd64" };
function resign(value: PublicCapacityContract) { value.reportHash = capacityReportHash(value.measurement); return value; }

describe("measured capacity contract", () => {
  it("accepts a complete internally consistent synthetic evidence artifact", () => {
    expect(validateCapacityContract(fixture(), identity).thresholds.pauseHistoryCount).toBe(32);
  });
  it("rejects unsupported versions, missing evidence and source mismatch", () => {
    for (const value of [null, {}, { ...fixture(), version: 2 }, { ...fixture(), measurement: undefined }, { ...fixture(), sourceSha: "a".repeat(40) }]) {
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("rejects missing/duplicate/unmeasured scenarios", () => {
    for (const change of [(r: CapacityMeasurementReport) => r.cases.pop(), (r: CapacityMeasurementReport) => r.cases.push(r.cases[0]), (r: CapacityMeasurementReport) => { r.cases[0].status = "unsupported"; }]) {
      const value = fixture(); change(value.measurement);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
  it("rejects nonfinite, unordered and unmeasured maxima", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.maxima.historyBytes = Infinity; }, (v: PublicCapacityContract) => { v.thresholds.warningHistoryCount = 40; }, (v: PublicCapacityContract) => { v.thresholds.pauseHistoryCount = 4096; }, (v: PublicCapacityContract) => { v.maxima.historyCount = 128; }, (v: PublicCapacityContract) => { v.thresholds.urgentReserve = 60; }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("requires reserve and in-flight overshoot strictly below the measured history ceiling", () => {
    const value = fixture(); value.thresholds.urgentReserve = value.maxima.historyCount - value.thresholds.pauseHistoryCount - value.maxima.inFlight;
    expect(() => validateCapacityContract(value, identity)).toThrow(/reserve/);
  });
  it("rejects changed hard deadlines and a ceiling at an observed failure", () => {
    const changed = fixture(); changed.deadlines.externalMs = 6000;
    expect(() => validateCapacityContract(changed, identity)).toThrow();
    const failed = fixture(); failed.measurement.cases[0].samples.push({ ...failed.measurement.cases[0].samples[0], historyCount: 32, accepted: false, persisted: false, fanout: false, wallMs: 3001 });
    expect(() => validateCapacityContract(resign(failed), identity)).toThrow();
  });
  it("rejects forged hashes, mismatched image/resource/fixture identity and emulation", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.reportHash = "0".repeat(64); }, (v: PublicCapacityContract) => { v.imageId = "sha256:" + "a".repeat(64); }, (v: PublicCapacityContract) => { v.resourceEnvelope = { ...v.resourceEnvelope, cpus: 2 }; }, (v: PublicCapacityContract) => { v.measurement.fixtureHash = ""; resign(v); }, (v: PublicCapacityContract) => { v.measurement.emulated = true; resign(v); }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(value, identity)).toThrow();
    }
  });
  it("rejects unknown inner timings, unsafe late work, false acceptance or lost fanout", () => {
    for (const changes of [{ innerAdmissionMs: null }, { lateDatabaseWrite: true }, { unsafeEffect: true }, { persisted: false }, { fanout: false }, { okReceived: false }]) {
      const value = fixture(); Object.assign(value.measurement.cases[0].samples[0], changes);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
  it("rejects unverified destination/controller assumptions and stale report identity", () => {
    for (const mutate of [(v: PublicCapacityContract) => { v.measurement.provenance.controllerModelVerified = false; }, (v: PublicCapacityContract) => { v.measurement.provenance.destinationMatched = false; }, (v: PublicCapacityContract) => { v.measuredAt = 999; }, (v: PublicCapacityContract) => { v.maxSampleAgeMs = 0; }]) {
      const value = fixture(); mutate(value);
      expect(() => validateCapacityContract(resign(value), identity)).toThrow();
    }
  });
});

import { capacityFixture, validateMatrix } from "../../../scripts/fixtures/strfry-capacity";
import matrix from "../../../scripts/fixtures/capacity-matrix.json";
import { controlState, verifiedEvent, inspectRelayEvent } from "./relayPolicy";
import { bytesToHex, openWrap, parseEdition } from "@armada-bridge/concord-core";

describe("capacity measurement fixtures", () => {
  it("counts deterministic distinct valid signed editions with monotonic valid chains", () => {
    for (const count of [0, 1, 16]) {
      const first = capacityFixture(count, { roots: 3, channels: 4 }), second = capacityFixture(count, { roots: 3, channels: 4 });
      expect(first.fixtureHash).toBe(second.fixtureHash);
      expect(new Set(first.policy.controlEvents.map(e => e.id)).size).toBe(count);
      expect(first.policy.controlEvents.map(verifiedEvent).length).toBe(count);
      expect(controlState(first.policy).folded.incomplete).toHaveLength(0);
      expect(first.verifyChain()).toBe(true);
    }
  });
  it("grows actual control bytes and verifies the appended owner edition", () => {
    const small = capacityFixture(16), large = capacityFixture(16, { large: true });
    expect(large.historyBytes).toBeGreaterThan(small.historyBytes * 5);
    const appended = verifiedEvent(small.append());
    const stream = small.policy.controlStreams.find(s => s.key.pk === appended.pubkey)!;
    const edition = parseEdition(openWrap(appended, stream.key));
    expect(edition.version).toBe(17n);
    small.policy.controlEvents.push(appended);
    expect(controlState(small.policy).folded.incomplete).toHaveLength(0);
    expect(controlState(small.policy).folded.headEditions.get(bytesToHex(edition.entityId))?.version).toBe(17n);
  });
  it("requires every scenario, finite resources and a post-rejection observation horizon", () => {
    expect(validateMatrix(matrix).cases).toHaveLength(14);
    for (const change of [{ historyPoints: [1, 1] }, { historyPoints: [4096] }, { cases: ["cold"] }, { cpu: Infinity }, { lateObservationMs: 100 }, { observationTimeoutMs: 3000 }]) {
      expect(() => validateMatrix({ ...matrix, ...change })).toThrow();
    }
  });
  it("distinguishes no inner transaction in an injected process failure from unknown timings", () => {
    const value = fixture(), fault = value.measurement.cases.find(c => c.id === "plugin_failure")!.samples[0];
    Object.assign(fault, { innerAdmissionMs: null, innerNotStarted: true });
    expect(validateCapacityContract(resign(value), identity)).toBe(value);
    fault.innerNotStarted = false;
    expect(() => validateCapacityContract(resign(value), identity)).toThrow();
  });
});

import { capacityCalibrationLauncher, summarizeCapacity, serializeCapacityReport, expectedCapacityAcceptance } from "../../../scripts/fixtures/strfry-capacity";
it("exports a disposable library launcher without an entrypoint bypass", () => {
  const launcher = capacityCalibrationLauncher("/data/synthetic-test.json");
  expect(launcher).toContain('"/data/synthetic-test.json"');
  expect(launcher).toContain("new PolicyStore(sql,{capacity:");
  expect(launcher).toContain("runPlugin(process.stdin");
  expect(launcher).toContain("eventId:event.id");
  expect(launcher).not.toContain("process.env.MODERATION_CAPACITY_CONTRACT_FILE");
});
it("derives only a conservative review candidate with measured overshoot and explicit reserve", () => {
  const report = fixture().measurement;
  expect(summarizeCapacity(report).candidatePauseHistoryCount).toBeNull();
  expect(summarizeCapacity(report, 8).candidatePauseHistoryCount).toBe(52);
  const boundary = report.cases[0].samples[0];
  report.cases[0].samples.push({ ...boundary, historyCount: 40, accepted: false, persisted: false, fanout: false });
  expect(summarizeCapacity(report, 8).candidatePauseHistoryCount).toBe(27);
  report.cases[1].status = "unsupported";
  expect(summarizeCapacity(report, 8).candidatePauseHistoryCount).toBeNull();
});

it("hashes the persisted JSON roundtrip when optional measurement fields are undefined", () => {
  const value = fixture();
  value.measurement.cases[0].reason = undefined;
  const artifact = serializeCapacityReport(value.measurement);
  const persisted = JSON.parse(artifact.json) as CapacityMeasurementReport;
  expect(Object.hasOwn(persisted.cases[0], "reason")).toBe(false);
  expect(artifact.hash).toBe(capacityReportHash(persisted));
  value.measurement = persisted; value.reportHash = artifact.hash;
  expect(validateCapacityContract(value, identity)).toBe(value);
});

it("production authority rejects zero-history chat but accepts owner bootstrap control and rekey", async () => {
  const f = capacityFixture(0, { roots: 3, label: "zero-history-authority-proof" });
  for (const [event, action] of [[f.message(1), "reject"], [f.append(), "accept"], [f.rekey(1), "accept"]] as const) {
    const inspected = await inspectRelayEvent(event, { policy: f.policy, stream: f.streams.find(s => s.key.pk === event.pubkey), now: Date.now, isRemoved: async () => false, authorOf: async () => undefined });
    expect(inspected.result.action).toBe(action);
  }
});
it("classifies chat availability separately from bootstrap controls and injected faults", () => {
  expect(expectedCapacityAcceptance("cold", 0)).toBe(false);
  expect(expectedCapacityAcceptance("cold", 1)).toBe(true);
  expect(expectedCapacityAcceptance("append", 0)).toBe(true);
  expect(expectedCapacityAcceptance("rekey", 0)).toBe(true);
  for (const id of ["plugin_failure", "external_timeout", "sql_timeout"] as const) {
    for (const count of [0, 1, 16]) expect(expectedCapacityAcceptance(id, count)).toBe(false);
  }
});
