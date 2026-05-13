-- Migration 029: Register ICH M11 validator and converter agents
-- Adds native agent definitions for:
--   ich-m11-validator         (structural + USDM alignment validation)
--   protocol-ich-m11-converter (LLM-powered protocol → ICH M11 conversion)

-- Extend agent_type check to include 'trialo_native' type
ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_agent_type_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_agent_type_check
  CHECK (agent_type = ANY (ARRAY[
    'docker','config-driven','prompt-agent','langchain-flow',
    'sdtm_mapper','usdm_converter','trialo_native'
  ]));

-- ICH M11 Validator agent
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     declared_tools, required_permissions,
     is_published, is_verified, publisher_type)
VALUES
    ('00000000-0000-0000-0000-000000000010',
     'ICH M11 Validator',
     'ich-m11-validator',
     '1.0.0',
     'regulatory',
     'Validates protocol documents against ICH M11 CeSHarP mandatory structure. '
     'Runs structural section checks (Phase A) and USDM v4.0 alignment checks (Phase B). '
     'Triggered automatically after protocol context graph creation and USDM conversion.',
     'trialo_native',
     'ich_m11_validation',
     ARRAY['read_document','validate_ich_m11_structure','generate_pdf_report','send_notification'],
     ARRAY['study:data:read','study:docs:read','study:reports:write','platform:notify:write','standards:read'],
     true,
     true,
     'trialo-native')
ON CONFLICT (id) DO NOTHING;

-- Protocol ICH M11 Converter agent
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     declared_tools, required_permissions,
     is_published, is_verified, publisher_type)
VALUES
    ('00000000-0000-0000-0000-000000000011',
     'Protocol ICH M11 Converter',
     'protocol-ich-m11-converter',
     '1.0.0',
     'regulatory',
     'Converts an unstructured or partially-structured clinical trial protocol into '
     'a fully ICH M11 CeSHarP-compliant 14-section format using LLM extraction. '
     'Produces structured M11 document artifacts with section-by-section content.',
     'trialo_native',
     'ich_m11_validation',
     ARRAY['read_document','search_documents','generate_pdf_report','send_notification','recall_memory'],
     ARRAY['study:data:read','study:docs:read','study:graph:read','study:reports:write','platform:notify:write','standards:read'],
     true,
     true,
     'trialo-native')
ON CONFLICT (id) DO NOTHING;
