/**
 * FOC DynoLab V2 - Deterministic 13.5V / 30W Demo Datasets & Motor Baseline Parameters
 */

import {
  MotorParams,
  calcKeFromNoLoad,
  calcKsat,
  calcOmegaM,
  calcP0LossW,
  calcRsAnchorOhm,
} from './motorPhysics';
import { TabularDataset, parseCsvText } from './dynoCalibrator';

export const DEMO_MOTOR_PARAMS: MotorParams = {
  polePairs: 7,
  kePrime: calcKeFromNoLoad(13.5, 1450),
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
  rdsOnMOhm: 12.0,
  tDeadNs: 450,
  fSwKhz: 20,
  vSdV: 0.85,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solveTrueIqForTorque(
  tShaftNm: number,
  nRpm: number,
  kePrime: number,
  betaTrue: number,
  p0A: number,
  p0B: number
): number {
  const omegaM = calcOmegaM(nRpm);
  const p0 = calcP0LossW(nRpm, p0A, p0B);
  const tEm = tShaftNm + (omegaM > 1e-6 ? p0 / omegaM : 0);
  let iq = tEm / (1.5 * kePrime);
  for (let k = 0; k < 20; k++) {
    const ksat = calcKsat(iq, betaTrue);
    iq = tEm / Math.max(1e-6, 1.5 * kePrime * ksat);
  }
  return iq;
}

export function buildDemoOpenLoopDataset(): TabularDataset {
  const rand = mulberry32(13530);
  const speeds = [300, 450, 600, 750, 900, 1050, 1200, 1350, 1450];
  const keTrue = DEMO_MOTOR_PARAMS.kePrime;
  const rsTrue = calcRsAnchorOhm(DEMO_MOTOR_PARAMS.rLL25Ohm, DEMO_MOTOR_PARAMS.tCoilC);
  const lines = ['n_rpm,T_Nm,V_bus,I_bus,P_in,P_out,eta'];

  for (const n of speeds) {
    const omegaM = calcOmegaM(n);
    const vTest = (n / 1450) * 13.5;
    const eq = keTrue * omegaM;
    const p0 = calcP0LossW(n, 5.2e-4, 4.8e-7);
    const iq0 = omegaM > 1e-6 ? p0 / (1.5 * eq) : 0;
    const pElec = 1.5 * (eq * iq0 + rsTrue * iq0 * iq0);
    const iBusTrue = DEMO_MOTOR_PARAMS.iIdleA + pElec / (DEMO_MOTOR_PARAMS.etaInv * Math.max(1.5, vTest));
    const noiseI = (rand() - 0.5) * 0.008;
    const iMeas = Math.max(0.03, iBusTrue + noiseI);
    const vMeas = vTest + iMeas * DEMO_MOTOR_PARAMS.rLineOhm;
    const pIn = vMeas * iMeas;
    lines.push(`${n},0,${vMeas.toFixed(3)},${iMeas.toFixed(4)},${pIn.toFixed(4)},0,0`);
  }

  return parseCsvText(lines.join('\n'), 'demo_open_loop_13V5_30W.csv');
}

export function buildDemoClosedLoopDataset(): TabularDataset {
  const rand = mulberry32(202611);
  const keTrue = DEMO_MOTOR_PARAMS.kePrime;
  const rsTrue = calcRsAnchorOhm(DEMO_MOTOR_PARAMS.rLL25Ohm, DEMO_MOTOR_PARAMS.tCoilC);
  const betaTrue = 0.0065;
  const p0A = 5.2e-4;
  const p0B = 4.8e-7;

  const speedGrid = [300, 500, 750, 1000, 1200, 1350];
  const torqueGrid = [0.03, 0.06, 0.1, 0.15, 0.21, 0.27];
  const lines = ['n_rpm,T_Nm,V_bus,I_bus,P_in,P_out,eta'];

  for (const n of speedGrid) {
    const omegaM = calcOmegaM(n);
    const eq = keTrue * omegaM;
    for (const tTarget of torqueGrid) {
      if (n >= 1350 && tTarget > 0.16) continue;
      if (n >= 1200 && tTarget > 0.21) continue;

      const iq = solveTrueIqForTorque(tTarget, n, keTrue, betaTrue, p0A, p0B);
      const pElec = 1.5 * (eq * iq + rsTrue * iq * iq);
      const vBusCap = 13.5 - 0.04 * (pElec / (13.5 * 0.95));
      const iBusTrue = DEMO_MOTOR_PARAMS.iIdleA + pElec / (DEMO_MOTOR_PARAMS.etaInv * vBusCap);
      const vMeasTrue = vBusCap + iBusTrue * DEMO_MOTOR_PARAMS.rLineOhm;

      const tMeas = tTarget * (1 + (rand() - 0.5) * 0.022);
      const iMeas = iBusTrue * (1 + (rand() - 0.5) * 0.018);
      const vMeas = vMeasTrue + (rand() - 0.5) * 0.03;
      const pIn = vMeas * iMeas;
      const pOut = tMeas * omegaM;
      const eta = pOut / pIn;

      lines.push(
        `${n},${tMeas.toFixed(4)},${vMeas.toFixed(3)},${iMeas.toFixed(4)},${pIn.toFixed(4)},${pOut.toFixed(4)},${eta.toFixed(4)}`
      );
    }
  }

  return parseCsvText(lines.join('\n'), 'demo_closed_loop_13V5_30W.csv');
}

export interface RawRuntimeLogEntry {
  timeS: number;
  vMeasV: number;
  iBusA: number;
  nRpm: number;
}

export function buildDemoRuntimeLog(): RawRuntimeLogEntry[] {
  const rand = mulberry32(9901);
  const dt = 0.002;
  const total = 1200;
  const rows: RawRuntimeLogEntry[] = [];
  const keTrue = DEMO_MOTOR_PARAMS.kePrime;
  const rsTrue = calcRsAnchorOhm(DEMO_MOTOR_PARAMS.rLL25Ohm, DEMO_MOTOR_PARAMS.tCoilC);
  const betaTrue = DEMO_MOTOR_PARAMS.betaSat;

  for (let i = 0; i < total; i++) {
    const t = i * dt;
    let nRpm = 0;
    let iqCmd = 0;
    let forceZeroDrift = false;

    if (t < 0.35) {
      nRpm = 1000;
      forceZeroDrift = true;
    } else if (t < 0.9) {
      nRpm = 1000;
      iqCmd = 1.44;
    } else if (t < 1.35) {
      nRpm = 950;
      iqCmd = 3.55;
    } else if (t < 1.75) {
      nRpm = 1380;
      iqCmd = 2.05;
    } else if (t < 2.1) {
      nRpm = 1100;
      iqCmd = -1.1;
    } else {
      nRpm = 18;
      iqCmd = 2.4;
    }

    let iBus: number;
    let vMeas: number;

    if (forceZeroDrift) {
      iBus = 0.052 + (rand() - 0.5) * 0.018;
      vMeas = 13.52 + (rand() - 0.5) * 0.02;
    } else {
      const omegaM = calcOmegaM(nRpm);
      const eq = keTrue * omegaM;
      const pElec = 1.5 * (eq * iqCmd + rsTrue * iqCmd * iqCmd);
      const pDc = pElec >= 0 ? pElec / DEMO_MOTOR_PARAMS.etaInv : pElec * DEMO_MOTOR_PARAMS.etaInv;
      const vCap = 13.5;
      const iBusTrue = DEMO_MOTOR_PARAMS.iIdleA + pDc / vCap;
      const ripple = 0.08 * Math.sin(2 * Math.PI * 140 * t);
      iBus = iBusTrue + ripple + (rand() - 0.5) * 0.06;
      vMeas = vCap + iBus * DEMO_MOTOR_PARAMS.rLineOhm + (rand() - 0.5) * 0.04;
      void calcKsat(iqCmd, betaTrue);
    }

    rows.push({
      timeS: Number(t.toFixed(4)),
      vMeasV: Number(vMeas.toFixed(4)),
      iBusA: Number(iBus.toFixed(4)),
      nRpm: Number(nRpm.toFixed(1)),
    });
  }

  return rows;
}
