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
const { translate } = require('./i18n');
// Lab Sensibo Air, remote limited to stopped / full range swings
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
  device.homey = { clearTimeout: () => {}, __: translate };
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
  await assert.rejects(
    device.onActionSetClimateReactRule('low', {
      type: 'temperature', threshold: 20, on: 'off', targetTemperature: 20
    }),
    { message: translate('errors.climate_react_not_configured') }
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
  // Lab Sensibo Air with a remote limited to stopped / full range swings
  const { remoteCapabilities } = labLimitedRemote.result;
  const sensibo = createClient();
  sensibo._remoteCapabilities = remoteCapabilities;
  const device = createDevice(sensibo, {});
  const ids = async (autocomplete, query = '') => (await device.withUnchangedOption(query, autocomplete.call(device, query, {}))).map((item) => item.id);

  assert.deepStrictEqual(await ids(device.onModeAutocomplete), ['nop', 'cool', 'heat', 'fan', 'dry', 'auto']);
  assert.deepStrictEqual(await ids(device.onFanLevelAutocomplete), ['nop', 'quiet', 'low', 'medium_low', 'medium', 'high', 'auto']);
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete), ['nop', 'stopped', 'rangeFull']);
  assert.deepStrictEqual(await ids(device.onHorizontalSwingAutocomplete), ['nop', 'stopped', 'rangeFull']);
  // Typing filters the list, the unchanged option only shows when it matches
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete, 'range'), ['rangeFull']);
  assert.deepStrictEqual(await ids(device.onSwingAutocomplete, 'unch'), ['nop']);
});

// AC device that records capability changes, for the device info handler
const createInfoDevice = (capabilities) => {
  const device = createDevice(createClient(), {});
  const caps = new Map(capabilities.map((cap) => [cap, null]));
  device.getData = () => ({ id: 'pod' });
  device.homey.clock = { getTimezone: () => 'UTC' };
  device.getSettings = () => ({});
  device.hasCapability = (cap) => caps.has(cap);
  device.addCapability = async (cap) => caps.set(cap, null);
  device.removeCapability = async (cap) => caps.delete(cap);
  device.updateIfChanged = async (cap, value) => {
    if (caps.has(cap) && value !== undefined) caps.set(cap, value);
  };
  device.caps = caps;
  return device;
};

test('an AC shows its primary Room Sensor and goes back to its own sensor', async () => {
  const device = createInfoDevice(['measure_temperature', 'measure_humidity']);
  const steps = [
    ['skyplus-primary-sensor-1-off', false, 22.8, 40.3],
    ['skyplus-primary-sensor-3-on-named', true, 22.0, 42.0],
    ['skyplus-primary-sensor-4-off-again', false, 22.8, 40.3]
  ];
  for (const [sample, inUse, temperature, humidity] of steps) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { result } = require(`../samples/pods/${sample}.json`);
    await device.onDeviceInfoReceived(JSON.parse(JSON.stringify(result)));
    assert.strictEqual(device.caps.get('se_use_roomsensor'), inUse, sample);
    assert.strictEqual(device.caps.get('measure_temperature'), temperature, sample);
    assert.strictEqual(device.caps.get('measure_humidity'), humidity, sample);
  }
});

test('Use Room Sensor is removed when the AC no longer has a Room Sensor', async () => {
  const device = createInfoDevice(['measure_temperature', 'se_use_roomsensor']);
  await device.onDeviceInfoReceived({ motionSensors: [], mainMeasurementsSensor: null, measurements: { temperature: 21 } });
  assert.strictEqual(device.hasCapability('se_use_roomsensor'), false);
  assert.strictEqual(device.caps.get('measure_temperature'), 21);
});

test('devices whose info lists no room sensors keep Use Room Sensor away', async () => {
  // Room Sensor devices themselves, and responses without motionSensors
  const device = createInfoDevice(['measure_temperature']);
  await device.onDeviceInfoReceived({ productModel: 'motion_sensor', measurements: { temperature: 22.1, humidity: 42 } });
  assert.strictEqual(device.hasCapability('se_use_roomsensor'), false);
  assert.strictEqual(device.caps.get('measure_temperature'), 22.1);
});

test('Flow dropdowns name AC values in the user language', async () => {
  const sensibo = createClient();
  sensibo._remoteCapabilities = labLimitedRemote.result.remoteCapabilities;
  const device = createDevice(sensibo, {});
  assert.deepStrictEqual(await device.onModeAutocomplete('', {}), [
    { id: 'cool', name: 'Cool' }, { id: 'heat', name: 'Heat' }, { id: 'fan', name: 'Fan Only' }, { id: 'dry', name: 'Dry' }, { id: 'auto', name: 'Automatic' }
  ]);
  assert.deepStrictEqual(await device.onSwingAutocomplete('full', {}), [{ id: 'rangeFull', name: translate('swing.rangeFull') }]);
  // A value without a translation gets a readable name
  assert.strictEqual(device.valueTitle('fan_level', 'super_turbo'), 'Super turbo');
});

test('timer and API errors are translated', async () => {
  const device = createDevice(createClient(), {});
  device.clearCheckData = () => {};
  device.scheduleCheckData = () => {};
  await assert.rejects(device.onSetTimer(0, 'on', 'nop', 'nop', 0), { message: translate('errors.timer_minutes_required') });
  await assert.rejects(device.onSetTimer(1441, 'on', 'nop', 'nop', 0), { message: 'Minutes from now can be at most 1440.' });
  await assert.rejects(device.onSetTimer(5, 'nop', 'nop', 'nop', 0), { message: translate('errors.timer_nothing_to_set') });
  assert.strictEqual(device.getApiFailureMessage({}), translate('errors.unknown_api_error'));
  const sensibo = new Sensibo({
    homey: { __: translate }, apikey: 'key', deviceId: 'pod', logger: () => {}
  });
  assert.strictEqual(sensibo.createTimeoutError('GET', 'https://example.invalid/?apiKey=key').message, "The Sensibo API didn't answer within 30 seconds.");
});
