'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const Sensibo = require('../lib/sensibo');

// BaseDevice extends Homey.Device, which only exists inside the Homey runtime: load it with a stub
const originalLoad = Module._load;
Module._load = function loadWithHomeyStub(request, ...args) {
  if (request === 'homey') {
    return { Device: class {} };
  }
  return originalLoad.call(this, request, ...args);
};
const BaseDevice = require('../drivers/BaseDevice');

Module._load = originalLoad;

// Sensibo client with the HTTP request stubbed, records what would be sent
const createClient = () => {
  const sensibo = new Sensibo({
    homey: {}, apikey: 'key', deviceId: 'pod', logger: () => {}
  });
  sensibo.requests = [];
  sensibo.request = async (action, method, url, body) => {
    sensibo.requests.push({ method, path: url.split('?')[0].replace(sensibo.getUri(), ''), body });
  };
  // Polled state of a Fahrenheit device, setpoint already converted to Celsius by onDeviceInfoReceived
  sensibo.updateAcState({
    on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 22, temperatureUnit: 'F'
  });
  return sensibo;
};

// Device with a queued batch, without running onInit()
const createDevice = (sensibo, patch) => {
  const device = Object.create(BaseDevice.prototype);
  device.log = () => {};
  device.homey = { clearTimeout: () => {} };
  device._sensibo = sensibo;
  device._pendingAcStatePatch = patch;
  device._acStateBatchResolvers = [];
  device._acStateBatchRejectors = [];
  device.unavailableErrors = [];
  device.ensureDeviceAvailable = async () => {};
  device.setUnavailableFromApiError = async (err) => {
    device.unavailableErrors.push(err);
  };
  return device;
};

test('a batch with one changed setting is sent as one PATCH without cached values', async () => {
  for (const [property, value] of [['on', false], ['fanLevel', 'high']]) {
    const sensibo = createClient();
    await createDevice(sensibo, { [property]: value }).flushAcStateBatch();
    assert.deepStrictEqual(sensibo.requests, [{ method: 'PATCH', path: `/pods/pod/acStates/${property}`, body: { newValue: value } }]);
  }
});

test('a batch with several changed settings is sent as one full-state POST', async () => {
  const sensibo = createClient();
  await createDevice(sensibo, { on: false, fanLevel: 'high' }).flushAcStateBatch();
  assert.deepStrictEqual(sensibo.requests, [
    {
      method: 'POST',
      path: '/pods/pod/acStates',
      body: {
        acState: {
          on: false, mode: 'cool', fanLevel: 'high', targetTemperature: 72, temperatureUnit: 'F'
        }
      }
    }
  ]);
});

test('an empty batch sends nothing', async () => {
  const sensibo = createClient();
  await createDevice(sensibo, {}).flushAcStateBatch();
  assert.deepStrictEqual(sensibo.requests, []);
});

test('a failed batch marks the device unavailable and still resolves its callers', async () => {
  const sensibo = createClient();
  sensibo.request = async () => {
    throw new Error('API down');
  };
  const device = createDevice(sensibo, { on: false });
  let resolved = false;
  device._acStateBatchResolvers.push(() => {
    resolved = true;
  });
  await device.flushAcStateBatch();
  assert.strictEqual(device.unavailableErrors.length, 1);
  assert.strictEqual(resolved, true);
});
