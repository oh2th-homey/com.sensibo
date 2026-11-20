'use strict';

// The app with the event stream: one stream per API key, a slow poll while it is open, events to the devices.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const util = require('../lib/util');

// The random delay before a regular poll is counted, not waited for
let randomDelays = 0;
util.randomDelay = async () => {
  randomDelays++;
};

// The app extends Homey.App, which only exists inside the Homey runtime: load it with a stub
const originalLoad = Module._load;
Module._load = function loadWithHomeyStub(request, ...args) {
  if (request === 'homey') {
    return { App: class {} };
  }
  return originalLoad.call(this, request, ...args);
};
const SensiboApp = require('../app');
// Sensibo Air with a Room Sensor as its primary sensor
const { result: airWithRoomSensor } = require('../samples/pods/skyplus-primary-sensor-2-on.json');

Module._load = originalLoad;

const tick = () => new Promise((resolve) => {
  setImmediate(resolve);
});

// A paired device that records what the app gives it
const createDevice = (id, apiKey) => {
  const device = {
    info: [],
    measurements: [],
    scheduled: [],
    getData: () => ({ id }),
    getApiKey: () => apiKey,
    getSetting: () => 60,
    isInitialized: () => true,
    onDeviceInfoReceived: async (result) => device.info.push(result),
    onMeasurementsReceived: async (result) => device.measurements.push(result),
    scheduleCheckData: (seconds) => device.scheduled.push(seconds)
  };
  return device;
};

// The app without onInit(): Homey timers are kept in a list, polls and streams of the API client are recorded
const createApp = (devices, pods = []) => {
  const app = Object.create(SensiboApp.prototype);
  const timers = [];
  app.log = () => {};
  app.homey = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timers.includes(timer)) {
        timers.splice(timers.indexOf(timer), 1);
      }
    },
    drivers: { getDrivers: () => ({ driver: { getDevices: () => devices } }) }
  };
  app._streams = new Map();
  app._podData = new Map();
  const polls = [];
  const streams = [];
  app._sensibo = {
    getAllDeviceInfo: async (apiKey) => {
      polls.push(apiKey);
      return { result: JSON.parse(JSON.stringify(pods)) };
    },
    // A stream stays open until the test ends it with close() or fail()
    streamEvents: (apiKey, onEvent, signal) => new Promise((close, fail) => {
      streams.push({
        apiKey, onEvent, signal, close, fail
      });
    })
  };
  // Runs the timer of the given kind: the next poll of the app (1 s after an event) or the retry of a stream
  const runTimer = async (timer) => {
    timers.splice(timers.indexOf(timer), 1);
    await timer.fn();
    await tick();
  };
  return {
    app, timers, polls, streams, runTimer
  };
};

test('each API key gets one event stream, closed when the key is no longer in use', async () => {
  const devices = [createDevice('a1', 'KEY_A'), createDevice('a2', 'KEY_A'), createDevice('b1', 'KEY_B')];
  const { app, polls, streams } = createApp(devices);
  await app.checkData();
  await app.checkData();
  assert.deepStrictEqual(streams.map((stream) => stream.apiKey), ['KEY_A', 'KEY_B']);
  // Without an open stream the devices are polled as before
  assert.deepStrictEqual(polls, ['KEY_A', 'KEY_B', 'KEY_A', 'KEY_B']);
  assert.strictEqual(app.isStreamOpen('KEY_A'), false);

  devices.pop();
  await app.checkData();
  assert.strictEqual(streams[0].signal.aborted, false);
  assert.strictEqual(streams[1].signal.aborted, true);
  assert.strictEqual(app._streams.size, 1);

  await app.onUninit();
  assert.strictEqual(streams[0].signal.aborted, true);
  assert.strictEqual(app._streams.size, 0);
});

test('with an open stream the devices are polled every 15 minutes, and at once after hello and changed', async () => {
  const {
    app, timers, polls, streams, runTimer
  } = createApp([createDevice('pod', 'KEY')]);
  await app.checkData();
  assert.strictEqual(polls.length, 1);
  randomDelays = 0;

  // hello: values can have changed while the stream was not open
  await streams[0].onEvent('hello', { version: 1 });
  assert.strictEqual(app.isStreamOpen('KEY'), true);
  assert.strictEqual(app.curTimeout.ms, 1000);
  await runTimer(app.curTimeout);
  assert.strictEqual(polls.length, 2);
  assert.strictEqual(randomDelays, 0);

  // The regular poll timer continues, but the API key is not polled
  await runTimer(app.curTimeout);
  await runTimer(app.curTimeout);
  assert.strictEqual(polls.length, 2);

  await streams[0].onEvent('changed', { id: 'pod', fields: ['connectionStatus'] });
  assert.strictEqual(app.curTimeout.ms, 1000);
  await runTimer(app.curTimeout);
  assert.strictEqual(polls.length, 3);

  // resync: the API closes the stream, nothing to read
  await streams[0].onEvent('resync', {});
  assert.strictEqual(app.curTimeout.ms, 60000);

  app._streams.get('KEY').polledAt -= 15 * 60 * 1000;
  await runTimer(app.curTimeout);
  assert.strictEqual(polls.length, 4);
  assert.strictEqual(randomDelays, 1);
  assert.strictEqual(timers.length, 1);
});

test('measurements of an event reach the AC and its Room Sensor without a poll', async () => {
  const ac = createDevice('skyplus_id', 'KEY');
  const roomSensor = createDevice('motion_sensor_id', 'KEY');
  // A device changes the data that it receives from the poll
  ac.onDeviceInfoReceived = async (result) => {
    result.measurements.temperature = 99;
  };
  const { app, polls, streams } = createApp([ac, roomSensor], [{ id: 'skyplus_id', productModel: 'skyplus', ...airWithRoomSensor }]);
  await app.checkData();
  await streams[0].onEvent('hello', { version: 1 });
  app.clearCheckData();

  await streams[0].onEvent('measurements', { id: 'skyplus_id', measurements: { temperature: 25.1, feelsLike: 25.3 } });
  assert.strictEqual(ac.measurements.length, 1);
  assert.strictEqual(ac.measurements[0].productModel, 'skyplus');
  // The event has the changed values, the other values stay
  assert.deepStrictEqual(ac.measurements[0].measurements, { ...airWithRoomSensor.measurements, temperature: 25.1, feelsLike: 25.3 });
  assert.strictEqual(roomSensor.measurements.length, 0);

  await streams[0].onEvent('measurements', { id: 'motion_sensor_id', podId: 'skyplus_id', measurements: { temperature: 19.5 } });
  assert.strictEqual(roomSensor.measurements.length, 1);
  assert.strictEqual(roomSensor.measurements[0].productModel, 'motion_sensor');
  assert.strictEqual(roomSensor.measurements[0].measurements.temperature, 19.5);
  assert.strictEqual(roomSensor.measurements[0].measurements.batteryVoltage, 3000);
  // The AC shows the values of its primary sensor
  assert.strictEqual(ac.measurements.length, 2);
  assert.strictEqual(ac.measurements[1].mainMeasurementsSensor.measurements.temperature, 19.5);
  assert.strictEqual(ac.measurements[1].measurements.temperature, 25.1);

  assert.strictEqual(polls.length, 1);
  assert.strictEqual(app.curTimeout, undefined);

  // A device or Room Sensor that the last poll did not have: poll now
  for (const data of [{ id: 'new_id', measurements: {} }, { id: 'new_sensor_id', podId: 'skyplus_id', measurements: {} }]) {
    app.clearCheckData();
    await streams[0].onEvent('measurements', data);
    assert.strictEqual(app.curTimeout.ms, 1000);
  }
});

test('a changed AC state makes the device read its AC states', async () => {
  const device = createDevice('pod', 'KEY');
  const { app, streams } = createApp([device]);
  await app.checkData();
  await streams[0].onEvent('changed', { id: 'pod', fields: ['acState'] });
  // No fields: any field can be different
  await streams[0].onEvent('changed', { id: 'pod', fields: [] });
  assert.deepStrictEqual(device.scheduled, [1, 1]);
  await streams[0].onEvent('changed', { id: 'pod', fields: ['connectionStatus'] });
  await streams[0].onEvent('changed', { id: 'other', fields: ['acState'] });
  assert.deepStrictEqual(device.scheduled, [1, 1]);
});

test('a closed stream gives the devices their polling interval back and opens again, each time later', async () => {
  const device = createDevice('pod', 'KEY');
  const { app, streams, runTimer } = createApp([device]);
  await app.checkData();
  app.clearCheckData();
  const retry = () => app._streams.get('KEY').retryTimeout;
  const seconds = () => retry().ms / 1000;

  await streams[0].onEvent('hello', { version: 1 });
  streams[0].close();
  await tick();
  assert.strictEqual(app.isStreamOpen('KEY'), false);
  assert.deepStrictEqual(device.scheduled, [undefined]);
  assert.ok(seconds() >= 5 && seconds() < 10, `first retry in ${seconds()} s`);

  // The delay doubles to a maximum of 5 minutes, with a random part
  const minimums = [10, 20, 40, 80, 160, 300, 300];
  for (const [index, minimum] of minimums.entries()) {
    await runTimer(retry());
    streams[index + 1].fail(new Error('fetch failed'));
    await tick();
    assert.ok(seconds() >= minimum && seconds() < minimum * 2, `retry ${index + 2} in ${seconds()} s`);
  }
  assert.strictEqual(streams.length, 8);
  // The devices were told one time only: the stream was not open again
  assert.deepStrictEqual(device.scheduled, [undefined]);

  // An event starts the delay from the beginning; the API can ask for a longer delay
  await runTimer(retry());
  await streams[8].onEvent('hello', { version: 1 });
  streams[8].fail(Object.assign(new Error('too many streams'), { status: 429, retryAfter: 300 }));
  await tick();
  assert.ok(seconds() >= 300 && seconds() < 600, `retry after 429 in ${seconds()} s`);

  await runTimer(retry());
  await streams[9].onEvent('hello', { version: 1 });
  streams[9].fail(Object.assign(new Error('Invalid credentials'), { status: 401, retryAfter: 0 }));
  await tick();
  assert.ok(seconds() >= 300, `retry after 401 in ${seconds()} s`);

  // No retry after the app is destroyed
  await app.onUninit();
  assert.strictEqual(streams.length, 10);
});
