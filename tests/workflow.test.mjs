import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = JSON.parse(await readFile(path.join(root, 'workflows', 'ticket-routing.json'), 'utf8'));

function node(name) {
  const found = workflow.nodes.find((item) => item.name === name);
  assert.ok(found, `Missing node ${name}`);
  return found;
}

const targets = (name, output = 0) => workflow.connections[name]?.main?.[output]?.map((item) => item.node) ?? [];

const expression = (value, json) => (typeof value === 'string' && value.startsWith('={{')
  ? vm.runInNewContext(value.slice(3, -2), { $json: json })
  : value);

// Runs a Code node the way n8n would: $input is the incoming item, $('Node') resolves to that node's
// output, $getWorkflowStaticData returns `staticData` (kept between calls by the caller).
function runCode(name, json, { outputs = {}, staticData = {} } = {}) {
  const result = vm.runInNewContext(`(function () {${node(name).parameters.jsCode}\n})()`, {
    $input: { first: () => ({ json }) },
    $: (other) => ({ first: () => ({ json: outputs[other] }) }),
    $getWorkflowStaticData: () => staticData,
  });
  return JSON.parse(JSON.stringify(result[0].json));
}

// Walks the graph for one webhook request. Code and IF nodes run for real; Classify Ticket is answered by
// `model(requestBody)`, and a thrown error stands for n8n giving up after its retries (error output).
function simulate(body, { model = () => { throw new Error('model unavailable'); }, staticData = {} } = {}) {
  const outputs = {};
  const calls = [];
  let name = 'Webhook';
  let item = { headers: {}, params: {}, query: {}, body };
  for (let step = 0; step < 50; step++) {
    const current = node(name);
    let output = 0;
    switch (current.type) {
      case 'n8n-nodes-base.webhook':
        break;
      case 'n8n-nodes-base.code':
        item = runCode(name, item, { outputs, staticData });
        break;
      case 'n8n-nodes-base.if':
        output = expression(current.parameters.conditions.boolean[0].value1, item) === true ? 0 : 1;
        break;
      case 'n8n-nodes-base.httpRequest': {
        const request = JSON.parse(expression(current.parameters.jsonBody, item));
        calls.push(request);
        try {
          item = model(request);
        } catch (error) {
          item = { error: error.message };
          output = 1;
        }
        break;
      }
      case 'n8n-nodes-base.respondToWebhook':
        return { code: expression(current.parameters.options.responseCode, item), body: item, calls };
      default:
        throw new Error(`simulate: unsupported node type ${current.type}`);
    }
    outputs[name] = item;
    const next = targets(name, output);
    assert.equal(next.length, 1, `${name} output ${output} must lead to exactly one node`);
    [name] = next;
  }
  throw new Error('simulate: the graph did not reach the Respond node');
}

const ticket = {
  ticket_id: 'TK-9082',
  customer_email: 'john.doe@techcorp.com',
  message: 'Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP!',
  tier: 'Enterprise',
};
const modelSays = (severity, summary = 'API outage on billing endpoint') => () => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ severity, summary }) } }],
});

test('export: short id, credential referenced by name only, no secrets, every connection resolves', () => {
  assert.equal(workflow.id, 'ticket-routing', 'the id doubles as the file name, which make start relies on');
  assert.ok(workflow.id.length <= 21, 'n8n only persists workflow static data for ids of at most 21 chars');
  assert.equal(node('Webhook').parameters.path, 'support-ticket');
  // Without webhookId n8n registers the path as <workflowId>/<nodeName>/<path> instead of <path>.
  assert.match(node('Webhook').webhookId ?? '', /^[0-9a-f-]{36}$/);
  assert.deepEqual(workflow.nodes.filter((item) => item.credentials).map((item) => item.name), ['Classify Ticket']);
  // id: null makes n8n resolve the credential by name at import time, so no instance id or secret is committed.
  assert.deepEqual(node('Classify Ticket').credentials, { deepSeekApi: { id: null, name: 'DeepSeek account' } });
  assert.doesNotMatch(JSON.stringify(workflow), /sk-[A-Za-z0-9]{8,}/);
  const names = new Set(workflow.nodes.map((item) => item.name));
  for (const [source, branches] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), `unknown source ${source}`);
    for (const output of branches.main) for (const link of output) assert.ok(names.has(link.node), `missing ${link.node}`);
  }
});

test('graph: validate -> dedupe -> classify (retry on the node) -> parse -> route; every branch ends in Respond', () => {
  assert.deepEqual(targets('Webhook'), ['Validate and Mask PII']);
  assert.deepEqual(targets('Validate and Mask PII'), ['Valid Ticket?']);
  assert.deepEqual(targets('Valid Ticket?'), ['Deduplicate Ticket']);
  assert.deepEqual(targets('Valid Ticket?', 1), ['Respond']);
  assert.deepEqual(targets('Deduplicate Ticket'), ['New Ticket?']);
  assert.deepEqual(targets('New Ticket?'), ['Classify Ticket']);
  assert.deepEqual(targets('New Ticket?', 1), ['Respond']);
  const classify = node('Classify Ticket');
  assert.equal(classify.retryOnFail, true);
  assert.equal(classify.maxTries, 3);
  assert.equal(classify.waitBetweenTries, 1000);
  assert.equal(classify.onError, 'continueErrorOutput');
  assert.deepEqual(targets('Classify Ticket'), ['Parse Classification']);
  assert.deepEqual(targets('Classify Ticket', 1), ['Parse Classification'], 'the error output is parsed too');
  assert.deepEqual(targets('Parse Classification'), ['Classified?']);
  assert.deepEqual(targets('Classified?'), ['Enterprise Critical?']);
  assert.deepEqual(targets('Classified?', 1), ['Respond']);
  assert.deepEqual(targets('Enterprise Critical?'), ['Mock Asana Task']);
  assert.deepEqual(targets('Enterprise Critical?', 1), ['Mock HubSpot Ticket']);
  assert.deepEqual(targets('Mock Asana Task'), ['Mock Slack Alert']);
  assert.deepEqual(targets('Mock Slack Alert'), ['Respond']);
  assert.deepEqual(targets('Mock HubSpot Ticket'), ['Respond']);
  assert.equal(node('Respond').parameters.options.responseCode, '={{ $json.http_status }}');
});

test('masking: the JavaScript port in Validate and Mask PII equals src/pii.py on shared samples', () => {
  const samples = [
    'Please contact John at john.smith@company.com or call +1-202-555-0143 regarding order #4412.',
    'Call +1-555-0199 or 88005553535, ref ID 12345678, card 4111 1111 1111 1111, not a card 1234 5678 9012 3456.',
    'Reach +7 (800) 555-35-35, (202) 555-0143, +44 20 7946 0958 or a.b+tag@sub.example.co.uk; ticket TK-9082.',
    'Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP! Version v2.0.1 on 2024-01-15.',
    'Two: a@x.com, b@y.org; ping @support or a@b; cards 4111-1111-1111-1111 and 3400 0000 0000 009.',
  ];
  const inNode = samples.map((message) => runCode('Validate and Mask PII', {
    body: { ticket_id: 'TK-1', customer_email: 'a@b.co', message, tier: 'Free' },
  }).sanitized_message);
  const inPython = JSON.parse(execFileSync('python3', ['-c', [
    'import json, sys',
    'from src.pii import sanitize_pii',
    'print(json.dumps([sanitize_pii(text) for text in json.load(sys.stdin)]))',
  ].join('\n')], { cwd: root, input: JSON.stringify(samples), encoding: 'utf8' }));
  assert.deepEqual(inNode, inPython);
  assert.equal(inNode[0], 'Please contact John at [REDACTED_EMAIL] or call [REDACTED_PHONE] regarding order #4412.');
  assert.equal(inNode[1], 'Call [REDACTED_PHONE] or [REDACTED_PHONE], ref ID 12345678, card [REDACTED_CARD], not a card 1234 5678 9012 3456.');
});

test('classify: the request carries only the masked message and asks DeepSeek for strict JSON', () => {
  const classify = node('Classify Ticket');
  assert.equal(classify.parameters.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(classify.parameters.nodeCredentialType, 'deepSeekApi');
  const body = JSON.parse(expression(classify.parameters.jsonBody, { sanitized_message: 'masked text', customer_email: 'x@y.z', ticket_id: 'TK-1' }));
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 120);
  assert.match(body.messages[0].content, /Low\|Medium\|High\|Critical/);
  assert.equal(body.messages[1].content, 'masked text');
  assert.doesNotMatch(JSON.stringify(body), /x@y\.z|TK-1/);
});

// --- End-to-end scenarios, one per requirement in Block 1 ---

test('scenario: the assignment ticket (Enterprise, model says Critical) -> Asana task + Slack alert, 202', () => {
  const run = simulate(ticket, { model: modelSays('Critical') });
  assert.equal(run.code, 202);
  assert.equal(run.body.status, 'accepted');
  assert.equal(run.body.route, 'asana_slack');
  assert.equal(run.body.severity, 'Critical');
  assert.equal(run.body.summary, 'API outage on billing endpoint');
  assert.equal(run.body.asana_task.simulated, true);
  assert.match(run.body.asana_task.name, /\[Critical\] TK-9082/);
  assert.equal(run.body.slack_alert.simulated, true);
  assert.match(run.body.slack_alert.text, /Critical Enterprise ticket TK-9082/);
  assert.equal(run.calls.length, 1);
});

test('scenario: only the masked message reaches the model; the raw email reaches nothing downstream', () => {
  const run = simulate({ ...ticket, message: 'Reach me at john.doe@techcorp.com or +1-202-555-0143 - API is down' }, { model: modelSays('Critical') });
  assert.equal(run.calls[0].messages[1].content, 'Reach me at [REDACTED_EMAIL] or [REDACTED_PHONE] - API is down');
  assert.doesNotMatch(JSON.stringify(run.calls[0]), /techcorp|202-555|TK-9082|Enterprise/);
  assert.doesNotMatch(JSON.stringify(run.body), /john\.doe|techcorp|202-555/);
});

test('scenario: the same ticket_id a second time -> 200 duplicate, no model call, no task or alert', () => {
  const staticData = {};
  assert.equal(simulate(ticket, { model: modelSays('Critical'), staticData }).body.route, 'asana_slack');
  const second = simulate(ticket, { model: modelSays('Critical'), staticData });
  assert.equal(second.code, 200);
  assert.deepEqual(Object.keys(second.body).sort(), ['first_seen_at', 'http_status', 'status', 'ticket_id']);
  assert.equal(second.body.status, 'duplicate');
  assert.equal(second.calls.length, 0);
  staticData.seen_tickets['TK-9082'] = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.equal(simulate(ticket, { model: modelSays('Critical'), staticData }).body.route, 'asana_slack', 'an id older than the 7-day TTL is processed again');
});

test('scenario: an ordinary ticket (Free tier, model says Low) -> HubSpot ticket, 202', () => {
  const run = simulate({ ...ticket, tier: 'Free' }, { model: modelSays('Low', 'Question about billing') });
  assert.equal(run.code, 202);
  assert.equal(run.body.route, 'hubspot');
  assert.equal(run.body.hubspot_ticket.simulated, true);
  assert.match(run.body.hubspot_ticket.subject, /\[Low\] TK-9082: Question about billing/);
  assert.equal(run.body.asana_task, undefined);
  assert.equal(run.body.slack_alert, undefined);
});

test('scenario: the alert branch needs both conditions - Enterprise+High and Free+Critical go to HubSpot', () => {
  for (const [tier, severity] of [['Enterprise', 'High'], ['Enterprise', 'Medium'], ['Free', 'Critical'], ['Pro', 'Critical']]) {
    const run = simulate({ ...ticket, tier }, { model: modelSays(severity) });
    assert.equal(run.body.route, 'hubspot', `${tier} + ${severity}`);
    assert.equal(run.body.severity, severity);
  }
});

test('scenario: invalid payloads -> 400 before any model call, without echoing the bad input', () => {
  const cases = [
    { ...ticket, customer_email: 'not-an-email' },
    { ...ticket, message: '' },
    { ...ticket, ticket_id: 'TK 9082!' },
    { customer_email: 'a@b.co', message: 'Hi', tier: 'Free' },
    { ...ticket, tier: '' },
  ];
  for (const body of cases) {
    const run = simulate(body, { model: modelSays('Critical') });
    assert.equal(run.code, 400, JSON.stringify(body));
    assert.equal(run.body.status, 'invalid_request');
    assert.ok(run.body.errors.length >= 1);
    assert.equal(run.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(run.body), /not-an-email/);
  }
});

test('scenario: model still failing after the retries (429 / 5xx / transport) -> 202 needs_review, no task', () => {
  const run = simulate(ticket);
  assert.equal(run.code, 202);
  assert.deepEqual(run.body, { status: 'needs_review', ticket_id: 'TK-9082', reason: 'model_unavailable', http_status: 202 });
  assert.equal(run.calls.length, 1);
});

test('scenario: malformed replies (not JSON, severity outside the enum, empty summary, truncated) -> needs_review', () => {
  const replies = {
    notJson: () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Critical outage!' } }] }),
    badEnum: modelSays('Urgent'),
    emptySummary: modelSays('High', ''),
    truncated: () => ({ choices: [{ finish_reason: 'length', message: { content: '{"severity":"High"' } }] }),
    noChoices: () => ({}),
  };
  for (const [label, model] of Object.entries(replies)) {
    const run = simulate(ticket, { model });
    assert.equal(run.code, 202, label);
    assert.equal(run.body.status, 'needs_review', label);
    assert.equal(run.body.reason, 'invalid_classification', label);
  }
});
