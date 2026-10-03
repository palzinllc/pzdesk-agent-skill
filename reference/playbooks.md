# Playbooks: which calls to make, in which order

Every scenario lists what you need first, then the exact sequence. Rules for all of them:

- Steps marked **READ** are GET calls you can make freely. Steps marked **WRITE** change data: show the user exactly what you will send and wait for approval before setting `confirmed: true`.
- Ids always come from a previous READ or from the user. Never guess an id, a category, a status or a permission.
- Before the first call of a scenario you have not used in this conversation, call `pzdesk_describe_operation` for the WRITE step to see its fields and allowed values.
- If a step returns an error, read `message` and `errors`, fix the request and retry once. If it still fails, stop and tell the user what the API said.

Contents: [Tickets](#tickets) · [Customers and saved replies](#customers-and-saved-replies) · [Team](#team) · [Helpdesk configuration](#helpdesk-configuration) · [Help center](#help-center) · [Billing and time tracking](#billing-and-time-tracking) · [Reports](#reports)

---

## Tickets

### Find tickets
Needs: what the user is looking for (a customer, a status, an agent, words from the subject).
1. READ `GET /helpdesk/agent/conversations` with query `status`, `assigned_to`, `group_id`, `viewId`, `perPage` to filter; or
2. READ `GET /search/conversations` with query `query` for words, a customer name or an email address.
3. If more than one ticket could be the one the user means, list the candidates (id, subject, customer, status) and ask which. Do not pick one yourself.

### Read a ticket
Needs: the ticket id (find it first if the user gave a description).
1. READ `GET /helpdesk/agent/conversations/{id}` with path id. Note the `type` (ticket or chat), `status_category` (4 or lower means closed), the customer in `user`, and `billing` (client, `needs_classification`, billing category and type, SLA, total logged minutes).
2. READ `GET /helpdesk/agent/conversations/{conversationId}/messages` to read the conversation. Pass `cursor` from `next_cursor` for older messages.
3. READ `GET /helpdesk/agent/conversations/{conversationId}/time-entries` if the user asks about logged time.

### Reply to a customer in a ticket
Needs: the ticket id, the reply text, whether it goes to the customer (`message`) or stays internal (`note`). Optional: a new status, time spent.
1. If you do not have the ticket id: do **Find tickets** first.
2. READ `GET /helpdesk/agent/conversations/{id}`. Check that it is a ticket, see whether it is already closed, and read `billing`.
3. READ `GET /helpdesk/agent/conversations/{conversationId}/messages` so the reply answers what the customer actually asked.
4. Optional, to reuse approved wording: READ `GET /helpdesk/canned-replies` with query `query` (words from the reply name) and use its `body`.
5. Optional, only if the user wants to log time on this reply: READ `GET /billing/catalog` and take the exact category id and type. The user must tell you the duration (`1:30` or `1.5`) and the category. See **Log time on a ticket**.
6. Ask the user to approve the final reply. Show: ticket id and subject, who receives it (a `message` is emailed to the customer), the exact text, the status you will set (if any) and the time you will log (if any). Do not continue without a clear yes.
7. WRITE `POST /helpdesk/agent/conversations/{conversationId}/messages` with path conversationId and body: `{"body":"Thank you for contacting us. The menu is fixed.","type":"message"}`.
   - Add `"status_id": <id>` only if the user asked to change the status. Get valid ids from READ `GET /helpdesk/statuses/list` with query `label=agent`. Closing needs the ticket to have a billing category and type, otherwise the API answers 422 and nothing is saved.
   - Add `"time_entry": {"duration": "1:30", "billing_category_id": 1, "type": "regular"}` only when the user gave the time. If the time is invalid the whole request is rejected.
8. Verify: the answer is HTTP 201 with the new `message`. If you logged time, READ `GET /helpdesk/agent/conversations/{conversationId}/time-entries` and tell the user the stored duration (it is rounded up to the configured increment, for example 1:25 becomes 1:30).
9. Tell the user what was sent and to whom.
File attachments are not supported by this toolkit (uploads need a multipart request). Tell the user if they ask for one.

### Add an internal note
Needs: the ticket id and the note text. Notes are never sent to the customer.
1. READ `GET /helpdesk/agent/conversations/{id}` to confirm the ticket.
2. WRITE `POST /helpdesk/agent/conversations/{conversationId}/messages` with body: `{"body":"Customer called, waiting for their hosting provider.","type":"note"}`.
3. Verify HTTP 201.

### Create a ticket for a customer
Needs: the customer, a subject and the first message. If the customer belongs to a client company, also a billing category and type.
1. READ `GET /helpdesk/customers` with query `query` set to the email or name. If several match, ask the user which one. If none match, stop: customers cannot be created with this toolkit.
2. READ `GET /billing/catalog` for the active billing categories and the types.
3. Ask the user for the subject, the message and, if the customer belongs to a client, the billing category and type. Show the full ticket and wait for approval: the first message is emailed to the customer.
4. WRITE `POST /helpdesk/agent/conversations` with body: `{"type":"ticket","user_id":12,"subject":"Question about invoice","message":{"body":"Hello, we are looking into your invoice."},"billing_category_id":1,"billing_type":"regular"}`. Add `"client_id"` when the customer belongs to several clients.
5. If the API answers 422 "Choose a client for this ticket", READ `GET /billing/clients` with query `query`, ask the user which client, and retry. If it answers "Choose a billing category", ask the user for one.
6. Verify the returned `conversation` and tell the user the ticket id.

### Assign tickets to an agent
Needs: the ticket ids and the agent.
1. READ `GET /helpdesk/compact-agents` (or `GET /helpdesk/agents` with query `query` for a name). Take the agent id. Ask if the name is ambiguous.
2. Ask the user to approve: which tickets go to which agent.
3. WRITE `POST /helpdesk/agent/conversations/assignee/change` with body: `{"conversationIds":[1,2],"userId":5}`.
4. Verify with READ `GET /helpdesk/agent/conversations/{id}` that `assignee` is the agent.

### Move tickets to a group
1. READ `GET /helpdesk/groups` and take the group id.
2. Ask the user to approve the tickets and the group.
3. WRITE `POST /helpdesk/agent/conversations/group/change` with body: `{"conversationIds":[1,2],"groupId":3}`.

### Change the status of a ticket or close it
Needs: the ticket ids and the target status.
1. READ `GET /helpdesk/statuses/list` with query `label=agent` and take the status id (category 4 or 3 means closed).
2. When closing: READ `GET /helpdesk/agent/conversations/{id}` for each ticket and check `billing.billing_category_id` and `billing.billing_type`. If either is missing, do **Classify a ticket for billing** first, or the API answers 422.
3. Closing notifies the customer. Ask the user to approve the list of tickets and the status.
4. WRITE `POST /helpdesk/agent/conversations/status/change` with body: `{"conversationIds":[1,2],"statusId":4}`.
5. Verify HTTP 200. Reopening a closed ticket restarts its SLA clock; mention that to the user.

### Tag tickets
1. READ `GET /helpdesk/conversations/{conversationId}/tags` to see the tags already on the ticket.
2. Ask the user to approve the tag and the tickets.
3. WRITE `POST /helpdesk/conversations/tags/add` with body: `{"tagId":4,"conversationIds":[1,2]}`, or `{"newTagName":"refund","conversationIds":[1,2]}` to create the tag.
4. To remove: WRITE `POST /helpdesk/conversations/tags/remove` (describe it first for its fields).

### Merge duplicate tickets
Needs: the ticket to keep and the tickets to merge into it. Merging cannot be undone.
1. READ `GET /helpdesk/agent/conversations/{id}` for each ticket and show the user the subject and customer of each.
2. Ask the user to confirm which ticket is kept and which are merged.
3. WRITE `POST /helpdesk/agent/conversations/merge` with body: `{"conversationId":1,"toMerge":[2,3]}`.

### Delete tickets
Only when the user explicitly asks. Deleting cannot be undone, and a ticket with logged time cannot be deleted.
1. READ `GET /helpdesk/agent/conversations/{id}` and show the subject.
2. WRITE `DELETE /helpdesk/agent/conversations/{ids}` with path ids as comma separated ids.

---

## Customers and saved replies

### Look up or update a customer
1. READ `GET /helpdesk/customers` with query `query` (name or email). If several match, ask.
2. READ `GET /helpdesk/customers/{id}` for the details, and `GET /helpdesk/customers/{id}/conversations` for their tickets.
3. To change details, show the user the exact change and wait for approval, then WRITE `PUT /helpdesk/customers/{id}` with only the fields to change, for example `{"name":"Jane Customer","notes":"Prefers email"}`.

### Merge two customers
Merging cannot be undone.
1. READ `GET /helpdesk/customers/{id}` for both customers and show them to the user.
2. Ask the user which one is kept.
3. WRITE `POST /helpdesk/customers/merge` with body: `{"user_id":10,"mergee_id":11}`.

### Create or change a saved reply
1. READ `GET /helpdesk/canned-replies` with query `query` to check that a similar reply does not exist.
2. Show the user the name and text and ask for approval, then WRITE `POST /helpdesk/canned-replies` with body: `{"name":"Password reset","body":"Use the Forgot password link on the login page.","shared":true}`.
3. To change one: READ the reply with `GET /helpdesk/canned-replies/{id}`, then WRITE `PUT /helpdesk/canned-replies/{id}`.

---

## Team

### Invite a new agent
Needs: the email addresses, the role and the group.
1. READ `GET /helpdesk/groups` for the group id. The role id is not listed by this API: ask the user for it, or copy it from an existing agent with READ `GET /helpdesk/agents/{agentId}` (field `roles`).
2. Ask the user to approve: invitation emails are sent.
3. WRITE `POST /helpdesk/agents/invite` with body: `{"emails":["new.agent@example.com"],"role_id":2,"group_id":1}`.
4. Verify with READ `GET /helpdesk/agents/invites`. To resend: WRITE `POST /helpdesk/agents/invite/{inviteId}/resend`. To revoke: WRITE `DELETE /helpdesk/agents/invite/{inviteId}`.

### Change an agent
1. READ `GET /helpdesk/agents` with query `query` and then `GET /helpdesk/agents/{agentId}`.
2. WRITE `PUT /helpdesk/agents/{agentId}` with only the changed fields, for example `{"agent_settings":{"assignment_limit":8}}`. Roles and permissions replace the existing list, so read the current ones first and send the complete new list.
3. Removing an agent is `DELETE /helpdesk/agents/{agentId}`. Only on an explicit request.

### Create a group
1. READ `GET /helpdesk/groups` to check the name is not taken.
2. READ `GET /helpdesk/compact-agents` for the member ids.
3. Ask the user to approve the name, the assignment mode and the members, then WRITE `POST /helpdesk/groups` with body: `{"name":"Billing","assignment_mode":"auto","users":[{"id":5,"conversation_priority":"primary"}]}`.

---

## Helpdesk configuration

### Create a status
1. READ `GET /helpdesk/statuses` to see the existing statuses and categories (3 locked, 4 closed, 5 pending, 6 open).
2. Ask the user to approve the label and category, then WRITE `POST /helpdesk/statuses` with body: `{"label":"Awaiting customer","category":5}`.

### Create an inbox view
1. READ `GET /helpdesk/attributes/list` and `GET /helpdesk/statuses/list` with query `label=agent` for the ids used in conditions.
2. READ `GET /helpdesk/views` to avoid duplicates.
3. Ask the user to approve the view, then WRITE `POST /helpdesk/views` with body: `{"name":"Open billing tickets","access":"anyone"}`. Describe the operation for the `conditions` format before adding conditions.

### Create a custom attribute
1. READ `GET /helpdesk/attributes` to avoid duplicates.
2. Ask the user to approve the attribute, then WRITE `POST /helpdesk/attributes` with body: `{"name":"Order number","type":"conversation","format":"text","permission":"agentCanEdit"}`.

### Create an automation trigger
Trigger conditions and actions only accept the names the system defines, so read them first.
1. READ `GET /triggers/config` and note the exact condition names, operators, match types and action names. Do not invent them.
2. READ `GET /triggers` to see similar triggers.
3. Show the user the trigger in plain words and ask for approval: it will run automatically on future tickets.
4. WRITE `POST /triggers` with `name`, `conditions` and `actions` built only from the config, then verify with READ `GET /triggers/{trigger}`.

---

## Help center

### Publish an article
Needs: the title, the body, the category and section.
1. READ `GET /hc/manager/categories`, then READ `GET /hc/manager/categories/{categoryId}/sections` to find the section id.
2. READ `GET /search/articles` with query `query` (words from the title) to check the article does not already exist.
3. Show the user the title, body and where it will be published. Ask for approval.
4. WRITE `POST /hc/articles` with body: `{"title":"How to reset your password","body":"<p>Use the Forgot password link.</p>","sections":[3],"draft":true}`. Keep `draft` true unless the user asked to publish.
5. Verify with READ `GET /hc/articles/{articleId}`.

### Create a category
1. READ `GET /hc/manager/categories`.
2. Ask the user to approve the name and where it goes, then WRITE `POST /hc/categories` with body: `{"name":"Getting started","description":"First steps"}`. For a section, set `parent_id` to the category id.

---

## Billing and time tracking

### Set up billing for the first time (strict order)
Each step needs the one before it. Ask the user for the values; do not invent rates or hours.
1. READ `GET /billing/settings`, then WRITE `PUT /billing/settings` with the complete settings object (all fields are required). Changing it recalculates the SLA deadlines of open tickets.
2. WRITE `POST /billing/holidays` for each non-working day: `{"date":"2026-12-25","name":"Christmas Day"}`.
3. WRITE `POST /billing/categories` for each kind of work: `{"name":"CMS Support"}`.
4. WRITE `POST /billing/rates` for every category and type: `{"billing_category_id":1,"type":"regular","rate":60}` (dollars per hour).
5. WRITE `POST /billing/clients` for each company: `{"name":"Acme Corporation"}`.
6. WRITE `POST /billing/clients/{id}/users` for each customer of the company: `{"user_id":12,"role":"admin"}` (admin sees the portal dashboard and all company tickets, member only their own).
7. WRITE `POST /billing/contracts` for each client, see **Create a client contract**.

### Create a client contract
Needs: the client, the start date, and for each billing category and type the hours per month (and optionally SLA business days).
1. READ `GET /billing/clients` with query `query` for the client id, `GET /billing/categories` for category ids, and `GET /billing/contracts` with query `client_id` to see whether the client already has a contract. A client can only have one active contract; use **Change a client contract** instead.
2. Show the user the contract and wait for approval.
3. WRITE `POST /billing/contracts` with body: `{"client_id":1,"starts_on":"2026-01-01","lines":[{"billing_category_id":1,"type":"regular","hours":25,"sla_business_days":3}]}`.
4. Verify the returned `total_minutes_per_month`. A 422 about overlapping dates or duplicate category and type means the request must change.

### Change a client contract
1. READ `GET /billing/contracts` with query `client_id`, take the contract id, and READ `GET /billing/contracts/{id}`.
2. Ask the user from which month the change applies. Earlier months keep their hours; months in a locked period cannot change.
3. WRITE `PUT /billing/contracts/{id}` with the complete new `lines` list (it replaces the current lines), `starts_on` and `effective_from`: `{"starts_on":"2026-01-01","effective_from":"2026-11-01","lines":[{"billing_category_id":1,"type":"regular","hours":30}]}`.
4. A contract that has time entries cannot be deleted; set an end date with `PUT` instead.

### Change a rate
1. READ `GET /billing/rates` (global) or `GET /billing/rates` with query `client_id` (client overrides).
2. Ask the user to confirm the new amount. Existing time entries keep the rate frozen on them; only entries logged without a rate get priced.
3. WRITE `PUT /billing/rates/{id}` with body: `{"rate":65}`.
4. To add a rate that does not exist yet, WRITE `POST /billing/rates` with body: `{"billing_category_id":1,"type":"regular","rate":60}`.

### Classify a ticket for billing
Needs: the ticket id, and the client, billing category and type from the user. A ticket must be classified before it can be closed and before its SLA can start.
1. READ `GET /helpdesk/agent/conversations/{id}` and look at `billing` (client, category, type, `customer_clients`).
2. READ `GET /billing/catalog` for the active categories and types. If the client is also unknown, READ `GET /billing/clients` with query `query`.
3. Ask the user to confirm the client, category and type.
4. WRITE `PUT /helpdesk/agent/conversations/{id}/billing` with body: `{"client_id":1,"billing_category_id":1,"billing_type":"regular"}`. Send both category and type unless the ticket already has the other one. Agents can only set a missing client; moving a ticket that already has a client needs the clients.update permission (403 otherwise).
5. Verify the returned `billing`, including `sla` (due date) when the client's contract has SLA days for that category and type.

### Log time on a ticket
Time is logged together with a reply or an internal note; there is no standalone call.
Needs: the ticket id, the duration (`1:30` or `1.5`, rounded up to the configured increment, at most 24 hours), the billing category and the type.
1. READ `GET /billing/catalog` for category ids, types and the `rounding_increment`.
2. READ `GET /helpdesk/agent/conversations/{id}` to confirm it is a ticket and read `billing`.
3. Ask the user for the note or reply text that goes with the time. If they only want to record time, suggest an internal note and ask for its text.
4. Show the user the entry (duration, category, type, note text) and wait for approval.
5. WRITE `POST /helpdesk/agent/conversations/{conversationId}/messages` with body: `{"body":"Updated the menu structure.","type":"note","time_entry":{"duration":"1:30","billing_category_id":1,"type":"regular"}}`.
6. Verify with READ `GET /helpdesk/agent/conversations/{conversationId}/time-entries` and report the stored duration and whether it is included in the contract or additional.
7. A 422 "This billing period is locked" means the month is closed: tell the user, do not retry.

### Correct or delete a time entry
1. READ `GET /helpdesk/agent/conversations/{conversationId}/time-entries` and show the entries (id, agent, duration, category). Check `can_edit` and `locked`; do not try entries where they are false.
2. Ask the user which entry and the correction.
3. WRITE `PUT /helpdesk/agent/time-entries/{id}` with only what changes: `{"duration":"2.5"}`, or WRITE `DELETE /helpdesk/agent/time-entries/{id}` when the user explicitly asks to delete it.
4. Agents can change only their own entries unless they have the time_entries.update permission (403 otherwise).

### Time and billing report for a month
Needs: the month and optionally one client.
1. READ `GET /billing/clients` with query `query` if the user named a client.
2. READ `GET /billing/reports/admin` with query `period` (any date in the month, for example `2026-10-01`) and optional `client_id`.
3. Summarize: total used, included in contract, additional hours and charge per client; list the `exceptions` (tickets closed without classification, unpriced entries, tickets without a client). `charge_pending` means no rate exists yet.
4. For a file: READ `GET /billing/reports/admin/pdf` or `GET /billing/reports/admin/csv` with the same query and `save_to` set to a file path.

### SLA report by client
Needs: the period (this month, previous month or a specific month) and optionally one client.
1. READ `GET /billing/reports/sla` with query `period` set to `this_month`, `previous_month` or a date such as `2026-09-01`, and optional `client_id`.
2. Summarize per client: tickets, met, breached, open, compliance percent. Compliance is met divided by met plus breached. Name the breached tickets with their overdue time.
3. For a file: READ `GET /billing/reports/sla/pdf` or `GET /billing/reports/sla/csv` with the same query and `save_to`.

### Lock or reopen a billing month
1. READ `GET /billing/periods` and find the month (`period` is the first day, `locked` tells the state). The current month cannot be locked until it ends.
2. Explain the effect and ask the user to approve. Locking stops any change to that month's time entries. Reopening allows changes again and can change client reports and charges; it is recorded in the audit trail.
3. WRITE `POST /billing/periods/{period}/lock` or `POST /billing/periods/{period}/reopen` with path period set to the first day of the month.
4. Verify with READ `GET /billing/periods`.

### Change business hours or SLA warnings
1. READ `GET /billing/settings`. Keep the whole object.
2. Change only what the user asked for and ask for approval: this recalculates the SLA deadlines of all open tickets.
3. WRITE `PUT /billing/settings` with the complete settings object (every field is required, at least one working day must stay enabled).

---

## Reports

### Helpdesk performance
1. Ask for the date range if the user did not give one. Use the site's timezone if the user does not say otherwise.
2. READ `GET /reports/conversations/{type}` (describe it for the allowed `type` values) with query `startDate`, `endDate` and `timezone`.
3. READ `GET /reports/agents` with the same query for agent performance, and `GET /reports/tags` for tag usage.
4. Report the numbers as returned. Do not estimate or fill in missing values.
