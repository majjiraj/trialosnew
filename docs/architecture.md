# Trialo Architecture

This document captures the current application architecture from the repo configuration and service code. It is intentionally split into two Mermaid diagrams so the platform topology stays readable while the AI and data pipeline gets a separate execution-focused view.

Raw Mermaid sources for renderers that expect Mermaid-only input are available in `docs/architecture-platform.mmd` and `docs/architecture-ai-data-pipeline.mmd`. If a tool throws `UnknownDiagramError` on this file, it is usually parsing the whole Markdown document as Mermaid instead of reading the fenced diagram blocks.

## Diagram 1: Platform Service Topology

```mermaid
architecture-beta
    group client_edge(internet)[Client and Edge]
    service browser(internet)[Study Teams and Ops Users] in client_edge
    service frontend(server)[Next.js Frontend] in client_edge
    service ingress(server)[Kong plus NGINX Ingress] in client_edge

    group api_access(cloud)[API and Access]
    service graphql(server)[GraphQL API Gateway] in api_access
    service auth(server)[Auth Service] in api_access
    service opa(server)[OPA Policy Engine] in api_access

    group core_services(cloud)[Core Platform Services]
    service audit(server)[Audit Service] in core_services
    service ingestion(server)[Ingestion Service] in core_services
    service agent_runtime(server)[Agent Runtime] in core_services
    service marketplace(server)[Marketplace] in core_services
    service notifications(server)[Notification Service] in core_services
    service context_graph(server)[Context Graph] in core_services
    service data_platform(server)[Data Platform] in core_services
    service app_composer(server)[App Composer] in core_services
    service form_engine(server)[Form Engine] in core_services
    service workflow_bridge(server)[Workflow Bridge] in core_services

    group data_storage(cloud)[Data and Storage]
    service postgres(database)[PostgreSQL plus pgvector] in data_storage
    service mongodb(database)[MongoDB] in data_storage
    service minio(disk)[MinIO Object Storage] in data_storage

    group eventing_workflow(cloud)[Eventing and Workflow]
    service kafka(server)[Kafka Event Bus] in eventing_workflow
    service zeebe(server)[Zeebe Workflow Engine] in eventing_workflow
    service elastic(database)[Elasticsearch] in eventing_workflow
    service langfuse(cloud)[Langfuse] in eventing_workflow

    group external_services(cloud)[External Integrations]
    service auth0(cloud)[Auth0] in external_services
    service llm_stack(cloud)[OpenAI plus Anthropic plus Azure OpenAI plus Ollama] in external_services
    service sendgrid(cloud)[SendGrid] in external_services

    browser:R --> L:frontend
    frontend:R --> L:ingress
    ingress:R --> L:graphql

    graphql:B --> T:auth
    auth:R --> L:opa
    auth:R --> L:auth0

    graphql:B --> T:audit
    graphql:B --> T:ingestion
    graphql:B --> T:agent_runtime
    graphql:B --> T:marketplace
    graphql:B --> T:notifications
    graphql:B --> T:context_graph
    graphql:B --> T:data_platform
    graphql:B --> T:app_composer
    graphql:B --> T:form_engine
    graphql:B --> T:workflow_bridge

    audit:B --> T:postgres
    ingestion:B --> T:postgres
    agent_runtime:B --> T:postgres
    marketplace:B --> T:postgres
    notifications:B --> T:postgres
    context_graph:B --> T:postgres
    data_platform:B --> T:postgres
    app_composer:B --> T:postgres
    form_engine:B --> T:postgres
    workflow_bridge:B --> T:postgres

    ingestion:R --> L:mongodb
    app_composer:R --> L:mongodb
    form_engine:R --> L:mongodb

    ingestion:R --> L:minio
    agent_runtime:R --> L:minio

    audit:B --> T:kafka
    ingestion:B --> T:kafka
    agent_runtime:B --> T:kafka
    notifications:B --> T:kafka
    context_graph:B --> T:kafka
    workflow_bridge:B --> T:kafka

    workflow_bridge:R --> L:zeebe
    zeebe:R --> L:elastic
    agent_runtime:R --> L:langfuse
    agent_runtime:R --> L:llm_stack
    context_graph:R --> L:llm_stack
    notifications:R --> L:sendgrid
```

## Diagram 2: AI and Data Pipeline View

```mermaid
architecture-beta
    group upstream_sources(cloud)[Study Data and Document Sources]
    service source_docs(disk)[Protocols SAP CRFs Labs and SDTM Guides] in upstream_sources
    service source_ops(server)[EDC CTMS and Operational Feeds] in upstream_sources

    group ingestion_layer(cloud)[Ingestion and Normalization]
    service ingestion(server)[Ingestion Service] in ingestion_layer
    service bronze(disk)[Bronze Raw Records] in ingestion_layer
    service doc_store(disk)[Document and Artifact Buckets] in ingestion_layer
    service kafka_topics(server)[Kafka Topics data agents study system] in ingestion_layer

    group reasoning_layer(cloud)[Context and Agent Reasoning]
    service context_graph(server)[Context Graph] in reasoning_layer
    service vector_store(database)[PostgreSQL plus pgvector] in reasoning_layer
    service agent_runtime(server)[Agent Runtime] in reasoning_layer
    service built_in_agents(server)[Built in Agents plus SDK] in reasoning_layer
    service tool_chain(server)[SDTM search report and workflow tools] in reasoning_layer

    group transformation_layer(cloud)[Transformation and Analytics]
    service data_platform(server)[Data Platform] in transformation_layer
    service silver(disk)[Silver SDTM Layer] in transformation_layer
    service gold(disk)[Gold ADaM Layer] in transformation_layer

    group observability_control(cloud)[Observability and Control]
    service traces(cloud)[Langfuse and Decision Traces] in observability_control
    service audit(server)[Audit and Query Events] in observability_control
    service notifications(server)[Notifications and Approvals] in observability_control

    group external_ai(cloud)[External AI and Embeddings]
    service llm_stack(cloud)[OpenAI plus Anthropic plus Azure OpenAI plus Ollama] in external_ai

    source_docs:R --> L:ingestion
    source_ops:R --> L:ingestion

    ingestion:B --> T:bronze
    ingestion:B --> T:doc_store
    ingestion:R --> L:kafka_topics
    ingestion:R --> L:llm_stack

    kafka_topics:R --> L:context_graph
    context_graph:B --> T:vector_store
    context_graph:R --> L:agent_runtime
    context_graph:R --> L:llm_stack

    agent_runtime:R --> L:built_in_agents
    built_in_agents:R --> L:tool_chain
    tool_chain:B --> T:data_platform
    tool_chain:B --> T:doc_store

    data_platform:B --> T:silver
    silver:R --> L:gold

    agent_runtime:B --> T:vector_store
    agent_runtime:B --> T:doc_store
    agent_runtime:R --> L:llm_stack
    agent_runtime:R --> L:traces
    agent_runtime:R --> L:audit
    agent_runtime:R --> L:notifications

    data_platform:R --> L:audit
    kafka_topics:B --> T:audit
```

## Diagram 3: Presentation-Grade Platform Overview

For leadership and client presentations use `docs/architecture-presentation.mmd`.
It is a single `flowchart TB` diagram with:

- **Color-coded subgraphs** — Users · Frontend · Gateway · Core Services · Data · Events · AI · External
- **Emoji icons** on every service node for instant visual scanning
- **Port numbers and tech stack** callouts on each service
- **`classDef` color classes** — blue (core), teal (frontend), purple (gateway), amber (data), sky (events), green (AI)
- Renders in GitHub, Mermaid Live Editor, Notion, Confluence, and VS Code Mermaid Preview

```mermaid
flowchart TB
    note["See docs/architecture-presentation.mmd for the full diagram.\nEmbed or render that file directly in your presentation tool."]
```

| Layer | Services | Technology |
|---|---|---|
| 👥 Users | Clinical Data Managers · Study Coordinators · Medical Reviewers · Admins | — |
| 🖥️ Frontend | Next.js 14 | App Router · Tailwind · ReactFlow |
| 🔀 Gateway | GraphQL API · Auth Service · OPA | Apollo · FastAPI · Auth0 |
| ⚙️ Core | Ingestion · Agent Runtime · Marketplace · Context Graph · Notifications · Audit · App Composer · Form Engine · Workflow Bridge | FastAPI · Node.js/Express |
| 🗄️ Data | PostgreSQL+pgvector · MongoDB · MinIO · Neo4j | pg16 · mongo7 · S3-compatible |
| ⚡ Events | Kafka · Zeebe · Elasticsearch · Camunda Operate | KRaft · BPMN 2.0 |
| 🧠 AI | OpenAI · Anthropic Claude · Azure OpenAI · Ollama · Langfuse | REST · LiteLLM compatible |
| 🌐 External | Auth0 · SendGrid | SSO/MFA · Email |

## Legend and Scope Notes

- `internet` icons mark user or network entry points.
- `server` icons represent application services or processing engines.
- `database` icons represent structured or vector-backed stores.
- `disk` icons represent object storage, documents, and pipeline layers.
- `cloud` icons represent external or grouped platform capabilities.

These diagrams reflect the current repo-backed runtime topology from the compose, service, and infrastructure definitions. They emphasize the main synchronous request paths and the major asynchronous/event-driven paths rather than every internal route, table, Helm object, or Kubernetes manifest.

## Mermaid Rendering Notes

- The diagrams use Mermaid `architecture-beta`, which requires Mermaid `v11.1+`.
- They deliberately stick to Mermaid built-in icons so they render even without custom icon registration.
- If your docs renderer registers Iconify packs, the generic `server`, `database`, `disk`, and `cloud` icons can be upgraded to branded icons for Next.js, GraphQL, Kafka, PostgreSQL, MongoDB, and related technologies without changing the diagram structure.