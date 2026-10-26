'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load BaseDevice with mocks, without requiring the Homey runtime or an API key.
const source = fs.readFileSync(path.join(__dirname, '../drivers/BaseDevice.js'), 'utf8');
const moduleMock = { exports: {} };
let clock = 10000;
vm.runInNewContext(source, {
  module: moduleMock,
  require(name) {
    if (name === 'homey') return { Device: class {} };
    if (name === '../lib/sensibo') return class {};
    if (name === '../lib/util') return {};
    throw new Error(`Unexpected module: ${name}`);
  },
  Date: { now: () => clock },
  Promise
}, { filename: 'drivers/BaseDevice.js' });

async function run() {
  const BaseDevice = moduleMock.exports;
  const device = new BaseDevice();
  const sent = [];
  const waits = [];
  let failNext = false;

  device.homey = {
    setTimeout(fn, delay) {
      clock += delay;
      waits.push(delay);
      fn();
    }
  };
  device.log = () => {};
  device.ensureDeviceAvailable = async () => {};
  device.setUnavailableFromApiError = async () => {};
  device._sensibo = {
    setAcState() {
      throw new Error('Full AC state must never be sent');
    },
    async setAcProperty(name, value) {
      sent.push([name, value]);
      if (failNext) {
        failNext = false;
        throw new Error('Simulated API failure');
      }
    }
  };
  device.initAcStateBatching();

  await device.sendAcStatePropertyUpdates({ on: true });
  assert.deepStrictEqual(sent, [['on', true]], 'power-on should not include setpoint');

  await device.sendAcStatePropertyUpdates({ fanLevel: 'quiet' });
  assert.deepStrictEqual(sent[1], ['fanLevel', 'quiet'], 'fan changes should not include setpoint');

  await device.sendAcStatePropertyUpdates({ targetTemperature: 24 });
  assert.deepStrictEqual(sent[2], ['targetTemperature', 24], 'explicit temperature changes still work');

  device._pendingAcStatePatch = { on: false, mode: 'heat' };
  await device.flushAcStateBatch();
  assert.deepStrictEqual(sent.slice(3, 5), [['on', false], ['mode', 'heat']], 'batch should send only changed properties');

  failNext = true;
  device._pendingAcStatePatch = { fanLevel: 'high' };
  await device.flushAcStateBatch(); // The existing code catches API failures.

  device._pendingAcStatePatch = { on: true };
  await device.flushAcStateBatch();
  assert.deepStrictEqual(sent[sent.length - 1], ['on', true], 'a failed batch must not block later requests');
  assert(waits.every((delay) => delay > 0), 'outbound requests should be throttled');

  console.log('Sensibo property-only AC state tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
