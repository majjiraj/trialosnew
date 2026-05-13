-- Migration 034 — Add new document types for ingestion uploads
-- Ensures DB constraint aligns with ingestion/frontend supported types.

ALTER TABLE documents
DROP CONSTRAINT IF EXISTS documents_document_type_check;

ALTER TABLE documents
ADD CONSTRAINT documents_document_type_check CHECK (
    document_type = ANY (ARRAY[
        'protocol','sap','crf','csr','sdtm_ig','adam_ig','usdm_ig',
        'lab_manual','lab_report','study_budget','dmp','icf',
        'sdtm_dataset','adam_dataset','other',
        'ich_guideline','controlled_terminology'
    ]::text[])
);
