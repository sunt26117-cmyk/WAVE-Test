import test from 'node:test';
import assert from 'node:assert/strict';
import { BUK7Q6R0_40H_PROFILE, createBuk7Q6R0_40HRdsCurve } from './focMosDeviceProfiles';
import { validateRdsOnTempCurve } from './focThermal';

test('BUK7Q6R0-40H profile uses the datasheet Rds/Rth/Qr reference conditions', () => {
  assert.equal(BUK7Q6R0_40H_PROFILE.rdsOn.typicalMohm, 5);
  assert.equal(BUK7Q6R0_40H_PROFILE.rdsOn.referenceGateVoltageV, 10);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.qrNc, 13);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.referenceCurrentA, 16);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.testVdsV, 20);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.testDiDtAperUs, -100);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.testGateVoltageV, 0);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.testJunctionTemperatureC, 25);
  assert.equal(BUK7Q6R0_40H_PROFILE.recoveredCharge.includesCapacitiveRecovery, true);
  assert.equal(BUK7Q6R0_40H_PROFILE.switchingEnergy.eonUj, null);
  assert.equal(BUK7Q6R0_40H_PROFILE.switchingEnergy.eoffUj, null);
  assert.equal(BUK7Q6R0_40H_PROFILE.thermal.rthJunctionToMountingBaseMaxCPerW, 2.3);
});

test('BUK7Q6R0-40H datasheet Rds temperature curve includes 25C anchor and tabulated 105/125C ratios', () => {
  const curve = createBuk7Q6R0_40HRdsCurve();
  validateRdsOnTempCurve(curve);
  const get = (tjC: number) => curve.points.find((point) => point.tjC === tjC)?.ratioTo25C;
  assert.equal(get(25), 1);
  assert.equal(get(105), 1.36);
  assert.equal(get(125), 1.46);
  assert.match(curve.sourceNote ?? '', /approximate digitization/i);
});
