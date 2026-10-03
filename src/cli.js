#!/usr/bin/env node
/**
 * pzdesk: command line access to the PzDesk API toolkit.
 *
 *   pzdesk tags
 *   pzdesk ops [--area AREA] [--search "words"]
 *   pzdesk describe GET /billing/clients
 *   pzdesk call GET /billing/clients -q perPage=5
 *   pzdesk call POST /billing/clients -d '{"name":"Acme"}' --yes
 *   pzdesk tool pzdesk_call '{"method":"GET","path":"/billing/clients"}'
 *   pzdesk tools        print the function-calling tool definitions
 *   pzdesk sync         save a local openapi.yaml copy from PZDESK_URL/swagger.yaml (offline use, tests)
 *
 * Environment: PZDESK_URL, PZDESK_TOKEN, optional PZDESK_SPEC. See README.md.
 */
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {TOOLS, PzDeskError, createPzDesk} from './index.js';

const print = value => console.log(JSON.stringify(value, null, 2));

function pairs(list, label) {
  const out = {};
  for (const item of list ?? []) {
    const at = item.indexOf('=');
    if (at < 1) throw new PzDeskError(`${label} must look like name=value, got "${item}".`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const pz = createPzDesk();
  const {values, positionals} = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      area: {type: 'string'},
      search: {type: 'string'},
      'path-param': {type: 'string', short: 'p', multiple: true},
      query: {type: 'string', short: 'q', multiple: true},
      data: {type: 'string', short: 'd'},
      yes: {type: 'boolean'},
      output: {type: 'string'},
      out: {type: 'string'},
    },
  });

  switch (command) {
    case 'tags':
      print(await pz.listAreas());
      return 0;
    case 'ops':
      print(await pz.listOperations({area: values.area, search: values.search}));
      return 0;
    case 'describe':
      if (positionals.length < 2) throw new PzDeskError('Usage: pzdesk describe METHOD PATH');
      print(await pz.describeOperation(positionals[0], positionals[1]));
      return 0;
    case 'call': {
      if (positionals.length < 2) throw new PzDeskError('Usage: pzdesk call METHOD PATH [-p name=value] [-q name=value] [-d JSON|@file] [--yes]');
      let body;
      if (values.data) {
        const raw = values.data.startsWith('@') ? await readFile(values.data.slice(1), 'utf8') : values.data;
        try {
          body = JSON.parse(raw);
        } catch (error) {
          throw new PzDeskError(`--data is not valid JSON: ${error.message}`);
        }
      }
      const result = await pz.callOperation({
        method: positionals[0], path: positionals[1], path_params: pairs(values['path-param'], '--path-param'),
        query: pairs(values.query, '--query'), body, confirmed: Boolean(values.yes), save_to: values.output,
      });
      print(result);
      return result.needs_confirmation ? 2 : result.ok ? 0 : 1;
    }
    case 'tool': {
      if (!positionals.length) throw new PzDeskError('Usage: pzdesk tool NAME [JSON_ARGUMENTS]');
      const result = await pz.handleToolCall(positionals[0], positionals[1] ?? '{}');
      print(result);
      return result.error ? 1 : 0;
    }
    case 'tools':
      print(TOOLS);
      return 0;
    case 'sync':
      print(await pz.sync(values.out));
      return 0;
    default:
      console.error('Commands: tags, ops, describe, call, tool, tools, sync. See the header of src/cli.js or README.md.');
      return command ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then(code => {
    for (const warning of createPzDesk().warnings()) console.error(`warning: ${warning}`);
    process.exitCode = code;
  })
  .catch(error => {
    console.error(`error: ${error instanceof PzDeskError ? error.message : error.stack ?? error.message}`);
    process.exitCode = 1;
  });
