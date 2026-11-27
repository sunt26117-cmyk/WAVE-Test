import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSixMosWaveform } from './focDyno/thermalExporter';
import { buildThermalHandoffFromSixMos } from './focDyno/scopeBridge';
import { DEFAULT_FOC_MODEL, simulateFoc6MosSteadyState } from './focThermal';
import type { MotorParams } from './focDyno/motorPhysics';

const motor: MotorParams = {
  polePairs: 7,
  kePrime: 0.0889,
  rLL25Ohm: 0.72,
  tCoilC: 45,
  lLLmH: 0.44,
  n0Rpm: 1450,
  betaSat: 0.0065,
  p0A: 5.2e-4,
  p0B: 4.8e-7,
  rsEffOverrideOhm: null,
  iIdleA: 0.06,
  etaInv: 0.95,
  iDeadbandA: 0.02,
  rLineOhm: 0.04,
  rdsOnMOhm: 12,
  tDeadNs: 450,
  fSwKhz: 20,
  vSdV: 0.85,
};

test('FOC-to-MOS constant operating-point handoff carries dq current, electrical frequency and modulation conditions', () => {
  const synth = synthesizeSixMosWaveform({
    vMeasV: 13.5,
    iBusA: 2.5,
    nRpm: 500,
    tAmbC: 25,
    fsHz: 10_000,
    durationS: 0.02,
    modulation: 'SVPWM',
    includeDuty: false,
  }, motor);
  assert.equal(synth.error, null);
  const payload = buildThermalHandoffFromSixMos(synth, motor, 500, 25);
  if (!payload) throw new Error('Expected valid FOC-to-MOS handoff payload.');
  assert.equal(payload.steadyOperatingPoint.mode, 'rotating');
  assert.equal(payload.steadyOperatingPoint.idPeakA, 0);
  assert.ok(Math.abs(payload.steadyOperatingPoint.iqPeakA - synth.pointResult.iqA) < 1e-10);
  assert.ok(Math.abs(payload.steadyOperatingPoint.electricalFrequencyHz - synth.summary.feHz) < 1e-10);
  assert.ok(Math.abs(payload.modDepthM - synth.summary.mCmd) < 5e-5, 'modulation handoff should only differ by display precision');
  assert.ok(Math.abs(payload.pfAngleDeg - synth.summary.phiCmdDeg) < 0.0051, 'power-factor angle handoff should only differ by display precision');
});

test('FOC-to-MOS zero-speed handoff explicitly marks locked-rotor DC current and electrical angle', () => {
  const synth = synthesizeSixMosWaveform({
    vMeasV: 13.5,
    iBusA: 0.65,
    nRpm: 0,
    tAmbC: 25,
    fsHz: 10_000,
    durationS: 0.02,
    modulation: 'SVPWM',
    includeDuty: false,
  }, motor);
  assert.equal(synth.error, null);
  const payload = buildThermalHandoffFromSixMos(synth, motor, 0, 25);
  if (!payload) throw new Error('Expected valid locked-rotor handoff payload.');
  assert.equal(payload.steadyOperatingPoint.mode, 'locked_rotor');
  assert.equal(payload.steadyOperatingPoint.electricalFrequencyHz, 0);
  assert.equal(payload.steadyOperatingPoint.electricalAngleDeg, 90);
});


test('FOC-to-MOS end-to-end fixed condition runs direct six-switch average loss and steady Tj without transient waveform input', () => {
  const synth = synthesizeSixMosWaveform({
    vMeasV: 13.5,
    iBusA: 2.5,
    nRpm: 500,
    tAmbC: 25,
    fsHz: 10_000,
    durationS: 0.02,
    modulation: 'SVPWM',
    includeDuty: false,
  }, motor);
  assert.equal(synth.error, null);
  const payload = buildThermalHandoffFromSixMos(synth, motor, 500, 25);
  if (!payload) throw new Error('Expected a valid fixed-condition payload.');
  const result = simulateFoc6MosSteadyState({
    model: DEFAULT_FOC_MODEL,
    mos: {
      rdsOn25Mohm: 5,
      rdsDataConfirmed: true,
      tempCoeffAlphaPerC: 0.0045,
      vsdV: 0.85,
      eonPlusEoffUj: 12,
      vRefV: payload.vBusConstV,
      iRefA: 3,
      qrrNc: 0,
      eonIncludesQrr: true,
      eossAlreadyIncludedInEsw: true,
    },
    ctrl: {
      modulation: payload.modulation ?? 'SVPWM',
      fswHz: payload.fswKhz * 1000,
      tDeadNs: payload.tDeadNs,
      modDepthM: payload.modDepthM,
      pfAngleDeg: payload.pfAngleDeg,
      tAmbC: payload.tAmbC,
      vBusConstV: payload.vBusConstV,
    },
    operatingPoint: payload.steadyOperatingPoint,
    integrationSamples: 1440,
  });

  assert.equal(result.mode, 'rotating');
  assert.equal(result.vBusConstV, payload.vBusConstV);
  assert.equal(result.fswHz, payload.fswKhz * 1000);
  assert.equal(result.mechanicalSpeedRpm, 500);
  assert.ok(Number.isFinite(result.pInverterTotalW) && result.pInverterTotalW > 0);
  assert.ok(Number.isFinite(result.tBoardSteadyC) && result.tBoardSteadyC > 25);
  assert.ok(Number.isFinite(result.tjMaxSteadyC) && result.tjMaxSteadyC > result.tBoardSteadyC);
  assert.ok(Number.isFinite(result.impliedInverterLossW) && (result.impliedInverterLossW as number) > 0);
  assert.ok(result.pInverterTotalW < (result.impliedInverterLossW as number));
  assert.equal(result.powerBalanceStatus, 'WITHIN_BUDGET');
  assert.equal(result.steadyConverged, true);
  // Defaults remain explicitly assumption-based, never silently promoted to a qualified device result.
  assert.equal(result.resultQualification, 'ASSUMPTION_BASED');

  // Export sample-rate/duration settings only affect the optional preview waveform,
  // not the steady electrical-cycle average or thermal balance.
  const differentlySampled = synthesizeSixMosWaveform({
    vMeasV: 13.5,
    iBusA: 2.5,
    nRpm: 500,
    tAmbC: 25,
    fsHz: 50_000,
    durationS: 0.05,
    modulation: 'SVPWM',
    includeDuty: true,
  }, motor);
  assert.equal(differentlySampled.error, null);
  const secondPayload = buildThermalHandoffFromSixMos(differentlySampled, motor, 500, 25);
  if (!secondPayload) throw new Error('Expected a second fixed-condition payload.');
  const second = simulateFoc6MosSteadyState({
    model: DEFAULT_FOC_MODEL,
    mos: {
      rdsOn25Mohm: 5,
      rdsDataConfirmed: true,
      tempCoeffAlphaPerC: 0.0045,
      vsdV: 0.85,
      eonPlusEoffUj: 12,
      vRefV: secondPayload.vBusConstV,
      iRefA: 3,
      qrrNc: 0,
      eonIncludesQrr: true,
      eossAlreadyIncludedInEsw: true,
    },
    ctrl: {
      modulation: secondPayload.modulation ?? 'SVPWM',
      fswHz: secondPayload.fswKhz * 1000,
      tDeadNs: secondPayload.tDeadNs,
      modDepthM: secondPayload.modDepthM,
      pfAngleDeg: secondPayload.pfAngleDeg,
      tAmbC: secondPayload.tAmbC,
      vBusConstV: secondPayload.vBusConstV,
    },
    operatingPoint: secondPayload.steadyOperatingPoint,
    integrationSamples: 1440,
  });
  assert.ok(Math.abs(second.pInverterTotalW - result.pInverterTotalW) < 1e-9);
  assert.ok(Math.abs(second.tjMaxSteadyC - result.tjMaxSteadyC) < 1e-7);
});
