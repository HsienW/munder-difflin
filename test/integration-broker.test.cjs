const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const { resolveUpstreamUrl, INTEGRATION_TEMPLATES } = loadTs('src/shared/integrations.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function templateUrl(id) {
  const template = INTEGRATION_TEMPLATES.find((entry) => entry.idSuggestion === id);
  assert.ok(template, `missing integration template: ${id}`);
  return template.baseUrl;
}

const resolverCases = [
  [templateUrl('linear'), '', '/graphql'],
  [templateUrl('linear'), '?operationName=Viewer', '/graphql?operationName=Viewer'],
  [templateUrl('linear'), 'issues', '/graphql/issues'],
  [templateUrl('linear'), '/', '/graphql/'],
  [templateUrl('linear'), '/?operationName=Viewer', '/graphql/?operationName=Viewer'],
  [templateUrl('linear') + '/', '', '/graphql/'],
  [templateUrl('sentry'), '', '/api/0'],
  [templateUrl('sentry'), '/', '/api/0/'],
  [templateUrl('sentry') + '/', '', '/api/0/'],
  [templateUrl('stripe'), '/charges', '/v1/charges'],
  [templateUrl('stripe'), 'charges', '/v1/charges'],
  [templateUrl('notion'), 'pages', '/v1/pages'],
  [templateUrl('jira'), 'issue', '/rest/api/3/issue'],
  [templateUrl('github'), '', '/'],
  [templateUrl('github'), 'repos/org/repo', '/repos/org/repo'],
  ['https://example.test/api', '', '/api'],
  ['https://example.test/api/', '', '/api/'],
  ['https://example.test/api', '%252e%252e/secrets', '/api/%252e%252e/secrets'],
  ['https://example.test', '..\\..\\x', '/x'],
  ['https://example.test/graphql', ' ', '/graphql/'],
  ['https://example.test/graphql', '#fragment', '/graphql#fragment'],
  ['https://example.test/graphql', '?filter=%2e%2e', '/graphql?filter=%2e%2e']
];

for (const [baseUrl, workerPath, expectedTarget] of resolverCases) {
  test(`resolver: ${baseUrl} + ${JSON.stringify(workerPath)} -> ${expectedTarget}`, () => {
    const resolvedUrl = resolveUpstreamUrl(baseUrl, workerPath);
    assert.ok(resolvedUrl);
    assert.equal(resolvedUrl.origin, new URL(baseUrl).origin);
    assert.equal(resolvedUrl.pathname + resolvedUrl.search + resolvedUrl.hash, expectedTarget);
  });
}

for (const workerPath of [
  '../api-evil', '%2e%2e/secrets', '..\\..\\secrets',
  'https://evil.test/steal', '//evil.test/steal', '%E0%A4%A'
]) {
  test(`resolver rejects out-of-bounds or malformed path: ${workerPath}`, () => {
    assert.equal(resolveUpstreamUrl('https://example.test/api', workerPath), null);
  });
}

// A root base has no directory prefix to confine against, so only the
// absolute-URL and protocol-relative guards keep the origin fixed.
for (const workerPath of ['https://evil.test/x', '//evil.test/x']) {
  test(`resolver rejects origin override under a root base: ${workerPath}`, () => {
    assert.equal(resolveUpstreamUrl('https://example.test', workerPath), null);
  });
}

for (const baseUrl of ['', 'not a URL', 'data:text/plain,hello', 'file:///tmp/a']) {
  test(`resolver fails closed for invalid base: ${baseUrl}`, () => {
    assert.equal(resolveUpstreamUrl(baseUrl, ''), null);
  });
}

// Use raw HTTP paths so the client cannot normalize traversal or fragments before
// the broker sees them. Every response is drained; failures reject the test.
function requestBroker(broker, path, token, body = Buffer.from('{"query":"{ viewer { id } }"}')) {
  return new Promise((resolve, reject) => {
    const request = http.request(broker.url(), {
      path, method: 'POST', agent: false,
      headers: {
        ...(token ? { 'x-md-broker-token': token } : {}),
        authorization: 'Bearer attacker-controlled',
        'content-type': 'application/json'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)
      }));
    });
    request.setTimeout(5000, () => request.destroy(new Error('broker request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

async function fixture(context) {
  const received = [];
  const state = { secret: 'mock-upstream-secret', secretReads: 0 };
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('error', (error) => response.destroy(error));
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ method: request.method, target: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      const redirect = /^\/redirect(307|308)\/?$/.exec(request.url);
      if (redirect) {
        response.writeHead(Number(redirect[1]), { location: '/redirect-target' });
        response.end('redirect');
      } else if (request.url === '/disconnect') {
        request.socket.destroy();
      } else if (request.url === '/malformed') {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end('{"error":');
      } else {
        response.writeHead(request.url === '/graphql/' ? 404 : 200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }
    });
  });
  context.after(() => new Promise((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve());
    upstream.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const record = {
    id: 'linear', label: 'Mock API', kind: 'custom-rest', baseUrl: origin + '/graphql',
    authType: 'header', authHeader: 'Authorization', secretRef: 'int:linear',
    enabled: true, createdAt: 0, updatedAt: 0
  };
  const broker = new IntegrationBroker({
    getRecord: (id) => id === record.id ? record : undefined,
    getSecret: (secretRef) => {
      assert.equal(secretRef, record.secretRef);
      state.secretReads++;
      return state.secret;
    }
  });
  context.after(() => broker.stop());
  const started = await broker.start(0);
  assert.equal(started.ok, true, started.error);
  assert.ok(started.port > 0);
  const token = broker.grant('test-worker', [record.id, 'missing']);
  return { broker, record, origin, token, state, received };
}

test('broker forwards exact endpoints, queries and REST children on the wire', async (context) => {
  const { broker, record, origin, token, state, received } = await fixture(context);
  const cases = [
    ['/graphql', '/i/linear', '/graphql'],
    ['/graphql', '/i/linear?operationName=Viewer', '/graphql?operationName=Viewer'],
    ['/graphql', '/i/linear/', '/graphql'],
    ['/graphql', '/i/linear/?operationName=Viewer', '/graphql?operationName=Viewer'],
    ['/graphql', '/i/linear/issues', '/graphql/issues'],
    ['/api/0', '/i/linear', '/api/0'],
    ['/api/0', '/i/linear/', '/api/0'],
    ['/api/0', '/i/linear//', '/api/0/'],
    ['/api/0/', '/i/linear', '/api/0/'],
    ['/v1', '/i/linear/charges', '/v1/charges'],
    ['/v1', '/i/linear/pages', '/v1/pages'],
    ['/rest/api/3', '/i/linear/issue', '/rest/api/3/issue'],
    ['/', '/i/linear/repos/org/repo', '/repos/org/repo'],
    ['/api', '/i/linear/%252e%252e/secrets', '/api/%252e%252e/secrets'],
    ['/graphql', '/i/linear?filter=%2e%2e', '/graphql?filter=%2e%2e']
  ];
  for (const [basePath, route, expectedTarget] of cases) {
    await context.test(`${basePath} via ${route}`, async (child) => {
      record.baseUrl = origin + basePath;
      // Deliberately incomplete JSON: proxying must not parse or repair bytes.
      const body = Buffer.from('{"query":"未閉合');
      const response = await requestBroker(broker, route, token, body);
      const actual = received.at(-1);
      child.diagnostic(`POST ${route} -> ${actual.target}; status ${response.status}`);
      assert.equal(actual.target, expectedTarget);
      assert.equal(response.status, 200);
      assert.equal(actual.method, 'POST');
      assert.deepEqual(actual.body, body);
      assert.equal(actual.headers.authorization, state.secret);
      assert.equal(actual.headers['x-md-broker-token'], undefined);
      assert.equal(actual.headers['content-type'], 'application/json');
      assert.deepEqual(response.body, Buffer.from('{"ok":true}'));
    });
  }
});

test('broker rejects unauthorized and invalid requests before reading secrets', async (context) => {
  const { broker, record, token, state, received } = await fixture(context);
  const revoked = broker.grant('revoked-worker', [record.id]);
  broker.revoke('revoked-worker');
  const cases = [
    ['/i/linear', undefined, 401, 'unauthorized'],
    ['/i/linear', 'invalid-token', 401, 'unauthorized'],
    ['/i/linear', revoked, 401, 'unauthorized'],
    ['/i/ungranted', token, 403, 'forbidden'],
    ['/i/missing', token, 404, 'not_found'],
    ['/i/linear/../api-evil', token, 400, 'bad_request'],
    ['/i/linear/%2e%2e/secrets', token, 400, 'bad_request'],
    ['/i/linear/%E0%A4%A', token, 400, 'bad_request'],
    ['/i/linear/https://evil.test/x', token, 400, 'bad_request'],
    ['/i/linear///evil.test/x', token, 400, 'bad_request'],
    ['/i/linear#fragment', token, 404, 'not_found']
  ];
  for (const [route, capabilityToken, status, code] of cases) {
    const response = await requestBroker(broker, route, capabilityToken);
    assert.equal(response.status, status, route);
    assert.equal(JSON.parse(response.body).code, code);
  }
  record.enabled = false;
  assert.equal((await requestBroker(broker, '/i/linear', token)).status, 403);
  record.enabled = true;
  const baseUrl = record.baseUrl;
  record.baseUrl = 'invalid URL';
  assert.equal((await requestBroker(broker, '/i/linear', token)).status, 400);
  record.baseUrl = baseUrl;
  assert.equal(state.secretReads, 0);
  state.secret = undefined;
  const response = await requestBroker(broker, '/i/linear', token);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).code, 'no_secret');
  assert.equal(state.secretReads, 1);
  assert.equal(received.length, 0);
});

test('broker preserves redirects, malformed JSON and visible upstream failures', async (context) => {
  const { broker, record, origin, token, received } = await fixture(context);
  for (const status of [307, 308]) {
    record.baseUrl = `${origin}/redirect${status}`;
    const previousCount = received.length;
    const response = await requestBroker(broker, '/i/linear', token);
    assert.equal(response.status, status);
    assert.equal(response.headers.location, '/redirect-target');
    assert.equal(response.body.toString(), 'redirect');
    assert.equal(received.length, previousCount + 1, 'must not follow upstream redirects');
  }
  record.baseUrl = origin + '/malformed';
  const malformed = await requestBroker(broker, '/i/linear', token);
  assert.equal(malformed.status, 422);
  assert.deepEqual(malformed.body, Buffer.from('{"error":'));
  record.baseUrl = origin + '/disconnect';
  const failed = await requestBroker(broker, '/i/linear', token);
  assert.equal(failed.status, 502);
  assert.equal(JSON.parse(failed.body).code, 'bad_gateway');
});
