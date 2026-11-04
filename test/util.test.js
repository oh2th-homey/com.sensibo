'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { batteryPercent, roomSensorName, roomSensorState } = require('../lib/util');
// Lab Room Sensor before and after it was given a name in the Sensibo app
const unnamedSample = require('../samples/pods/skyplus-primary-sensor-1-off.json');
const primarySample = require('../samples/pods/skyplus-primary-sensor-2-on.json');
const namedSample = require('../samples/pods/skyplus-primary-sensor-3-on-named.json');
const offAgainSample = require('../samples/pods/skyplus-primary-sensor-4-off-again.json');

test('Room Sensor battery level follows its voltage from full to empty', () => {
  const levels = [[3000, 100], [2750, 75], [2500, 50], [2250, 25], [2000, 0]];
  for (const [voltage, percent] of levels) {
    assert.strictEqual(batteryPercent(voltage), percent, `${voltage} mV`);
  }
});

test('Room Sensor battery level stays within 0-100 %', () => {
  assert.strictEqual(batteryPercent(3200), 100);
  assert.strictEqual(batteryPercent(1500), 0);
});

test('Room Sensor battery level drops as the voltage drops', () => {
  let previous = batteryPercent(3000);
  for (let voltage = 2990; voltage >= 2000; voltage -= 10) {
    const percent = batteryPercent(voltage);
    assert.ok(percent <= previous, `${voltage} mV: ${percent} % after ${previous} %`);
    previous = percent;
  }
});

test('a Room Sensor is named as the Sensibo app shows it', () => {
  const named = namedSample.result.motionSensors[0];
  const unnamed = unnamedSample.result.motionSensors[0];
  assert.strictEqual(roomSensorName(named, 'fallback'), 'Room Sensor for lab');
  assert.strictEqual(roomSensorName(unnamed, 'fallback'), 'qwertyuiop');
  assert.strictEqual(roomSensorName({ name: '  ', qrId: 'QR' }, 'fallback'), 'QR');
  assert.strictEqual(roomSensorName({ name: null, qrId: null }, 'fallback'), 'fallback');
});

test('the primary Room Sensor is read from mainMeasurementsSensor', () => {
  // Lab Sky Plus: Room Sensor not primary, primary without and with a fresh reading, back to the built-in sensor
  assert.deepStrictEqual(roomSensorState(unnamedSample.result), { hasRoomSensor: true, inUse: false, measurements: undefined });
  for (const sample of [primarySample, namedSample]) {
    const state = roomSensorState(sample.result);
    assert.strictEqual(state.inUse, true);
    assert.strictEqual(state.measurements, sample.result.mainMeasurementsSensor.measurements);
  }
  assert.deepStrictEqual(roomSensorState(offAgainSample.result), { hasRoomSensor: true, inUse: false, measurements: undefined });
});

test('room sensors are only judged when the response lists them', () => {
  assert.strictEqual(roomSensorState({ measurements: { temperature: 20 } }), undefined);
  assert.deepStrictEqual(roomSensorState({ motionSensors: [], mainMeasurementsSensor: null }), { hasRoomSensor: false, inUse: false, measurements: undefined });
});
