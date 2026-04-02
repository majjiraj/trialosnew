-- Migration 021: Relax context_feedback.feedback_type check constraint
-- Allows category-driven feedback types to be stored directly, while remaining backward compatible.

ALTER TABLE context_feedback
DROP CONSTRAINT IF EXISTS context_feedback_feedback_type_check;

ALTER TABLE context_feedback
ADD CONSTRAINT context_feedback_feedback_type_check
CHECK (
  feedback_type IN (
    'rating',
    'correction',
    'endorsement',
    'rejection',
    'mapping_correction',
    'wrong_answer',
    'incomplete_answer',
    'wrong_source_context',
    'wrong_reasoning_path',
    'bad_formatting',
    'wrong_confidence',
    'policy_compliance_issue'
  )
);
