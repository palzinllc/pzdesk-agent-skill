import assert from 'node:assert/strict';
import {readFile, rm, readFile as read} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import {TOOLS, createPzDesk} from '../src/index.js';
import {SPEC, skipWithoutSpec} from './spec.js';

let server;
let url;
const received = [];
let swaggerBody;

before(async () => {
  swaggerBody = skipWithoutSpec ? Buffer.from('') : await readFile(SPEC);
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (req.url === '/swagger.yaml') {
      res.writeHead(200, {'Content-Type': 'application/yaml'});
      return res.end(swaggerBody);
    }
    received.push({method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body});
    const json = (code, data) => {
      res.writeHead(code, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(data));
    };
    if (req.url.startsWith('/api/v1/billing/clients') && req.method === 'POST' && body.includes('"name":""')) {
      return json(422, {message: 'The name field is required.', errors: {name: ['The name field is required.']}, exception: 'X', trace: [1, 2]});
    }
    if (req.url.startsWith('/api/v1/billing/rates')) return json(403, {message: 'This action is unauthorized.'});
    if (req.url.startsWith('/api/v1/billing/periods')) return json(401, {message: 'Unauthenticated.'});
    if (req.url.startsWith('/api/v1/billing/reports/sla/csv')) {
      res.writeHead(200, {'Content-Type': 'text/csv; charset=UTF-8'});
      return res.end('Client,Ticket\nAcme,1\n');
    }
    if (req.url.startsWith('/api/v1/billing/reports/sla/pdf')) {
      res.writeHead(200, {'Content-Type': 'application/pdf'});
      return res.end(Buffer.from('%PDF-1.4 fake'));
    }
    if (req.url.startsWith('/api/v1/billing/catalog')) return json(200, {big: 'x'.repeat(500)});
    return json(200, {status: 'success', echo: req.url});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const pz = () => createPzDesk({url, token: 'test-token-123'});

describe('discovery', {skip: skipWithoutSpec}, () => {
  test('lists every area with its operations', async () => {
    const areas = await pz().listAreas();
    const names = areas.map(a => a.area);
    for (const area of ['Conversations', 'Customers', 'Clients', 'Time tracking', 'SLA and business hours', 'Billing']) {
      assert.ok(names.includes(area), `${area} should be listed`);
    }
    assert.ok(areas.every(a => a.operations > 0));
  });

  test('searches by words and flags risky operations', async () => {
    const found = await pz().listOperations({search: 'time entries'});
    assert.equal(found.length, 3);
    assert.equal(found.find(o => o.method === 'DELETE').confirm_first, true);
    assert.equal(found.find(o => o.method === 'GET').confirm_first, false);
    assert.equal((await pz().listOperations({area: 'holidays'})).length, 4);
  });

  test('describes fields with types, required flags, enums and nested objects', async () => {
    const op = await pz().describeOperation('POST', '/helpdesk/agent/conversations/{conversationId}/messages');
    assert.match(op.confirm_first, /emailed to the customer/);
    const fields = Object.fromEntries(op.request_body_fields.map(f => [f.name, f]));
    assert.equal(fields.body.required, true);
    assert.deepEqual(fields.type.enum, ['note', 'message']);
    assert.equal(fields.time_entry.fields.find(f => f.name === 'duration').required, true);
    assert.ok(op.responses['201'].json_fields.includes('message'));
  });

  test('every documented operation can be described without errors', async () => {
    const instance = pz();
    const all = await instance.listOperations();
    assert.ok(all.length > 150);
    for (const {method, path} of all) await instance.describeOperation(method, path);
  });
});

describe('calling', {skip: skipWithoutSpec}, () => {
  test('sends GET requests with the bearer token and query string', async () => {
    received.length = 0;
    const result = await pz().callOperation({method: 'GET', path: '/billing/clients', query: {page: 2, perPage: 5}});
    assert.equal(result.status, 200);
    assert.equal(result.body.echo, '/api/v1/billing/clients?page=2&perPage=5');
    assert.equal(received[0].auth, 'Bearer test-token-123');
  });

  test('builds path parameters, keeping comma separated ids', async () => {
    const result = await pz().callOperation({
      method: 'DELETE', path: '/billing/clients/{ids}', path_params: {ids: '1,2'}, confirmed: true,
    });
    assert.equal(result.body.echo, '/api/v1/billing/clients/1,2');
  });

  test('does not send anything that changes data without confirmation', async () => {
    received.length = 0;
    const result = await pz().callOperation({method: 'POST', path: '/billing/clients', body: {name: 'Acme'}});
    assert.equal(result.sent, false);
    assert.equal(result.needs_confirmation, true);
    assert.equal(result.request.body.name, 'Acme');
    const del = await pz().callOperation({method: 'DELETE', path: '/billing/clients/{ids}', path_params: {ids: '3'}});
    assert.equal(del.needs_confirmation, true);
    assert.match(del.warning, /DESTRUCTIVE/);
    assert.equal(received.length, 0, 'the server must not have been called');
  });

  test('sends confirmed writes with a JSON body', async () => {
    received.length = 0;
    const result = await pz().callOperation({method: 'POST', path: '/billing/clients', body: {name: 'Acme'}, confirmed: true});
    assert.equal(result.status, 200);
    assert.equal(received[0].type, 'application/json');
    assert.deepEqual(JSON.parse(received[0].body), {name: 'Acme'});
  });

  test('rejects undocumented operations, fields and parameters before sending', async () => {
    received.length = 0;
    const call = args => pz().callOperation({confirmed: true, ...args});
    await assert.rejects(call({method: 'GET', path: '/billing/nonsense'}), /not documented/);
    await assert.rejects(call({method: 'GET', path: '/billing/clients/{id}/nonsense'}), /Did you mean: POST \/billing\/clients\/\{id\}\/users/);
    await assert.rejects(call({method: 'POST', path: '/billing/clients', body: {nme: 'x'}}), /Fields not documented.*nme/);
    await assert.rejects(call({method: 'POST', path: '/billing/clients', body: {notes: 'x'}}), /Missing required body fields: name/);
    await assert.rejects(call({method: 'POST', path: '/billing/clients'}), /needs a request body with: name/);
    await assert.rejects(call({method: 'GET', path: '/billing/clients/{id}'}), /Missing required path parameter "id"/);
    await assert.rejects(call({method: 'GET', path: '/billing/clients', query: {bogus: 1}}), /not a documented query parameter/);
    await assert.rejects(call({method: 'GET', path: '/billing/clients', body: {a: 1}}), /does not take a request body/);
    assert.equal(received.length, 0);
  });

  test('trims error responses and explains 401 and 403', async () => {
    const invalid = await pz().callOperation({method: 'POST', path: '/billing/clients', body: {name: ''}, confirmed: true});
    assert.equal(invalid.status, 422);
    assert.equal(invalid.ok, false);
    assert.deepEqual(Object.keys(invalid.body).sort(), ['errors', 'message']);

    const forbidden = await pz().callOperation({method: 'GET', path: '/billing/rates'});
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.hint, /permission/);

    const unauthenticated = await pz().callOperation({method: 'GET', path: '/billing/periods'});
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.hint, /api\.access/);
  });

  test('returns CSV text, saves PDFs and truncates huge responses', async () => {
    const csv = await pz().callOperation({method: 'GET', path: '/billing/reports/sla/csv', query: {period: 'previous_month'}});
    assert.match(csv.text, /Acme,1/);

    const file = join(tmpdir(), `pzdesk-${process.pid}.pdf`);
    const pdf = await pz().callOperation({method: 'GET', path: '/billing/reports/sla/pdf', save_to: file});
    assert.equal(pdf.bytes, 13);
    assert.equal((await read(file)).toString(), '%PDF-1.4 fake');
    await rm(file);

    const big = await pz().callOperation({method: 'GET', path: '/billing/catalog', max_chars: 100});
    assert.equal(big.truncated, true);
    assert.equal(big.body_text.length, 100);
  });

  test('reports a missing token or url clearly', async () => {
    await assert.rejects(createPzDesk({url, token: ''}).callOperation({method: 'GET', path: '/billing/clients'}), /PZDESK_TOKEN is not set/);
    await assert.rejects(createPzDesk({url: '', token: 'x', spec: SPEC}).callOperation({method: 'GET', path: '/billing/clients'}), /PZDESK_URL is not set/);
  });
});

describe('spec loading', {skip: skipWithoutSpec}, () => {
  test('prefers the live swagger.yaml and falls back to the local copy', async () => {
    const live = createPzDesk({url, token: 't'});
    await live.loadSpec();
    assert.deepEqual(live.warnings(), []);

    const fallback = createPzDesk({url: 'http://127.0.0.1:9', token: 't'});
    assert.ok((await fallback.listOperations()).length > 150);
    assert.ok(fallback.warnings().some(w => /local openapi\.yaml copy/.test(w)));
  });
});

describe('tool interface', () => {
  test('exposes three tools whose names match the dispatcher', {skip: skipWithoutSpec}, async () => {
    assert.deepEqual(TOOLS.map(t => t.function.name), ['pzdesk_find_operations', 'pzdesk_describe_operation', 'pzdesk_call']);
    const instance = pz();
    assert.ok((await instance.handleToolCall('pzdesk_find_operations', {})).areas.length > 20);
    assert.ok((await instance.handleToolCall('pzdesk_find_operations', {search: 'sla report'})).operations.length >= 3);
    assert.equal((await instance.handleToolCall('pzdesk_describe_operation', {method: 'get', path: '/billing/clients'})).method, 'GET');
  });

  test('accepts JSON string arguments and never throws', {skip: skipWithoutSpec}, async () => {
    const instance = pz();
    const ok = await instance.handleToolCall('pzdesk_call', JSON.stringify({method: 'GET', path: '/billing/clients'}));
    assert.equal(ok.status, 200);
    assert.match((await instance.handleToolCall('pzdesk_call', '{not json')).error, /not valid JSON/);
    assert.match((await instance.handleToolCall('pzdesk_call', {})).error, /Missing argument/);
    assert.match((await instance.handleToolCall('nope', {})).error, /Unknown tool/);
    assert.match((await instance.handleToolCall('pzdesk_call', {method: 'GET', path: '/x'})).error, /not documented/);
  });

  test('tools.json is in sync with the tool definitions', async () => {
    const file = JSON.parse(await readFile(new URL('../tools.json', import.meta.url), 'utf8'));
    assert.deepEqual(file, TOOLS, 'run: npm run build:tools');
  });
});
