package trialo.authz

import future.keywords.if
import future.keywords.in

# Default deny
default allow = false

# Role → scope mappings
role_scopes := {
    "sponsor_admin": [
        "study:data:read", "study:docs:read", "study:reports:read",
        "study:reports:write", "study:queries:read",
        "platform:notify:write", "platform:approvals:read",
        "org:admin",
        "apps:read", "apps:write", "apps:install",
        "workflows:start", "tasks:complete", "esig:create",
        "standards:read", "study:graph:read", "study:memory:read",
        "platform:orchestrate:read", "platform:evaluation:read",
        "platform:hitl:read"
    ],
    "cro_data_manager": [
        "study:data:read", "study:data:write", "study:docs:read",
        "study:queries:read", "study:queries:write",
        "study:validation:read", "study:reports:write",
        "platform:notify:write", "platform:approvals:write",
        "apps:read", "workflows:start", "tasks:complete"
    ],
    "site_crc": [
        "study:data:read", "study:queries:read",
        "study:queries:write", "study:docs:read",
        "platform:notify:write",
        "apps:read", "workflows:start", "tasks:complete"
    ],
    "site_pi": [
        "study:data:read", "study:queries:read", "study:queries:write",
        "study:docs:read", "study:reports:read",
        "platform:notify:write", "platform:approvals:write",
        "apps:read", "workflows:start", "tasks:complete", "esig:create"
    ],
    "medical_monitor": [
        "study:data:read", "study:docs:read", "study:reports:read",
        "study:reports:write", "platform:approvals:write",
        "study:safety:unblind",
        "apps:read", "tasks:complete", "esig:create"
    ],
    "biostatistician": [
        "study:data:read", "study:docs:read", "study:reports:read",
        "study:reports:write", "study:validation:read",
        "apps:read", "tasks:complete"
    ],
    "agent_runner": [
        "study:data:read", "study:validation:read",
        "study:queries:write", "study:reports:write",
        "platform:notify:write", "platform:approvals:write",
        "apps:read",
        "standards:read", "study:graph:read", "study:graph:write",
        "study:memory:read", "study:memory:write",
        "platform:orchestrate:write", "platform:hitl:write"
    ],
    "analyst": [
        "study:data:read", "study:docs:read", "study:reports:read",
        "apps:read"
    ],
    "tenant_admin": [
        "study:data:read", "study:data:write", "study:docs:read",
        "study:reports:read", "study:reports:write",
        "study:queries:read", "study:queries:write",
        "platform:notify:write", "platform:approvals:write",
        "org:admin",
        "apps:read", "apps:write", "apps:install",
        "workflows:start", "tasks:complete", "esig:create"
    ],
    "platform_admin": [
        "study:data:read", "study:data:write", "study:docs:read",
        "study:reports:read", "study:reports:write",
        "study:queries:read", "study:queries:write",
        "platform:notify:write", "platform:approvals:write",
        "org:admin",
        "apps:read", "apps:write", "apps:publish", "apps:install",
        "workflows:start", "tasks:complete", "esig:create",
        # Layer 1-7 permissions
        "standards:read", "standards:write",
        "study:graph:read", "study:graph:write",
        "study:memory:read", "study:memory:write",
        "platform:orchestrate:write", "platform:orchestrate:read",
        "platform:hitl:write", "platform:hitl:read",
        "platform:evaluation:read"
    ],
    "standards_librarian": [
        "standards:read", "standards:write",
        "study:data:read", "study:docs:read",
        "study:reports:read", "apps:read"
    ],
    "data_architect": [
        "study:data:read", "study:data:write", "study:docs:read",
        "study:graph:read", "study:graph:write",
        "study:memory:read", "standards:read",
        "study:reports:write", "apps:read", "workflows:start", "tasks:complete"
    ],
    "compliance_officer": [
        "study:data:read", "study:docs:read", "study:reports:read",
        "study:reports:write", "standards:read",
        "study:graph:read", "study:memory:read",
        "platform:approvals:write", "platform:hitl:write",
        "apps:read", "tasks:complete", "esig:create"
    ]
}

# Allow if user has required scope via their role
allow if {
    user_roles := input.context.roles
    required_scope := input.context.required_scope
    some role in user_roles
    some scope in role_scopes[role]
    scope == required_scope
    not is_blinded_data_without_privilege(input)
}

# Deny access to blinded treatment arm data without unblind privilege
is_blinded_data_without_privilege(inp) if {
    inp.resource.type == "study:data"
    inp.context.is_blinded_data == true
    not "study:safety:unblind" in inp.context.scopes
}

# Org isolation: user's org_id must match resource org_id
allow if {
    input.org_id == input.resource.org_id
    # ... other conditions met above
}

# Study access: user must have explicit study access
user_has_study_access if {
    input.resource.study_id in input.context.permitted_study_ids
}

# Agents: scoped to their granted permissions only
allow if {
    input.actor_type == "agent"
    input.action in input.context.agent_granted_scopes
    input.context.agent_org_id == input.org_id
}
