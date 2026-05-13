.PHONY: install build start stop restart logs health clean test-smoke

install: ## First-time setup: copy .env, build image
	./scripts/install.sh

build: ## Rebuild the Docker image
	docker-compose build

start: ## Start the service in the background
	docker-compose up -d
	./scripts/healthcheck.sh

stop: ## Stop the service
	docker-compose down

restart: stop start ## Restart the service

logs: ## Tail service logs
	docker-compose logs -f quality-service

health: ## Check service health endpoint
	./scripts/healthcheck.sh

clean: ## Stop and remove containers, volumes, and images
	docker-compose down -v --rmi local

test-smoke: ## Quick smoke test against all endpoints
	@echo "--- health ---"
	curl -sf http://localhost:8016/health | python3 -m json.tool
	@echo ""
	@echo "--- structural validate ---"
	curl -sf -X POST http://localhost:8016/structural/validate \
	  -H "Content-Type: application/json" \
	  -d '{"usdm_json":{"study":{"id":"S1","versions":[{"id":"V1","versionIdentifier":"1.0","titles":[{"id":"T1","text":"Test Study"}],"studyDesigns":[{"id":"D1","objectives":[{"id":"O1"}],"studyArms":[{"id":"A1"}],"studyEpochs":[{"id":"E1"}],"studyPopulations":[{"id":"P1"}],"studyIndications":[{"id":"I1"}],"studyIdentifiers":[{"id":"ID1"}]}]}]}}}' \
	  | python3 -m json.tool
	@echo ""
	@echo "--- list reports ---"
	curl -sf "http://localhost:8016/quality/reports?limit=5" | python3 -m json.tool

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
