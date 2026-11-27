import type { RdsOnTempCurve } from './focThermal';

/**
 * Datasheet-backed common-device preset for the six identical inverter MOSFETs.
 *
 * IMPORTANT:
 * - The datasheet supplies no Eon/Eoff energy table for BUK7Q6R0-40H. Do not
 *   derive switching energy from td(on)/tr/td(off)/tf.
 * - Nexperia's Qr definition includes capacitive recovery (Qr = Qs + Qoss).
 *   The scalar model therefore must not add a separate Eoss on top of this Qr
 *   unless an independently validated per-event energy ledger is used.
 * - Fig. 12 is a plotted typical curve. Points away from the explicit table
 *   anchors are approximate graph digitization, not guaranteed limits.
 */
export const BUK7Q6R0_40H_PROFILE = {
  manufacturer: 'Nexperia',
  partNumber: 'BUK7Q6R0-40H',
  package: 'MLPAK33-WF (SOT8002-3D)',
  datasheetDate: '2025-05-07',
  absoluteLimits: {
    vdsMaxV: 40,
    vgsAbsMaxV: 20,
    tjMaxC: 175,
  },
  rdsOn: {
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    testDrainCurrentA: 20,
    minMohm: 3.5,
    typicalMohm: 5,
    maxMohm: 6,
    tableAnchors: [
      { tjC: 25, typicalMohm: 5.0, normalized: 1.0 },
      { tjC: 105, typicalMohm: 6.8, normalized: 1.36 },
      { tjC: 125, typicalMohm: 7.3, normalized: 1.46 },
    ],
  },
  rdsOnTempCurve: {
    schema: 'wave-test-rdson-temperature',
    schemaVersion: 1,
    referenceTemperatureC: 25,
    referenceGateVoltageV: 10,
    provenance: 'datasheet',
    label: 'BUK7Q6R0-40H Fig.12 typical curve; graph-digitized approximation with table anchors',
    manufacturer: 'Nexperia',
    partNumber: 'BUK7Q6R0-40H',
    sourceNote:
      'Datasheet Table 7 exact typical anchors: 25°C=5.0mΩ, 105°C=6.8mΩ, 125°C=7.3mΩ at VGS=10V, ID=20A. Other normalized points are approximate digitization of Fig.12 typical curve. Do not treat graph-digitized points as guaranteed min/max values.',
    points: [
      { tjC: -55, ratioTo25C: 0.76 },
      { tjC: -30, ratioTo25C: 0.84 },
      { tjC: 0, ratioTo25C: 0.93 },
      { tjC: 25, ratioTo25C: 1.0 },
      { tjC: 60, ratioTo25C: 1.17 },
      { tjC: 90, ratioTo25C: 1.31 },
      { tjC: 105, ratioTo25C: 1.36 },
      { tjC: 125, ratioTo25C: 1.46 },
      { tjC: 150, ratioTo25C: 1.72 },
      { tjC: 175, ratioTo25C: 1.90 },
    ],
  } satisfies RdsOnTempCurve & { sourceNote: string },
  bodyDiode: {
    vsdTypicalV: 0.8,
    vsdMaxV: 1.2,
    testCurrentA: 20,
    testGateVoltageV: 0,
    testJunctionTemperatureC: 25,
  },
  recoveredCharge: {
    qrNc: 13,
    referenceCurrentA: 16,
    testVdsV: 20,
    testDiDtAperUs: -100,
    testGateVoltageV: 0,
    testJunctionTemperatureC: 25,
    includesCapacitiveRecovery: true,
  },
  capacitance: {
    cossTypicalPfAt25V: 386,
    testGateVoltageV: 0,
    testFrequencyHz: 1_000_000,
    testJunctionTemperatureC: 25,
    curveFigure: 'Fig.15',
    numericEossTableAvailable: false,
  },
  gateCharge: {
    qgTypicalNc: 22,
    qgMaxNc: 31,
    testCurrentA: 20,
    testVdsV: 20,
    testVgsV: 10,
    testJunctionTemperatureC: 25,
  },
  thermal: {
    rthJunctionToMountingBaseTypicalCPerW: 1.92,
    rthJunctionToMountingBaseMaxCPerW: 2.3,
    rthJunctionToAmbientMaxCPerW: 40,
    rthJunctionToAmbientBoard: "4-layer PCB; not the user's actual PCB thermal path",
  },
  switchingEnergy: {
    eonUj: null as number | null,
    eoffUj: null as number | null,
    reason: 'The product datasheet gives switching time parameters, not Eon/Eoff energy values. Obtain DPT energy at the real Vbus, current, Tj, Rg_on and Rg_off.',
  },
} as const;

export function createBuk7Q6R0_40HRdsCurve(): RdsOnTempCurve {
  return {
    ...BUK7Q6R0_40H_PROFILE.rdsOnTempCurve,
    points: BUK7Q6R0_40H_PROFILE.rdsOnTempCurve.points.map((point) => ({ ...point })),
  };
}

export function createBuk7Q6R0_40HRdsCurveJson(): string {
  return JSON.stringify(createBuk7Q6R0_40HRdsCurve(), null, 2);
}
