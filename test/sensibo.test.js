'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Sensibo = require('../lib/sensibo');

// Client with the HTTP request stubbed, records what would be sent
const createClient = () => {
  const sensibo = new Sensibo({
    homey: {}, apikey: 'key', deviceId: 'pod', logger: () => {}
  });
  sensibo.requests = [];
  sensibo.request = async (action, method, url, body) => {
    sensibo.requests.push({ method, path: url.split('?')[0].replace(sensibo.getUri(), ''), body });
  };
  return sensibo;
};

// Polled state as BaseDevice#onDeviceInfoReceived passes it: setpoint already converted to Celsius
const polledFahrenheitState = () => ({
  on: true, mode: 'cool', fanLevel: 'auto', targetTemperature: 22, temperatureUnit: 'F'
});

test('first poll of a Fahrenheit device caches the setpoint in Fahrenheit', () => {
  const sensibo = createClient();
  sensibo.updateAcState(polledFahrenheitState());
  assert.strictEqual(sensibo.getAcState().targetTemperature, 72);
  assert.strictEqual(sensibo.getAcState().temperatureUnit, 'F');
});

test('a null setpoint is not converted to 32 F', () => {
  const sensibo = createClient();
  sensibo.updateAcState(polledFahrenheitState());
  // A later poll in fan mode reports no setpoint
  sensibo.updateAcState({ ...polledFahrenheitState(), mode: 'fan', targetTemperature: null });
  assert.strictEqual(sensibo.getAcState().targetTemperature, null);
});

test('a multi-property change right after startup sends the correct Fahrenheit setpoint', async () => {
  const sensibo = createClient();
  sensibo.updateAcState(polledFahrenheitState());
  await sensibo.setAcState({ on: false, fanLevel: 'low' });
  assert.deepStrictEqual(sensibo.requests, [
    {
      method: 'POST',
      path: '/pods/pod/acStates',
      body: {
        acState: {
          on: false, mode: 'cool', fanLevel: 'low', targetTemperature: 72, temperatureUnit: 'F'
        }
      }
    }
  ]);
});

test('a single property change is a PATCH with only that value', async () => {
  const sensibo = createClient();
  sensibo.updateAcState(polledFahrenheitState());
  await sensibo.setAcProperty('on', false);
  assert.deepStrictEqual(sensibo.requests, [{ method: 'PATCH', path: '/pods/pod/acStates/on', body: { newValue: false } }]);
});

test('a single setpoint change is converted for Fahrenheit devices', async () => {
  const sensibo = createClient();
  sensibo.updateAcState(polledFahrenheitState());
  await sensibo.setAcProperty('targetTemperature', 20);
  assert.deepStrictEqual(sensibo.requests[0].body, { newValue: 68 });
});

test('a single setpoint change is unchanged for Celsius devices', async () => {
  const sensibo = createClient();
  sensibo.updateAcState({ ...polledFahrenheitState(), temperatureUnit: 'C' });
  await sensibo.setAcProperty('targetTemperature', 24);
  assert.deepStrictEqual(sensibo.requests[0].body, { newValue: 24 });
});
