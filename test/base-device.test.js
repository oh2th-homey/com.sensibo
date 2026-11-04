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
// Lab Sky Plus, remote limited to stopped / full range swings
const labLimitedRemote = require('../samples/pods/skyplus-celsius-climate-react-resaved.json');

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

test('a Climate React rule reads the configuration and posts it back changed', async () => {
  const sensibo = createClient();
  sensibo.request = async (action, method, url, body) => {
    sensibo.requests.push({ method, path: url.split('?')[0].replace(sensibo.getUri(), ''), body });
    if (method === 'GET') {
      return {
        status: 'success',
        result: {
          enabled: true,
          type: 'temperature',
          lowTemperatureThreshold: 24.44,
          highTemperatureThreshold: 24.44,
          lowTemperatureState: {
            on: true, mode: 'cool', targetTemperature: 86, temperatureUnit: 'F'
          },
          highTemperatureState: {
            on: true, mode: 'cool', targetTemperature: 62, temperatureUnit: 'F'
          }
        }
      };
    }
    return { status: 'success' };
  };
  const device = createDevice(sensibo, {});
  device.clearCheckData = () => {};
  device.scheduleCheckData = () => {};
  await device.onActionSetClimateReactRule('high', {
    type: 'temperature', threshold: 79, on: 'on', mode: { id: 'nop' }, fanLevel: { id: 'auto' }, swing: { id: 'nop' }, horizontalSwing: { id: 'nop' }, targetTemperature: 62
  });
  assert.strictEqual(sensibo.requests.length, 2);
  const post = sensibo.requests[1];
  assert.strictEqual(post.method, 'POST');
  assert.strictEqual(post.path, '/pods/pod/smartmode');
  assert.strictEqual(post.body.highTemperatureThreshold, 26.11);
  assert.strictEqual(post.body.lowTemperatureThreshold, 24.44);
  assert.deepStrictEqual(post.body.highTemperatureState, {
    on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 62, temperatureUnit: 'F'
  });
});

test('a Climate React rule on an unconfigured device fails with a readable message', async () => {
  const sensibo = createClient();
  sensibo.request = async () => ({ status: 'success', result: null });
  const device = createDevice(sensibo, {});
  device.clearCheckData = () => {};
  device.scheduleCheckData = () => {};
  device.homey.__ = (key) => key;
  await assert.rejects(
    device.onActionSetClimateReactRule('low', {
      type: 'temperature', threshold: 20, on: 'off', targetTemperature: 20
    }),
    { message: 'errors.climate_react_not_configured' }
  );
  assert.deepStrictEqual(device.unavailableErrors, []);
});

test('Climate React settings from the shared poll reach the device, null as not configured', async () => {
  for (const [smartMode, expected] of [[{ enabled: true, type: 'temperature' }, { enabled: true, type: 'temperature' }], [null, {}]]) {
    const device = createDevice(createClient(), {});
    device.getData = () => ({ id: 'pod' });
    device.hasCapability = () => false;
    device.updateIfChanged = async () => false;
    const received = [];
    device.onClimateReactSettingsReceived = async (data) => received.push(data);
    await device.onDeviceInfoReceived({ id: 'pod', smartMode });
    assert.deepStrictEqual(received, [{ result: expected }]);
  }
});

test('device info without smartMode leaves Climate React alone', async () => {
  const device = createDevice(createClient(), {});
  device.getData = () => ({ id: 'pod' });
  device.hasCapability = () => false;
  const received = [];
  device.onClimateReactSettingsReceived = async (data) => received.push(data);
  await device.onDeviceInfoReceived({ id: 'pod' });
  assert.deepStrictEqual(received, []);
});

test('Climate React rule cards offer what the remote supports, first the unchanged option', async () => {
  // Lab Sky Plus with a remote limited to stopped / full range swings
  const { remoteCapabilities } = labLimitedRemote.result;
  const sensibo = createClient();
  sensibo._remoteCapabilities = remoteCapabilities;
  const device = createDevice(sensibo, {});
  device.homey.__ = () => '- Unchanged -';
  const ids = async (autocomplete, query = '') => (await device.withUnchangedOption(query, autocomplete.call(device, query, {}))).map((item) => item.id);

  assert.deepStrictEqual(await ids(device.onModeAutocomplete), ['nop', 'cool', 'heat', 'fan', 'dry', 'auto']);
  assert.deepStrictEqual(await ids(device.onFanLevelAutocomplete), ['nop', 'quiet', 'low', 'medium_low', 'medium', 'high', 'auto']);
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete), ['nop', 'stopped', 'rangeFull']);
  assert.deepStrictEqual(await ids(device.onHorizontalSwingAutocomplete), ['nop', 'stopped', 'rangeFull']);
  // Typing filters the list, the unchanged option only shows when it matches
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete, 'range'), ['rangeFull']);
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete, 'unch'), ['nop']);
});
