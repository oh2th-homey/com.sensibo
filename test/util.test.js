'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  batteryPercent, roomSensorName, roomSensorState, toCelsius, toFahrenheit, getModes, getFanLevels, getAllFanLevels, getSwings, getAllSwings,
  getHorizontalSwings, getAllHorizontalSwings, getAllLights, redactApiKey, maskApiKey, arraysEqualIgnoreOrder
} = require('../lib/util');
// Lab Room Sensor before and after it was given a name in the Sensibo app
const unnamedSample = require('../samples/pods/skyplus-primary-sensor-1-off.json');
const primarySample = require('../samples/pods/skyplus-primary-sensor-2-on.json');
const namedSample = require('../samples/pods/skyplus-primary-sensor-3-on-named.json');
const offAgainSample = require('../samples/pods/skyplus-primary-sensor-4-off-again.json');
const noClimateReactSample = require('../samples/pods/skyplus-celsius-no-climate-react.json');

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
  // Lab Sensibo Air: Room Sensor not primary, primary without and with a fresh reading, back to the built-in sensor
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

// Lab Sensibo Air remote: per mode, the target temperatures Sensibo offers in Fahrenheit and Celsius, index by index
const { remoteCapabilities } = noClimateReactSample.result;

test('the °C/°F tables match the setpoints Sensibo lists for the remote', () => {
  const { F, C } = remoteCapabilities.modes.cool.temperatures;
  assert.strictEqual(F.values.length, C.values.length);
  F.values.forEach((fahrenheit, i) => {
    assert.strictEqual(toCelsius(fahrenheit), C.values[i], `${fahrenheit} °F`);
    assert.strictEqual(toFahrenheit(C.values[i]), fahrenheit, `${C.values[i]} °C`);
  });
});

test('°C/°F outside the tables use the formula, rounded to whole degrees', () => {
  assert.strictEqual(toFahrenheit(5), 41);
  assert.strictEqual(toFahrenheit(35), 95);
  assert.strictEqual(toCelsius(41), 5);
  assert.strictEqual(toCelsius(95), 35);
  // Decimals are rounded before the table lookup
  assert.strictEqual(toFahrenheit(21.4), 70);
  assert.strictEqual(toCelsius(71.6), 22);
});

test('remote capability lookups list what the remote supports', () => {
  assert.deepStrictEqual(getModes(remoteCapabilities), ['cool', 'heat', 'fan', 'dry', 'auto']);
  assert.deepStrictEqual(getFanLevels(remoteCapabilities, 'heat'), ['quiet', 'low', 'medium_low', 'medium', 'high', 'auto']);
  // Dry and auto have no fan levels on this remote
  assert.strictEqual(getFanLevels(remoteCapabilities, 'dry'), undefined);
  assert.deepStrictEqual(getAllFanLevels(remoteCapabilities), ['quiet', 'low', 'medium_low', 'medium', 'high', 'auto']);
  assert.deepStrictEqual(getSwings(remoteCapabilities, 'fan'), ['stopped', 'rangeFull']);
  assert.deepStrictEqual(getAllSwings(remoteCapabilities), ['stopped', 'rangeFull']);
  assert.deepStrictEqual(getHorizontalSwings(remoteCapabilities, 'cool'), ['stopped', 'rangeFull']);
  assert.deepStrictEqual(getAllHorizontalSwings(remoteCapabilities), ['stopped', 'rangeFull']);
  // No light control on this remote
  assert.strictEqual(getAllLights(remoteCapabilities), undefined);
});

test('remote capability lookups cope with missing data', () => {
  for (const lookup of [getModes, getAllFanLevels, getAllSwings, getAllHorizontalSwings, getAllLights]) {
    assert.strictEqual(lookup(undefined), undefined, lookup.name);
    assert.strictEqual(lookup({}), undefined, lookup.name);
  }
  assert.strictEqual(getFanLevels(remoteCapabilities, undefined), undefined);
  assert.strictEqual(getFanLevels(remoteCapabilities, 'turbo'), undefined);
  assert.strictEqual(getAllFanLevels({ modes: { fan: {} } }), undefined);
});

test('API keys are hidden in logs', () => {
  assert.strictEqual(redactApiKey('https://home.sensibo.com/api/v2/pods/x?fields=*&apiKey=SECRET123'), 'https://home.sensibo.com/api/v2/pods/x?fields=*&apiKey=***');
  assert.strictEqual(redactApiKey('https://x/?apiKey=A&b=1&apiKey=B'), 'https://x/?apiKey=***&b=1&apiKey=***');
  assert.strictEqual(redactApiKey(undefined), undefined);
  assert.strictEqual(maskApiKey('SECRET123'), 'SECR***');
  assert.strictEqual(maskApiKey('abcd'), '***');
  assert.strictEqual(maskApiKey(null), '***');
});

test('arrays compare equal in any order', () => {
  assert.strictEqual(arraysEqualIgnoreOrder(['a', 'b'], ['b', 'a']), true);
  assert.strictEqual(arraysEqualIgnoreOrder(['a', 'b'], ['a']), false);
  assert.strictEqual(arraysEqualIgnoreOrder(['a', 'b'], ['a', 'c']), false);
  assert.strictEqual(arraysEqualIgnoreOrder([], []), true);
});
