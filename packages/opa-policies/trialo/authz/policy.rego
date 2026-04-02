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
        "workflows:start", "tasks:complete", "esig:create"
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
        "apps:read"
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
        "workflows:start", "tasks:complete", "esig:create"
    ]
}

# ACP scope helper sets — used for convenient allow checks
role_scopes contains "apps:read"       if roles[_] in ["analyst","tenant_admin","sponsor_admin","cro_data_manager","site_crc","site_pi","medical_monitor","biostatistician","platform_admin"]
role_scopes contains "apps:write"      if roles[_] in ["tenant_admin","sponsor_admin","platform_admin"]
role_scopes contains "apps:publish"    if roles[_] in ["platform_admin"]
role_scopes contains "apps:install"    if roles[_] in ["tenant_admin","sponsor_admin","platform_admin"]
role_scopes contains "workflows:start" if roles[_] in ["tenant_admin","cro_data_manager","site_pi","site_crc","sponsor_admin","platform_admin"]
role_scopes contains "tasks:complete"  if roles[_] in ["tenant_admin","cro_data_manager","site_pi","site_crc","medical_monitor","biostatistician","sponsor_admin","platform_admin"]
role_scopes contains "esig:create"     if roles[_] in ["site_pi","medical_monitor","sponsor_admin","tenant_admin","platform_admin"]

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
