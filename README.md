# pzdesk-agent-skill

A skill for AI bots (Grok or any bot that supports function calling) to manage a PzDesk helpdesk through its documented REST API: tickets, customers, team, settings, help center, and the time tracking and billing module.

It is three things in one package:

| File | What it is |
|---|---|
| `INSTRUCTIONS.md` | The bot's instructions (system prompt): how to work, what needs approval, what it must never do. |
| `reference/playbooks.md`, `reference/conventions.md` | Step-by-step call sequences per scenario, and API conventions. Give them to the bot as knowledge or load them on demand. |
| `tools.json`, `src/index.js` | Three function-calling tools and the code that runs them. |

The tools are generic on purpose (find an operation, describe it, call it) so the bot always has the whole API with only three tool definitions, and cannot call anything that is not documented.

## Setup

1. Create an access token for a user that has the `api.access` permission (Account settings > API access tokens). Use a user with only the permissions the bot should have.
2. Set the environment of the process that runs the tools:

```bash
export PZDESK_URL=https://helpdesk.example.com
export PZDESK_TOKEN=<access token>
```

3. Install: `npm install /path/to/pzdesk-agent-skill` (Node 18 or newer, one dependency: `yaml`).

The tools read the API description from your helpdesk, `PZDESK_URL/swagger.yaml`, so they always match the installed version. This repository does not contain that file. To work offline, or to run the tests, save a local copy with `PZDESK_URL=https://helpdesk.example.com npm run sync` (it is written to `openapi.yaml`, which git ignores) or point `PZDESK_SPEC` at a swagger file.

## Connect it to a bot

Any platform that supports function calling works the same way: send `INSTRUCTIONS.md` as the system prompt, pass the tool definitions, and run each tool call with `handleToolCall`. Example for an OpenAI-compatible chat API (Grok's API is one):

```js
import OpenAI from 'openai';
import {readFile} from 'node:fs/promises';
import {TOOLS, handleToolCall} from 'pzdesk-agent-skill';

const client = new OpenAI({apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1'});
const instructions = await readFile('node_modules/pzdesk-agent-skill/INSTRUCTIONS.md', 'utf8');
const playbooks = await readFile('node_modules/pzdesk-agent-skill/reference/playbooks.md', 'utf8');

const messages = [
  {role: 'system', content: `${instructions}\n\n${playbooks}`},
  {role: 'user', content: 'Reply to ticket 42 and tell the customer the menu is fixed.'},
];

for (;;) {
  const response = await client.chat.completions.create({model: '<model>', messages, tools: TOOLS});
  const message = response.choices[0].message;
  messages.push(message);
  if (!message.tool_calls?.length) break; // final answer for the user
  for (const call of message.tool_calls) {
    const result = await handleToolCall(call.function.name, call.function.arguments);
    messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result)});
  }
}
```

Keep the loop's conversation history: the bot asks the user for approval in its normal reply, and the user's "yes" arrives as the next message, after which the bot calls the tool again with `confirmed: true`. Platforms that import an OpenAPI file instead of function definitions can import your helpdesk's `/swagger.yaml`, but you then lose the approval gate and the validation that the tools provide.

## Command line

```bash
npx pzdesk tags                                   # API areas
npx pzdesk ops --search "time entries"            # find operations
npx pzdesk describe POST /billing/clients         # fields, allowed values, responses
npx pzdesk call GET /billing/clients -q perPage=5
npx pzdesk call POST /billing/clients -d '{"name":"Acme"}'        # dry run, nothing sent
npx pzdesk call POST /billing/clients -d '{"name":"Acme"}' --yes  # sends it
```

## Safety built into the tools

- Only operations documented in the helpdesk's OpenAPI file can be called. Unknown paths, fields and query parameters are rejected before anything is sent.
- Required parameters and body fields are checked before sending.
- POST, PUT and DELETE are never sent without `confirmed: true`; the bot gets back the exact request and a warning for emailing, irreversible or billing-affecting operations.
- Server debug traces are removed from error responses, and the token is never returned to the model.
- The access token decides what the bot can do. The API enforces permissions; the tools do not widen them.

## Maintenance

- After the helpdesk API changes: `npm run sync` (refresh your local `openapi.yaml`), `npm run build:tools`, `npm test`.
- `npm test` checks the tools against a local mock server, and checks that every operation, request field, enum value and query parameter named in `reference/playbooks.md` exists in the helpdesk's OpenAPI file, so the playbooks cannot drift from the API. These checks need the local `openapi.yaml` copy (or `PZDESK_SPEC`) and are skipped, with a message saying so, when there is none.

## License

[MIT](LICENSE). This license covers the code, instructions and playbooks in this repository. It does not cover your helpdesk software or its API description, which this repository does not contain.
