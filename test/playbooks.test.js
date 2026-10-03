import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createPzDesk} from '../src/index.js';
import {SPEC, skipWithoutSpec} from './spec.js';

const pz = createPzDesk({url: '', token: '', spec: SPEC});
const playbooks = await readFile(new URL('../reference/playbooks.md', import.meta.url), 'utf8');
const lines = playbooks.split('\n');
const OP = /`(GET|POST|PUT|DELETE) (\/[^`\s]*)`/g;

/** Checks an example value against the described fields, returning a list of problems. */
function check(fields, value, where) {
  const problems = [];
  const byName = Object.fromEntries(fields.map(f => [f.name, f]));
  for (const [key, val] of Object.entries(value)) {
    const field = byName[key];
    if (!field) {
      problems.push(`${where}.${key} is not a documented field`);
      continue;
    }
    if (field.enum && !field.enum.includes(val)) problems.push(`${where}.${key}=${JSON.stringify(val)} is not one of ${field.enum.join(', ')}`);
    if (field.type === 'array' && !Array.isArray(val)) problems.push(`${where}.${key} should be an array`);
    if (field.fields) {
      for (const item of Array.isArray(val) ? val : [val]) {
        if (item && typeof item === 'object') problems.push(...check(field.fields, item, `${where}.${key}`));
      }
    }
  }
  return problems;
}

test('every operation named in the playbooks is documented', {skip: skipWithoutSpec}, async () => {
  const all = await pz.listOperations();
  const known = new Set(all.map(o => `${o.method} ${o.path}`));
  const missing = [];
  let count = 0;
  for (const line of lines) {
    for (const [, method, path] of line.matchAll(OP)) {
      count++;
      if (!known.has(`${method} ${path}`)) missing.push(`${method} ${path}`);
    }
  }
  assert.ok(count > 80, `expected many operations in the playbooks, found ${count}`);
  assert.deepEqual(missing, []);
});

test('every example body only uses documented fields, valid enum values and required fields', {skip: skipWithoutSpec}, async () => {
  let checked = 0;
  for (const line of lines) {
    const ops = [...line.matchAll(OP)];
    const bodies = [...line.matchAll(/(?:body|with body): `(\{.*?\})`(?=[ .,;]|$)/g)];
    for (const [, json] of bodies) {
      assert.equal(ops.length >= 1, true, `a body example needs an operation on the same line: ${line}`);
      const [, method, path] = ops[ops.length - 1];
      let value;
      assert.doesNotThrow(() => (value = JSON.parse(json)), `invalid JSON in: ${json}`);
      const description = await pz.describeOperation(method, path);
      assert.ok(description.request_body_fields, `${method} ${path} has no request body`);
      const problems = check(description.request_body_fields, value, `${method} ${path}`);
      if (method === 'POST') {
        for (const field of description.request_body_fields.filter(f => f.required)) {
          if (!(field.name in value)) problems.push(`${method} ${path} example is missing required ${field.name}`);
        }
      }
      assert.deepEqual(problems, [], line.trim());
      checked++;
    }
  }
  assert.ok(checked > 20, `expected many body examples, found ${checked}`);
});

test('query parameters named in the playbooks exist on the operation', {skip: skipWithoutSpec}, async () => {
  for (const line of lines) {
    const ops = [...line.matchAll(OP)];
    if (ops.length !== 1) continue;
    const [, method, path] = ops[0];
    const names = new Set();
    for (const [, list] of line.matchAll(/query ((?:`[^`]+`(?:, | and | or )?)+)/g)) {
      for (const [, token] of list.matchAll(/`([^`]+)`/g)) names.add(token.split('=')[0]);
    }
    for (const [, token] of line.matchAll(/`([a-zA-Z_]+=[^`]+)`/g)) names.add(token.split('=')[0]);
    if (!names.size) continue;
    const declared = (await pz.describeOperation(method, path)).parameters.filter(p => p.in === 'query').map(p => p.name);
    for (const name of names) assert.ok(declared.includes(name), `${method} ${path}: "${name}" is not a documented query parameter (${line.trim().slice(0, 90)})`);
  }
});

test('scenarios that write data tell the bot to ask for approval', () => {
  const sections = playbooks.split(/\n### /).slice(1);
  const unsafe = sections.filter(s => /WRITE `/.test(s) && !/(approve|approval|confirm|wait for|Ask the user|explicit)/i.test(s)).map(s => s.split('\n')[0]);
  assert.deepEqual(unsafe, []);
});
