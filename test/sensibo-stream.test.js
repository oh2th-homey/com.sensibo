'use strict';

// The event stream of the Sensibo API against a local HTTP server: events, refused streams, abort and the idle timeout.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const Sensibo = require('../lib/sensibo');

// Local server; each test sets the handler for its requests
let handler;
const received = [];
const server = http.createServer((req, res) => {
  received.push({ url: req.url, headers: req.headers });
  handler(req, res);
});

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

// Homey timers; timeoutMs shortens the idle timeout of the stream
const createClient = ({ timeoutMs } = {}) => {
  const logs = [];
  const timers = new Set();
  const homey = {
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, timeoutMs === undefined ? ms : timeoutMs);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    }
  };
  const sensibo = new Sensibo({ homey, logger: (...args) => logs.push(args.join(' ')) });
  const { port } = server.address();
  sensibo.getUri = () => `http://127.0.0.1:${port}/api/v2`;
  return { sensibo, logs, timers };
};

const collect = async (sensibo, signal) => {
  const events = [];
  await sensibo.streamEvents('SECRETKEY', (name, data) => events.push([name, data]), signal);
  return events;
};

const HELLO = 'retry: 30000\nevent: hello\ndata: {"version":1,"heartbeatSeconds":120,"pods":2}\n\n';
const MEASUREMENTS = 'event: measurements\ndata: {"id":"pod","measurements":{"temperature":22.5,"humidity":40.1}}\n\n';

test('the stream gives the events until the API closes it', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Events do not arrive in one piece each, a comment line is the heartbeat, and line ends can be CRLF
    res.write(HELLO.slice(0, 30));
    res.write(`${HELLO.slice(30)}: hb\n\n${MEASUREMENTS}`);
    res.end('event: changed\r\ndata: {"id":"pod","fields":["acState"]}\r\n\r\nevent: resync\ndata: {}\n\n');
  };
  const { sensibo, timers } = createClient();
  assert.deepStrictEqual(await collect(sensibo), [
    ['hello', { version: 1, heartbeatSeconds: 120, pods: 2 }],
    ['measurements', { id: 'pod', measurements: { temperature: 22.5, humidity: 40.1 } }],
    ['changed', { id: 'pod', fields: ['acState'] }],
    ['resync', {}]
  ]);
  // The API key is in a header, not in the URL
  assert.strictEqual(received[0].url, '/api/v2/stream');
  assert.strictEqual(received[0].headers['x-api-key'], 'SECRETKEY');
  assert.strictEqual(received[0].headers.accept, 'text/event-stream');
  // The idle timer is cleared when the stream ends
  assert.strictEqual(timers.size, 0);
});

test('events of a gzip stream arrive when the API flushes them, not when it closes', async () => {
  let finish;
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    gzip.write(HELLO);
    gzip.flush();
    finish = () => gzip.end(MEASUREMENTS);
  };
  const { sensibo } = createClient();
  const names = [];
  await sensibo.streamEvents('SECRETKEY', (name) => {
    names.push(name);
    if (name === 'hello') {
      // The stream is still open here
      finish();
    }
  });
  assert.deepStrictEqual(names, ['hello', 'measurements']);
});

test('data that is not a JSON object gives no event', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`event: changed\ndata: not json\n\nevent: changed\ndata: 5\n\n${MEASUREMENTS}event: changed\ndata: {"id":"lost"}`);
  };
  const { sensibo, logs } = createClient();
  assert.deepStrictEqual((await collect(sensibo)).map(([name]) => name), ['measurements']);
  assert.deepStrictEqual(logs, ['streamEvents non-JSON event changed']);
});

test('a refused stream carries the status and the seconds to wait', async () => {
  const { sensibo, timers } = createClient();
  handler = (req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '300' });
    res.end(JSON.stringify({ status: 'error', reason: 'too many streams for this user' }));
  };
  await assert.rejects(collect(sensibo), (err) => {
    assert.strictEqual(err.status, 429);
    assert.strictEqual(err.retryAfter, 300);
    assert.strictEqual(err.message, 'Error opening the event stream (too many streams for this user)');
    return true;
  });
  handler = (req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    res.end('<h1>Unauthorized</h1>');
  };
  await assert.rejects(collect(sensibo), { status: 401, retryAfter: 0 });
  assert.strictEqual(timers.size, 0);
});

test('an abort of the signal ends an open stream', async () => {
  const controller = new AbortController();
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(HELLO);
  };
  const { sensibo, timers } = createClient();
  const names = [];
  await assert.rejects(
    sensibo.streamEvents('SECRETKEY', (name) => {
      names.push(name);
      controller.abort();
    }, controller.signal),
    { name: 'AbortError' }
  );
  assert.deepStrictEqual(names, ['hello']);
  assert.strictEqual(timers.size, 0);
  // A signal that is already aborted does not open a stream
  await assert.rejects(collect(sensibo, controller.signal), { name: 'AbortError' });
  assert.strictEqual(received.length, 1);
});

test('a stream that goes silent ends with a timeout', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(HELLO);
  };
  const { sensibo, logs, timers } = createClient({ timeoutMs: 50 });
  await assert.rejects(collect(sensibo), { timeout: true, message: 'No data from the event stream in 250 seconds' });
  assert.deepStrictEqual(logs, ['streamEvents timeout']);
  assert.strictEqual(timers.size, 0);
});
