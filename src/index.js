/**
 * PzDesk agent skill: lets an AI bot discover and call the documented PzDesk
 * REST API without guessing paths or fields.
 *
 * Three generic function-calling tools (TOOLS) work with any bot platform that
 * supports function calling (Grok, OpenAI-compatible APIs, ...):
 *
 *   import {TOOLS, handleToolCall} from 'pzdesk-agent-skill';
 *   // give TOOLS to the model, then for every tool call it makes:
 *   const result = await handleToolCall(name, args);   // plain JSON-serialisable object
 *
 * Configuration (environment variables, or the options of createPzDesk):
 *   PZDESK_URL    Site URL, e.g. https://helpdesk.example.com
 *   PZDESK_TOKEN  Access token of a user with the api.access permission
 *   PZDESK_SPEC   Optional path or URL of an OpenAPI file. Default: PZDESK_URL/swagger.yaml (the
 *                 helpdesk serves it), then an optional local openapi.yaml created by `npm run sync`.
 *
 * Safety: only operations documented in the spec can be called, and anything that
 * is not a GET is only sent when `confirmed` is true. The bot must set it only
 * after the human user approved that exact action.
 */
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';

/** Optional local copy of the helpdesk OpenAPI file, created by `npm run sync` and never committed. */
export const BUNDLED_SPEC = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/** Operations with effects beyond the helpdesk data itself: the user must approve them first. */
const SENSITIVE = {
  'POST /helpdesk/agent/conversations': 'Creates a conversation and emails the first message to the customer (tickets).',
  'POST /helpdesk/agent/conversations/{conversationId}/messages': 'type=message is emailed to the customer. type=note is internal. time_entry is billed to the client.',
  'POST /helpdesk/agent/conversations/merge': 'Merging conversations cannot be undone.',
  'POST /helpdesk/customers/merge': 'Merging customers cannot be undone.',
  'POST /helpdesk/agent/conversations/status/change': 'Closing a ticket notifies the customer and stops its SLA clock. Tickets must be classified for billing first.',
  'POST /helpdesk/agents/invite': 'Sends an invitation email.',
  'POST /helpdesk/agents/invite/{inviteId}/resend': 'Sends an invitation email.',
  'POST /billing/periods/{period}/lock': 'Locks a month: time entries in it can no longer be changed.',
  'POST /billing/periods/{period}/reopen': 'Makes a locked month editable, which can change client reports and charges.',
  'PUT /billing/settings': 'Changes the SLA deadlines of all open tickets.',
  'POST /billing/holidays': 'Changes the SLA deadlines of open tickets.',
  'PUT /billing/holidays/{id}': 'Changes the SLA deadlines of open tickets.',
  'POST /billing/rates': 'Prices time entries that were logged without a rate.',
  'PUT /billing/rates/{id}': 'Prices time entries that were logged without a rate.',
};

/** A problem the bot can fix by changing its request. The message says how. */
export class PzDeskError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PzDeskError';
  }
}

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pzdesk_find_operations',
      description:
        'Find PzDesk API operations. Call with no arguments to list the API areas. Filter by area (for example "Conversations", "Clients") and/or words from the operation name. Always find and describe an operation before calling it; never invent endpoints.',
      parameters: {
        type: 'object',
        properties: {
          area: {type: 'string', description: 'API area name, for example Conversations, Customers, Clients, Time tracking.'},
          search: {type: 'string', description: 'Words that must all appear in the method, path, summary or area, for example "time entries".'},
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pzdesk_describe_operation',
      description:
        'Show everything needed to call one operation: parameters, request body fields with types, required flags, allowed values and descriptions, the responses, and whether the user must confirm first.',
      parameters: {
        type: 'object',
        properties: {
          method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE']},
          path: {type: 'string', description: 'Path exactly as documented, for example /billing/clients/{id}.'},
        },
        required: ['method', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pzdesk_call',
      description:
        'Call a documented PzDesk operation. GET requests run immediately. Every other method (POST, PUT, DELETE) is NOT sent unless confirmed is true, and you may only set confirmed to true after the human user has approved that exact action in this conversation. Ids must come from earlier responses or the user, never guessed.',
      parameters: {
        type: 'object',
        properties: {
          method: {type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE']},
          path: {type: 'string', description: 'Path exactly as documented, with the {placeholders} kept, for example /billing/clients/{id}.'},
          path_params: {type: 'object', description: 'Values for the {placeholders} in the path, for example {"id": 12}.'},
          query: {type: 'object', description: 'Query string parameters, for example {"page": 1, "perPage": 15}.'},
          body: {type: 'object', description: 'JSON request body, using only the documented fields.'},
          confirmed: {type: 'boolean', description: 'true only after the user approved this exact non-GET action. Default false.'},
          save_to: {type: 'string', description: 'File path to store CSV or PDF downloads.'},
        },
        required: ['method', 'path'],
      },
    },
  },
];

const isUrl = value => /^https?:\/\//i.test(value);

async function fetchText(url, timeoutMs = 30000) {
  const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Creates a PzDesk toolkit. With no options it reads PZDESK_URL, PZDESK_TOKEN and
 * PZDESK_SPEC from the environment at call time.
 */
export function createPzDesk(options = {}) {
  const cfg = () => ({
    url: (options.url ?? process.env.PZDESK_URL ?? '').replace(/\/+$/, ''),
    token: options.token ?? process.env.PZDESK_TOKEN ?? '',
    spec: options.spec ?? process.env.PZDESK_SPEC ?? '',
  });

  let specCache = null;
  const warnings = [];

  /** Spec source order: PZDESK_SPEC, the live PZDESK_URL/swagger.yaml, the optional local copy. */
  async function loadSpec(reload = false) {
    if (specCache && !reload) return specCache;
    const {url, spec} = cfg();
    const sources = [];
    if (spec) sources.push(spec);
    else if (url) sources.push(`${url}/swagger.yaml`);
    sources.push(BUNDLED_SPEC);
    let lastError;
    for (const source of sources) {
      try {
        const text = isUrl(source) ? await fetchText(source) : await readFile(source, 'utf8');
        const parsed = parse(text);
        if (!parsed?.paths) throw new Error('not an OpenAPI file');
        if (source === BUNDLED_SPEC && sources.length > 1) {
          warnings.push('Using the local openapi.yaml copy, which may be older than the site.');
        }
        specCache = parsed;
        return parsed;
      } catch (error) {
        lastError = error;
        warnings.push(`Could not load ${source} (${error.message}).`);
      }
    }
    throw new PzDeskError(`Could not load the OpenAPI file (${lastError?.message}). Set PZDESK_URL (the helpdesk serves /swagger.yaml) or PZDESK_SPEC.`);
  }

  /** Follows $ref and merges allOf so a schema reads as one object. */
  function resolve(schema, seen = []) {
    if (!schema || typeof schema !== 'object') return {};
    if (schema.$ref) {
      const name = schema.$ref.split('/').pop();
      if (seen.includes(name)) return {};
      const target = specCache.components?.schemas?.[name];
      if (!target) throw new PzDeskError(`Unresolved reference ${schema.$ref} in the OpenAPI file.`);
      return resolve(target, [...seen, name]);
    }
    if (schema.allOf) {
      const merged = {type: 'object', properties: {}, required: []};
      for (const part of schema.allOf) {
        const resolved = resolve(part, seen);
        Object.assign(merged.properties, resolved.properties ?? {});
        merged.required.push(...(resolved.required ?? []));
      }
      if (schema.description) merged.description = schema.description;
      return merged;
    }
    return schema;
  }

  const operations = () => {
    const rows = [];
    for (const [path, ops] of Object.entries(specCache.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (METHODS.includes(method)) rows.push({method: method.toUpperCase(), path, op});
      }
    }
    return rows;
  };

  const risk = (method, path) => (method === 'DELETE' ? 'DESTRUCTIVE: deletes data and cannot be undone.' : SENSITIVE[`${method} ${path}`] ?? null);

  function find(method, path) {
    method = String(method).toUpperCase();
    const op = specCache.paths[path]?.[method.toLowerCase()];
    if (!op) {
      const near = operations()
        .filter(o => o.path === path || o.path.split('/').slice(0, -1).join('/') === path.split('/').slice(0, -1).join('/'))
        .slice(0, 8)
        .map(o => `${o.method} ${o.path}`);
      const hint = near.length ? ` Did you mean: ${near.join(', ')}?` : ' Use pzdesk_find_operations to search.';
      throw new PzDeskError(`${method} ${path} is not documented, so it cannot be called.${hint}`);
    }
    return {method, op};
  }

  const bodySchema = op => {
    const schema = op.requestBody?.content?.['application/json']?.schema;
    return schema ? resolve(schema) : null;
  };

  const clean = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ');

  async function listAreas() {
    await loadSpec();
    const counts = new Map();
    for (const {op} of operations()) for (const tag of op.tags ?? ['(untagged)']) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const order = (specCache.tags ?? []).map(t => t.name);
    return [...new Set([...order, ...counts.keys()])].filter(t => counts.has(t)).map(area => ({area, operations: counts.get(area)}));
  }

  async function listOperations({area, search} = {}) {
    await loadSpec();
    return operations()
      .filter(({method, path, op}) => {
        const tags = op.tags ?? ['(untagged)'];
        if (area && !tags.some(t => t.toLowerCase() === area.toLowerCase())) return false;
        const text = `${method} ${path} ${op.summary ?? ''} ${tags.join(' ')}`.toLowerCase();
        return !search || search.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
      })
      .map(({method, path, op}) => ({
        method, path, summary: op.summary ?? '', area: (op.tags ?? ['(untagged)'])[0], confirm_first: Boolean(risk(method, path)),
      }));
  }

  function describeFields(schema, required = []) {
    schema = resolve(schema);
    return Object.entries(schema.properties ?? {}).map(([name, raw]) => {
      const prop = resolve(raw);
      const type = prop.type ?? (prop.properties ? 'object' : 'unknown');
      const item = type === 'array' ? resolve(prop.items ?? {}) : null;
      const field = {name, type, description: clean(prop.description)};
      if (required.includes(name) || (schema.required ?? []).includes(name)) field.required = true;
      for (const key of ['nullable', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'default']) {
        if (key in prop) field[key] = prop[key];
      }
      const nested = item?.properties ? item : prop;
      if (nested.properties) field.fields = describeFields(nested);
      if (item?.type && !item.properties) field.items = item.type;
      return field;
    });
  }

  async function describeOperation(method, path) {
    await loadSpec();
    const found = find(method, path);
    const {op} = found;
    method = found.method;
    const parameters = (op.parameters ?? []).map(p => {
      const schema = resolve(p.schema ?? {});
      const entry = {name: p.name, in: p.in, type: schema.type ?? 'unknown', required: Boolean(p.required), description: p.description ?? ''};
      for (const key of ['enum', 'default']) if (key in schema) entry[key] = schema[key];
      return entry;
    });
    const responses = {};
    for (const [code, response] of Object.entries(op.responses ?? {})) {
      const resolved = response.$ref ? resolve(response) : response;
      const entry = {description: clean(resolved.description)};
      for (const [mime, content] of Object.entries(response.content ?? {})) {
        if (mime === 'application/json' && content.schema) entry.json_fields = Object.keys(resolve(content.schema).properties ?? {});
        else entry.content_type = mime;
      }
      responses[code] = entry;
    }
    const body = bodySchema(op);
    return {
      method, path, area: (op.tags ?? [''])[0], summary: op.summary ?? '', description: clean(op.description),
      confirm_first: risk(method, path), parameters,
      request_body_fields: body ? describeFields(body, body.required ?? []) : null,
      responses,
    };
  }

  async function callOperation({method, path, path_params, query, body, confirmed = false, save_to, max_chars = 20000}) {
    await loadSpec();
    const found = find(method, path);
    const {op} = found;
    method = found.method;
    const pathParams = Object.fromEntries(Object.entries(path_params ?? {}).map(([k, v]) => [k, String(v)]));
    const queryParams = Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null));

    const declared = new Map((op.parameters ?? []).map(p => [`${p.in}:${p.name}`, p]));
    for (const name of Object.keys(pathParams)) {
      if (!declared.has(`path:${name}`)) throw new PzDeskError(`"${name}" is not a path parameter of ${method} ${path}.`);
    }
    for (const name of Object.keys(queryParams)) {
      if (!declared.has(`query:${name}`)) throw new PzDeskError(`"${name}" is not a documented query parameter of ${method} ${path}. Use pzdesk_describe_operation.`);
    }
    for (const p of declared.values()) {
      const supplied = p.in === 'path' ? pathParams : queryParams;
      if (p.required && !(p.name in supplied)) throw new PzDeskError(`Missing required ${p.in} parameter "${p.name}".`);
    }

    const schema = bodySchema(op);
    if (body !== undefined && body !== null) {
      if (!schema) throw new PzDeskError(`${method} ${path} does not take a request body.`);
      if (typeof body !== 'object' || Array.isArray(body)) throw new PzDeskError('The request body must be a JSON object.');
      const unknown = Object.keys(body).filter(k => !(k in (schema.properties ?? {})));
      if (unknown.length) throw new PzDeskError(`Fields not documented for ${method} ${path}: ${unknown.join(', ')}. Use pzdesk_describe_operation.`);
      const missing = (schema.required ?? []).filter(k => !(k in body));
      if (missing.length) throw new PzDeskError(`Missing required body fields: ${missing.join(', ')}.`);
    } else if (schema?.required?.length && method !== 'GET') {
      throw new PzDeskError(`${method} ${path} needs a request body with: ${schema.required.join(', ')}.`);
    }

    let urlPath = path;
    for (const [name, value] of Object.entries(pathParams)) {
      urlPath = urlPath.replace(`{${name}}`, encodeURIComponent(value).replace(/%2C/gi, ','));
    }
    const {url: site, token} = cfg();
    if (!site) throw new PzDeskError('PZDESK_URL is not set.');
    let url = `${site}/api/v1${urlPath}`;
    const search = new URLSearchParams(Object.entries(queryParams).map(([k, v]) => [k, String(v)])).toString();
    if (search) url += `?${search}`;

    if (method !== 'GET' && !confirmed) {
      return {
        sent: false,
        needs_confirmation: true,
        message: 'Nothing was sent. Show this request to the user, and only if they approve it call again with confirmed=true.',
        request: {method, url, body: body ?? null},
        warning: risk(method, path),
      };
    }
    if (!token) throw new PzDeskError('PZDESK_TOKEN is not set.');

    const headers = {Authorization: `Bearer ${token}`, Accept: 'application/json'};
    const init = {method, headers, signal: AbortSignal.timeout(60000)};
    if (body !== undefined && body !== null) {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new PzDeskError(`Could not reach ${url}: ${error.cause?.code ?? error.message}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const status = response.status;
    const result = {sent: true, status, ok: status < 400};
    if (status === 401) result.hint = '401: the token is missing or invalid, or its user lacks the api.access permission.';
    if (status === 403) result.hint = '403: the token user lacks the permission this operation needs. Read the operation description.';

    if (contentType.includes('json')) {
      let parsed = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      if (status >= 400 && parsed && typeof parsed === 'object') {
        // drop server debug traces, keep what helps the bot fix the request
        const kept = Object.fromEntries(Object.entries(parsed).filter(([k]) => ['message', 'errors'].includes(k)));
        if (Object.keys(kept).length) parsed = kept;
      }
      const text = JSON.stringify(parsed);
      if (text && text.length > max_chars) {
        result.truncated = true;
        result.note = `Response was ${text.length} characters. Narrow it with perPage, page or filters.`;
        result.body_text = text.slice(0, max_chars);
      } else {
        result.body = parsed;
      }
    } else if (save_to) {
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(save_to, buffer);
      Object.assign(result, {saved_to: save_to, bytes: buffer.length, content_type: contentType});
    } else if (contentType.startsWith('text/') || contentType.includes('csv')) {
      const text = await response.text();
      Object.assign(result, {content_type: contentType, text: text.slice(0, max_chars)});
      if (text.length > max_chars) result.truncated = true;
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      Object.assign(result, {content_type: contentType, bytes: buffer.length, note: 'Binary file. Pass save_to with a file path to keep it.'});
    }
    return result;
  }

  /** Runs one tool call. `args` is an object or a JSON string. Always resolves to a plain object. */
  async function handleToolCall(name, args = {}) {
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch (error) {
        return {error: `The tool arguments are not valid JSON: ${error.message}`};
      }
    }
    args = args ?? {};
    try {
      if (name === 'pzdesk_find_operations') {
        if (!args.area && !args.search) return {areas: await listAreas()};
        return {operations: await listOperations(args)};
      }
      if (name === 'pzdesk_describe_operation') {
        if (!args.method || !args.path) return {error: 'Missing argument method or path.'};
        return await describeOperation(args.method, args.path);
      }
      if (name === 'pzdesk_call') {
        if (!args.method || !args.path) return {error: 'Missing argument method or path.'};
        return await callOperation(args);
      }
      return {error: `Unknown tool "${name}". Available: ${TOOLS.map(t => t.function.name).join(', ')}`};
    } catch (error) {
      if (error instanceof PzDeskError) return {error: error.message};
      return {error: `Unexpected error: ${error.message}`};
    }
  }

  /** Downloads the live swagger.yaml and stores it as the local openapi.yaml copy (or `out`). */
  async function sync(out = BUNDLED_SPEC) {
    const {url, spec} = cfg();
    const source = spec || (url ? `${url}/swagger.yaml` : '');
    if (!source) throw new PzDeskError('Set PZDESK_URL (or PZDESK_SPEC) first.');
    const text = isUrl(source) ? await fetchText(source) : await readFile(source, 'utf8');
    const parsed = parse(text);
    if (!parsed?.paths) throw new PzDeskError('The downloaded file does not look like an OpenAPI file.');
    await writeFile(out, text);
    return {updated: out, source, paths: Object.keys(parsed.paths).length};
  }

  return {
    TOOLS, loadSpec, listAreas, listOperations, describeOperation, callOperation, handleToolCall, sync,
    warnings: () => [...warnings],
  };
}

// Default instance configured from the environment, for convenience.
const defaultInstance = createPzDesk();
export const {listAreas, listOperations, describeOperation, callOperation, handleToolCall, sync, loadSpec} = defaultInstance;
