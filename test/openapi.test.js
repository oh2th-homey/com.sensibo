'use strict';

// Every request the API client makes must be an endpoint and method in Sensibo's OpenAPI spec (sensibo.openapi.yaml).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Sensibo = require('../lib/sensibo');

const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'sensibo.openapi.yaml'), 'utf8'));

// Endpoints the app uses that the published spec doesn't list. They work against the live API.
// A new entry here needs a reason; any other undocumented request fails the test.
const UNDOCUMENTED = [
  'PUT /pods/{device_id}/pureboost',
  'DELETE /pods/{device_id}/cleanFiltersNotification'
];

// "/pods/{device_id}/timer/" -> regular expression matching "/pods/pod/timer/"
const pathPattern = (template) => new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);

const findOperation = (method, url) => {
  const { pathname } = new URL(url);
  const apiPath = pathname.replace(/^\/api\/v\d+/, '');
  for (const [template, item] of Object.entries(spec.paths)) {
    if (pathPattern(template).test(apiPath)) {
      return { template, operation: item[method.toLowerCase()] };
    }
  }
  return { template: undefined, operation: undefined };
};

// Client that records requests instead of sending them
const createClient = () => {
  const sensibo = new Sensibo({
    homey: {}, apikey: 'key', deviceId: 'pod', logger: () => {}
  });
  sensibo.requests = [];
  sensibo.request = async (action, method, url, body) => {
    sensibo.requests.push({ method, url, body });
    return { status: 'success', result: { timer: null } };
  };
  sensibo.updateAcState({
    on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 22, temperatureUnit: 'C'
  });
  return sensibo;
};

// Every request method of the client, called once
const CALLS = {
  getAllDevices: (s) => s.getAllDevices(),
  getAllDeviceInfo: (s) => s.getAllDeviceInfo('key'),
  getRemoteCapabilities: (s) => s.getRemoteCapabilities(),
  getSpecificDeviceInfo: (s) => s.getSpecificDeviceInfo(),
  getAcStates: (s) => s.getAcStates(),
  setAcState: (s) => s.setAcState({ on: false, fanLevel: 'high' }),
  setAcProperty: (s) => s.setAcProperty('fanLevel', 'high'),
  syncDeviceState: (s) => s.syncDeviceState(true),
  getClimateReactSettings: (s) => s.getClimateReactSettings(),
  enableClimateReact: (s) => s.enableClimateReact(true),
  setClimateReactSettings: (s) => s.setClimateReactSettings({ enabled: true }),
  enablePureBoost: (s) => s.enablePureBoost(true),
  resetFilterIndicator: (s) => s.resetFilterIndicator(),
  isTimerEnabled: (s) => s.isTimerEnabled(),
  deleteCurrentTimer: (s) => s.deleteCurrentTimer(),
  setCurrentTimer: (s) => s.setCurrentTimer(5, { on: true })
};

test('the spec is the OpenAPI document for the Sensibo API v2', () => {
  assert.match(spec.openapi, /^3\./);
  assert.strictEqual(spec.servers[0].url, 'https://home.sensibo.com/api/v2');
});

test('every request of the API client is in the spec, or listed as undocumented', async () => {
  const undocumentedSeen = new Set();
  for (const [name, call] of Object.entries(CALLS)) {
    const sensibo = createClient();
    await call(sensibo);
    assert.ok(sensibo.requests.length > 0, `${name} makes a request`);
    for (const { method, url } of sensibo.requests) {
      const { template, operation } = findOperation(method, url);
      const key = `${method} ${template || new URL(url).pathname.replace(/^\/api\/v\d+/, '').replace('/pod/', '/{device_id}/')}`;
      if (UNDOCUMENTED.includes(key)) {
        undocumentedSeen.add(key);
        continue;
      }
      assert.ok(template, `${name}: ${method} ${url} is not a path in the spec`);
      assert.ok(operation, `${name}: ${method} is not an operation of ${template} in the spec`);
    }
  }
  // Remove entries from UNDOCUMENTED when the client stops using them, or when the spec adds them
  assert.deepStrictEqual([...undocumentedSeen].sort(), [...UNDOCUMENTED].sort());
});

test('the client uses API v1 where the spec says so', async () => {
  for (const name of ['deleteCurrentTimer', 'setCurrentTimer']) {
    const sensibo = createClient();
    await CALLS[name](sensibo);
    const { url } = sensibo.requests[0];
    const { template } = findOperation('GET', url);
    const servers = spec.paths[template].servers || spec.servers;
    assert.ok(url.startsWith(servers[0].url.replace(/\/$/, '')), `${name}: ${url} should use ${servers[0].url}`);
  }
});
