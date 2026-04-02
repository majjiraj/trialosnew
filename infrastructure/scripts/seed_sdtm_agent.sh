#!/bin/bash
set -e

# SDTM Data Analyst Agent Seed Script
# Creates the SDTM Data Analyst flow agent with conversation-based data analysis capabilities
# Includes decision traces, feedback capture, and knowledge graph integration

BASE_URL="${1:-http://localhost:8005}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=========================================="
echo "SDTM Data Analyst Agent Setup"
echo "=========================================="
echo ""
echo "Target marketplace: $BASE_URL"
echo "Script directory: $SCRIPT_DIR"
echo ""

# Check if payload files exist
if [[ ! -f "$SCRIPT_DIR/payload_skill.json" ]]; then
    echo "❌ Error: payload_skill.json not found in $SCRIPT_DIR"
    exit 1
fi

if [[ ! -f "$SCRIPT_DIR/payload_agent.json" ]]; then
    echo "❌ Error: payload_agent.json not found in $SCRIPT_DIR"
    exit 1
fi

echo "✓ Payload files found"
echo ""

# Step 1: Create SDTM Domain Summarizer skill
echo "Step 1: Creating SDTM Domain Summarizer skill..."
SKILL_RESP=$(curl -s -X POST "$BASE_URL/skills" \
  -H "Content-Type: application/json" \
  -d @"$SCRIPT_DIR/payload_skill.json")

# Check for errors (but allow "already exists" case)
if echo "$SKILL_RESP" | grep -q '"detail":"Skill.*already exists'; then
    echo "⚠ Skill already exists (using existing)"
    # Try to extract ID from a re-query or just continue
    SKILL_ID="existing"
elif echo "$SKILL_RESP" | grep -q '"error"\|"detail"'; then
    echo "❌ Skill creation failed:"
    echo "$SKILL_RESP" | python3 -m json.tool 2>/dev/null || echo "$SKILL_RESP"
    exit 1
else
    SKILL_ID=$(echo "$SKILL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id', 'ERROR'))" 2>/dev/null)
    if [[ "$SKILL_ID" == "ERROR" || -z "$SKILL_ID" ]]; then
        echo "❌ Failed to extract skill ID from response"
        echo "$SKILL_RESP"
        exit 1
    fi
fi

echo "✓ Skill created: $SKILL_ID"
echo ""

# Step 2: Create SDTM Data Analyst flow agent
echo "Step 2: Creating SDTM Data Analyst flow agent..."
AGENT_RESP=$(curl -s -X POST "$BASE_URL/agents/create-flow" \
  -H "Content-Type: application/json" \
  -d @"$SCRIPT_DIR/payload_agent.json")

# Check for errors
if echo "$AGENT_RESP" | grep -q '"error"'; then
    echo "❌ Agent creation failed:"
    echo "$AGENT_RESP" | python3 -m json.tool 2>/dev/null || echo "$AGENT_RESP"
    exit 1
fi

AGENT_ID=$(echo "$AGENT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent_id') or d.get('agent', {}).get('id', 'ERROR'))" 2>/dev/null)
INSTALL_ID=$(echo "$AGENT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('installation_id', 'ERROR'))" 2>/dev/null)

if [[ "$AGENT_ID" == "ERROR" || -z "$AGENT_ID" ]]; then
    echo "❌ Failed to extract agent ID from response"
    echo "$AGENT_RESP"
    exit 1
fi

echo "✓ Agent created: $AGENT_ID"
echo "✓ Auto-installed with ID: $INSTALL_ID"
echo ""

echo "=========================================="
echo "✅ Setup Complete!"
echo "=========================================="
echo ""
echo "Agent Details:"
echo "  Name: SDTM Data Analyst"
echo "  Agent ID: $AGENT_ID"
echo "  Installation ID: $INSTALL_ID"
echo "  Type: langchain-flow (conversational)"
echo "  Purpose: Statistical analysis of SDTM datasets"
echo ""
echo "Next Steps:"
echo "  1. Refresh your browser and navigate to /conversations"
echo "  2. Click 'New Conversation'"
echo "  3. Select 'SDTM Data Analyst' from the agent picker"
echo "  4. Choose 'Use files from library' and select SDTM XPT files"
echo "  5. Start conversing! The agent will:"
echo "     - Query the SDTM knowledge graph"
echo "     - Analyze the selected files"
echo "     - Record decision traces with sources"
echo "     - Capture your feedback (thumbs up/down/corrections)"
echo "     - Use feedback to improve future responses"
echo ""
echo "Decision Trace & Feedback Flow:"
echo "  • Each agent response creates a decision_trace with cited sources"
echo "  • used_in_decision edges link chunks → decision nodes"
echo "  • Your feedback creates correction nodes and corrects edges"
echo "  • Future queries bias retrieval based on your feedback"
echo ""
