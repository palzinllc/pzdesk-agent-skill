# API conventions

All endpoints live under `{site}/api/v1` and take `Authorization: Bearer <token>`. The tools handle this for you; this file explains what comes back.

## Access and permissions

| Situation | Result |
|---|---|
| Token missing/invalid, or its user lacks `api.access` | `401` on every endpoint. Admins have `api.access` by default, agents only when it was granted to their role, customers never. |
| Agent with `api.access` | Can read clients, billing categories and the billing catalog, read/change/delete their own time entries, and classify tickets they can update. Everything else in billing returns `403`. |
| Admin | Everything. |

Billing permissions: `clients.update` (clients and members), `billing_rates.update` (categories and rates), `contracts.update`, `billing_settings.update` (holidays, business hours, SLA warnings, billing periods), `billing_reports.view` (time and billing report, SLA report, and rates/charges on time entries), `time_entries.update` (change any time entry). Each operation description names the permission it needs.

## Responses

- Success: `{"status":"success", "<name>": ...}`. Created resources answer `201`.
- Validation error `422`: `{"message":"The name field is required.","errors":{"name":["The name field is required."]}}`.
- Business-rule error `422`: `{"message":"This client already has a contract covering these dates. ...","errors":[]}`. The message is written for people: pass it on.
- `404`: the id does not exist. `403`: missing permission.
- Responses over 20,000 characters are cut off: narrow them with `perPage`, `page` or filters.

## Lists

Parameters: `page`, `perPage`, `query` (search), `orderBy`, `orderDir` (`asc`|`desc`, default `desc` by `updated_at`), `filters` (JSON-encoded) and `paginate`. The `pagination` object holds `current_page`, `data`, `from`, `to`, `per_page`, `next_page` and `prev_page`. `total` and `last_page` are only included with `paginate=lengthAware`. `next_page` is `null` on the last page.

Deleting several records takes comma-separated ids in the path, for example `/billing/clients/1,2` (path parameter `ids`).

## Tickets

- A ticket is a conversation with `type` `ticket` (the other type is `chat`). Closed means `status_category` 4 or lower. Status categories: 3 locked, 4 closed, 5 pending, 6 open.
- Message `type` is `message` (emailed to the customer) or `note` (internal).
- A ticket needs a billing category and type before an agent can close it. A customer or an automation can still close an unclassified ticket; those appear in the time and billing report under exceptions.
- The ticket number shown to people is `reference`; the numeric `id` is used in calls.

## Billing and time tracking

- A month is a calendar month in the business timezone from `GET /billing/settings`. Hours do not carry over.
- A contract has lines: one per billing category and type, with hours per month and optional SLA business days. Time above a line's hours is additional and charged at the client's rate, else the global rate. A rate is frozen on each time entry when it is logged. Entries logged with no rate are `is_unpriced` until a rate is set.
- Time input is `H:MM` (`1:30`) or decimal hours (`1.5`), rounded **up** to the configured increment, greater than zero, at most 24 hours.
- A billing period that is locked cannot be changed (time entries, contracts). Months lock automatically a few days after they end; admins can lock early or reopen.
- SLA is internal. It counts business days from the settings' business hours and holidays, pauses while a ticket is pending, restarts when a closed ticket is reopened, and is never shown to client customers.
- Reports: the time and billing report covers one month for all or one client (current month included). The SLA report counts tickets in the month their SLA started; compliance is met divided by met plus breached.
