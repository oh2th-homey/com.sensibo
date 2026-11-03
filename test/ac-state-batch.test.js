'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const Sensibo = require('../lib/sensibo');

const originalLoad = Module._load;
Module._load = function loadWithHomeyStub(request, parent, isMain) {
  if (request === 'homey') return { Device: class Device {} };
  return originalLoad.call(this, request, parent, isMain);
};
const BaseDevice = require('../drivers/BaseDevice');
Module._load = originalLoad;

const deviceWithCalls = () => {
  const sensibo = new Sensibo({ logger: () => {} });
  const calls = [];
  sensibo.request = async (action, method, url, body) => calls.push({ action, method, url, body });
  return { sensibo, calls };
};
const makeDevice = (sensibo, patch) => {
  const device = Object.create(BaseDevice.prototype);
  device.log = () => {};
  device._sensibo = sensibo;
  device._pendingAcStatePatch = patch;
  device._acStateBatchResolvers = [];
  device._acStateBatchRejectors = [];
  device.homey = { clearTimeout() {} };
  device.ensureDeviceAvailable = async () => {};
  return device;
};

test('first Fahrenheit poll stores the setpoint in Fahrenheit', () => {
  const sensibo = new Sensibo({ logger: () => {} });
  sensibo.updateAcState({ targetTemperature: 22, temperatureUnit: 'F' });
  assert.deepEqual(sensibo.getAcState(), { temperatureUnit: 'F', targetTemperature: 72 });
});

test('power-only and fan-only updates PATCH only their changed property', async () => {
  for (const [property, value] of [['on', false], ['fanLevel', 'high']]) {
    const { sensibo, calls } = deviceWithCalls();
    sensibo._deviceId = 'pod-id';
    sensibo._apikey = 'api-key';
    sensibo.updateAcState({ on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 72, temperatureUnit: 'F' });
    await makeDevice(sensibo, { [property]: value }).flushAcStateBatch();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, new RegExp(`/acStates/${property}\\?`));
    assert.deepEqual(calls[0].body, { newValue: value });
  }
});

test('batched multi-setting change uses one full-state POST', async () => {
  const { sensibo, calls } = deviceWithCalls();
  sensibo._deviceId = 'pod-id';
  sensibo._apikey = 'api-key';
  sensibo.updateAcState({ on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 22, temperatureUnit: 'F' });
  await makeDevice(sensibo, { on: false, fanLevel: 'high' }).flushAcStateBatch();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/acStates\?/);
  assert.deepEqual(calls[0].body, {
    acState: { on: false, mode: 'cool', fanLevel: 'high', targetTemperature: 72, temperatureUnit: 'F' }
  });
});

test('Fahrenheit target temperature PATCH converts Celsius input', async () => {
  const { sensibo, calls } = deviceWithCalls();
  sensibo._deviceId = 'pod-id';
  sensibo._apikey = 'api-key';
  sensibo.updateAcState({ temperatureUnit: 'F' });
  await sensibo.setAcProperty('targetTemperature', 22);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/acStates\/targetTemperature\?/);
  assert.deepEqual(calls[0].body, { newValue: 72 });
  assert.equal(sensibo.getAcState().targetTemperature, 72);
});
