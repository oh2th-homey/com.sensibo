'use strict';

// The Sensibo API client against a local HTTP server: requests, error mapping, non-JSON bodies and the timeout.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Sensibo = require('../lib/sensibo');
const { translate } = require('./i18n');

// Local server; each test sets the handler for its requests
let handler;
const received = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    received.push({
      method: req.method, url: req.url, headers: req.headers, body
    });
    handler(req, res);
  });
});

const reply = (status, body, contentType = 'application/json') => (req, res) => {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
}));
test.after(() => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
}));
test.beforeEach(() => {
  received.length = 0;
});

// Homey timers and translations; timeoutMs shortens the 30 s request timeout
const createClient = ({ timeoutMs } = {}) => {
  const logs = [];
  const timers = { cleared: 0 };
  const homey = {
    __: translate,
    setTimeout: (fn, ms) => setTimeout(fn, timeoutMs === undefined ? ms : timeoutMs),
    clearTimeout: (timer) => {
      timers.cleared++;
      clearTimeout(timer);
    }
  };
  const sensibo = new Sensibo({
    homey, apikey: 'SECRETKEY', deviceId: 'pod', logger: (...args) => logs.push(args.join(' '))
  });
  const { port } = server.address();
  sensibo.getUri = () => `http://127.0.0.1:${port}/api/v2`;
  return { sensibo, logs, timers };
};

test('a GET returns the JSON body and asks for gzip', async () => {
  handler = reply(200, { status: 'success', result: { id: 'pod' } });
  const { sensibo, timers } = createClient();
  const data = await sensibo.getClimateReactSettings();
  assert.deepStrictEqual(data, { status: 'success', result: { id: 'pod' } });
  assert.strictEqual(received[0].method, 'GET');
  assert.strictEqual(received[0].url, '/api/v2/pods/pod/smartmode?apiKey=SECRETKEY');
  assert.strictEqual(received[0].headers['accept-encoding'], 'gzip');
  // The timeout timer is cleared once the response is in
  assert.strictEqual(timers.cleared, 1);
});

test('a POST sends its body as JSON', async () => {
  handler = reply(200, { status: 'success' });
  const { sensibo } = createClient();
  await sensibo.setClimateReactSettings({ enabled: true, type: 'temperature' });
  assert.strictEqual(received[0].method, 'POST');
  assert.strictEqual(received[0].headers['content-type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(received[0].body), { enabled: true, type: 'temperature' });
});

test('an API error carries Sensibo\'s message, reason and status', async () => {
  handler = reply(429, { status: 'error', reason: 'TooManyRequests', message: 'Too many requests' });
  const { sensibo } = createClient();
  await assert.rejects(sensibo.getClimateReactSettings(), (err) => {
    assert.strictEqual(err.apiMessage, 'Too many requests');
    assert.strictEqual(err.apiReason, 'TooManyRequests');
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.message, 'Error getting Climate React settings (Too many requests)');
    return true;
  });
});

test('the error message is taken from reason, error or result when there is no message', async () => {
  const { sensibo } = createClient();
  const cases = [
    [{ reason: 'PodNotConnected' }, 'PodNotConnected'],
    [{ error: 'Unauthorized' }, 'Unauthorized'],
    [{ result: { message: 'Bad value for targetTemperature' } }, 'Bad value for targetTemperature'],
    [{ result: { error: 'Unknown device' } }, 'Unknown device']
  ];
  for (const [body, expected] of cases) {
    handler = reply(400, body);
    await assert.rejects(sensibo.getClimateReactSettings(), { apiMessage: expected });
  }
});

test('a non-JSON error page gives its text, a body-less error its status', async () => {
  const { sensibo, logs } = createClient();
  handler = reply(502, '<html>Bad gateway</html>', 'text/html');
  await assert.rejects(sensibo.getClimateReactSettings(), { apiMessage: '<html>Bad gateway</html>', status: 502 });
  // The unparsable body is logged without the API key
  assert.ok(logs.some((line) => line.includes('non-JSON') && line.includes('apiKey=***')));
  assert.ok(logs.every((line) => !line.includes('SECRETKEY')));
  handler = reply(404, '');
  await assert.rejects(sensibo.getClimateReactSettings(), { apiMessage: '404 - Not Found' });
});

test('a successful response that isn\'t JSON gives an empty result', async () => {
  const { sensibo } = createClient();
  handler = reply(200, 'OK', 'text/plain');
  assert.deepStrictEqual(await sensibo.getClimateReactSettings(), {});
  handler = reply(200, '');
  assert.deepStrictEqual(await sensibo.getClimateReactSettings(), {});
});

test('a request without an answer times out with a translated message', async () => {
  // The server never answers; the request timer fires after 50 ms instead of 30 s
  handler = () => {};
  const { sensibo, logs } = createClient({ timeoutMs: 50 });
  await assert.rejects(sensibo.getClimateReactSettings(), (err) => {
    assert.strictEqual(err.timeout, true);
    assert.strictEqual(err.apiMessage, translate('errors.api_timeout', { seconds: 30 }));
    assert.strictEqual(err.message, "The Sensibo API didn't answer within 30 seconds.");
    return true;
  });
  assert.ok(logs.some((line) => line.includes('timeout') && line.includes('apiKey=***')));
});

test('a disconnected device is recognised in the reason, message or raw body', async () => {
  const { sensibo } = createClient();
  for (const [status, body, contentType] of [
    [400, { reason: 'PodNotConnected' }],
    [400, { message: 'Error: PodNotConnected' }],
    [400, { result: { reason: 'PodNotConnected' } }],
    [503, 'PodNotConnected', 'text/plain']
  ]) {
    handler = reply(status, body, contentType);
    const response = await sensibo._fetch('GET', `${sensibo.getUri()}/pods/pod?apiKey=SECRETKEY`);
    assert.strictEqual(sensibo.isPodNotConnectedResponse(response), true, JSON.stringify(body));
  }
  handler = reply(400, { reason: 'TooManyRequests' });
  assert.strictEqual(sensibo.isPodNotConnectedResponse(await sensibo._fetch('GET', `${sensibo.getUri()}/pods/pod`)), false);
});
