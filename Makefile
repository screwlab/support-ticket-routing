.DEFAULT_GOAL := test
.PHONY: test start smoke stop reset

WEBHOOK = http://localhost:5678/webhook/support-ticket

test:
	node --test tests/workflow.test.mjs
	python3 -m unittest discover -s tests -v

# Workflow id == file name. A CLI import only takes effect after a restart.
start:
	docker compose up -d --wait
	docker compose exec -T n8n n8n import:workflow --input=/workflows/ticket-routing.json
	docker compose exec -T n8n n8n publish:workflow --id=ticket-routing
	docker compose restart n8n && docker compose up -d --wait
	@echo 'n8n: http://localhost:5678 - add a DeepSeek credential named "DeepSeek account", then make start again (see README)'

# Ticket ids carry a timestamp so a rerun does not trip the duplicate check.
smoke:
	@post() { printf '\n=== %s ===\n' "$$1"; curl -s -w ' [%{http_code}, %{time_total}s]\n' -X POST $(WEBHOOK) -H 'Content-Type: application/json' -d "$$2"; }; \
	t=$$(date +%s); \
	ticket='{"ticket_id":"TK-9082-'$$t'","customer_email":"john.doe@techcorp.com","message":"Hi, your API returns 500 error on /v1/billing endpoint. Fix this ASAP!","tier":"Enterprise"}'; \
	post 'Enterprise ticket -> asana_slack if the model says Critical, else hubspot' "$$ticket"; \
	post 'same ticket_id again -> duplicate, no second model call' "$$ticket"; \
	post 'Free tier -> hubspot, PII masked' '{"ticket_id":"TK-2-'$$t'","customer_email":"jane@example.com","message":"Contact me at jane@example.com or +1-202-555-0143 about billing.","tier":"Free"}'; \
	post 'invalid email -> 400' '{"ticket_id":"TK-1-'$$t'","customer_email":"not-an-email","message":"Hi","tier":"Enterprise"}'

stop:
	docker compose down

reset:  # also drops n8n's database: workflows, credentials, executions, dedupe state
	docker compose down -v
