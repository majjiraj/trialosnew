"""
Clinical Test Data Generator
Generates CDISC-compliant synthetic data for SDTM, ADaM, Protocol, TLF, CRF, Raw EDC.
Supports output formats: CSV, XLS (Excel), XPT (SAS Transport v5), PDF.
"""

from __future__ import annotations

import io
import random
import string
import zipfile
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from faker import Faker

fake = Faker()
random.seed(42)

# ─── Controlled terminology ────────────────────────────────────────────────────

_RACES = ["WHITE", "BLACK OR AFRICAN AMERICAN", "ASIAN", "AMERICAN INDIAN OR ALASKA NATIVE",
          "NATIVE HAWAIIAN OR OTHER PACIFIC ISLANDER", "MULTIPLE", "UNKNOWN"]
_ETHNICS = ["HISPANIC OR LATINO", "NOT HISPANIC OR LATINO", "UNKNOWN"]
_SEXES = ["M", "F", "U"]
_COUNTRIES = ["USA", "GBR", "DEU", "FRA", "JPN", "CAN", "AUS", "ITA", "ESP", "CHN"]
_ARM_CODES = ["A", "B", "PBO"]
_ARMS = ["Drug A 100 mg", "Drug B 200 mg", "Placebo"]
_AE_TERMS = ["HEADACHE", "NAUSEA", "FATIGUE", "DIZZINESS", "VOMITING", "RASH",
             "DIARRHOEA", "INSOMNIA", "COUGH", "DYSPNOEA", "ANAEMIA", "PYREXIA"]
_AE_SEVERITY = ["MILD", "MODERATE", "SEVERE"]
_AE_SERIOUS = ["Y", "N"]
_AE_OUTCOME = ["RECOVERED/RESOLVED", "RECOVERING/RESOLVING", "NOT RECOVERED/NOT RESOLVED",
                "FATAL", "UNKNOWN"]
_AE_RELATION = ["NOT RELATED", "POSSIBLY RELATED", "PROBABLY RELATED", "RELATED"]
_AE_ACTION = ["DOSE NOT CHANGED", "DOSE REDUCED", "DRUG WITHDRAWN", "NOT APPLICABLE"]
_AE_SOC = ["GASTROINTESTINAL DISORDERS", "NERVOUS SYSTEM DISORDERS", "GENERAL DISORDERS",
           "SKIN AND SUBCUTANEOUS TISSUE DISORDERS", "RESPIRATORY DISORDERS"]
_AE_HLGT = ["NAUSEA AND VOMITING SYMPTOMS", "HEADACHES", "FATIGUE", "RASHES"]
_AE_HLT = ["NAUSEA", "HEADACHE NEC", "FATIGUE NEC", "RASH NEC"]
_LB_TESTS = [
    ("ALBUMIN", "ALB", "g/L", 35.0, 50.0),
    ("ALANINE AMINOTRANSFERASE", "ALT", "U/L", 7.0, 56.0),
    ("ASPARTATE AMINOTRANSFERASE", "AST", "U/L", 10.0, 40.0),
    ("BILIRUBIN", "BILI", "umol/L", 5.1, 17.1),
    ("CREATININE", "CREAT", "umol/L", 53.0, 106.0),
    ("GLUCOSE", "GLUC", "mmol/L", 3.9, 5.8),
    ("HAEMOGLOBIN", "HGB", "g/dL", 12.0, 17.5),
    ("PLATELET COUNT", "PLT", "10^9/L", 150.0, 400.0),
    ("WHITE BLOOD CELL COUNT", "WBC", "10^9/L", 4.5, 11.0),
]
_VS_TESTS = [
    ("SYSTOLIC BLOOD PRESSURE", "SYSBP", "mmHg", 90, 140),
    ("DIASTOLIC BLOOD PRESSURE", "DIABP", "mmHg", 60, 90),
    ("PULSE RATE", "PULSE", "beats/min", 60, 100),
    ("BODY WEIGHT", "WEIGHT", "kg", 50, 100),
    ("BODY HEIGHT", "HEIGHT", "cm", 155, 190),
    ("BODY TEMPERATURE", "TEMP", "C", 36.0, 37.5),
]
_CM_DRUGS = ["PARACETAMOL", "IBUPROFEN", "METFORMIN", "ATORVASTATIN", "OMEPRAZOLE",
             "AMLODIPINE", "ASPIRIN", "LISINOPRIL", "METOPROLOL", "SIMVASTATIN"]
_CM_DOSE_UNITS = ["mg", "mg/mL", "mg/kg", "mcg", "g"]

# Drug profile: (generic_name, brand_name, class, typical_routes, typical_doses, dose_unit)
_CM_DRUG_PROFILES = [
    ("Paracetamol",    "Tylenol",     "Analgesic",           ["Oral"],             [250, 500, 1000], "mg"),
    ("Ibuprofen",      "Advil",       "NSAID",               ["Oral"],             [200, 400, 600],  "mg"),
    ("Metformin",      "Glucophage",  "Antidiabetic",        ["Oral"],             [500, 850, 1000], "mg"),
    ("Atorvastatin",   "Lipitor",     "Statin",              ["Oral"],             [10, 20, 40, 80], "mg"),
    ("Omeprazole",     "Prilosec",    "Proton Pump Inhibitor",["Oral"],            [20, 40],         "mg"),
    ("Amlodipine",     "Norvasc",     "Antihypertensive",    ["Oral"],             [5, 10],          "mg"),
    ("Aspirin",        "Bayer",       "Antiplatelet",        ["Oral"],             [75, 100, 325],   "mg"),
    ("Lisinopril",     "Zestril",     "ACE Inhibitor",       ["Oral"],             [5, 10, 20, 40],  "mg"),
    ("Metoprolol",     "Lopressor",   "Beta Blocker",        ["Oral", "IV"],       [25, 50, 100],    "mg"),
    ("Simvastatin",    "Zocor",       "Statin",              ["Oral"],             [10, 20, 40],     "mg"),
    ("Heparin",        "Heparin Sod.","Anticoagulant",       ["IV", "SC"],         [5000, 10000],    "IU"),
    ("Dexamethasone",  "Decadron",    "Corticosteroid",      ["Oral", "IV", "IM"], [4, 8, 16],       "mg"),
    ("Ondansetron",    "Zofran",      "Antiemetic",          ["Oral", "IV"],       [4, 8],           "mg"),
]

# MedDRA Preferred Terms mapped to verbatim AE terms
_AE_MEDDRA_MAP = {
    "HEADACHE":    "Headache",
    "NAUSEA":      "Nausea",
    "FATIGUE":     "Fatigue",
    "DIZZINESS":   "Dizziness",
    "VOMITING":    "Vomiting",
    "RASH":        "Rash",
    "DIARRHOEA":   "Diarrhoea",
    "INSOMNIA":    "Insomnia",
    "COUGH":       "Cough",
    "DYSPNOEA":    "Dyspnoea",
    "ANAEMIA":     "Anaemia",
    "PYREXIA":     "Pyrexia",
}

_AE_SOC_MAP = {
    "HEADACHE":    "Nervous System Disorders",
    "NAUSEA":      "Gastrointestinal Disorders",
    "FATIGUE":     "General Disorders",
    "DIZZINESS":   "Nervous System Disorders",
    "VOMITING":    "Gastrointestinal Disorders",
    "RASH":        "Skin and Subcutaneous Tissue Disorders",
    "DIARRHOEA":   "Gastrointestinal Disorders",
    "INSOMNIA":    "Psychiatric Disorders",
    "COUGH":       "Respiratory, Thoracic and Mediastinal Disorders",
    "DYSPNOEA":    "Respiratory, Thoracic and Mediastinal Disorders",
    "ANAEMIA":     "Blood and Lymphatic System Disorders",
    "PYREXIA":     "General Disorders",
}

_SAE_CRITERIA = [
    "Death", "Life-threatening", "Hospitalisation required",
    "Persistent or significant disability", "Congenital anomaly", "Medically significant",
]
_MH_TERMS = ["HYPERTENSION", "DIABETES MELLITUS TYPE 2", "HYPERLIPIDAEMIA", "ASTHMA",
              "OSTEOARTHRITIS", "DEPRESSION", "ANXIETY", "CORONARY ARTERY DISEASE"]
_DS_DSCODES = ["COMPLETED", "WITHDRAWAL BY SUBJECT", "ADVERSE EVENT", "LACK OF EFFICACY",
               "PHYSICIAN DECISION", "PROTOCOL DEVIATION", "DEATH"]
_VISITS = ["SCREENING", "BASELINE", "WEEK 2", "WEEK 4", "WEEK 8", "WEEK 12",
           "WEEK 24", "WEEK 48", "FOLLOW-UP", "EARLY TERMINATION"]
_VISIT_NUMS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

_TA_PROFILES = {
    "Oncology": {
        "ae_terms": ["NEUTROPENIA", "ALOPECIA", "NAUSEA", "FATIGUE", "ANAEMIA", "THROMBOCYTOPENIA",
                     "PERIPHERAL NEUROPATHY", "MUCOSITIS", "FEBRILE NEUTROPENIA", "DIARRHOEA"],
        "ae_soc": {
            "NEUTROPENIA": "Blood and Lymphatic System Disorders",
            "ALOPECIA": "Skin and Subcutaneous Tissue Disorders",
            "THROMBOCYTOPENIA": "Blood and Lymphatic System Disorders",
            "PERIPHERAL NEUROPATHY": "Nervous System Disorders",
            "MUCOSITIS": "Gastrointestinal Disorders",
            "FEBRILE NEUTROPENIA": "Blood and Lymphatic System Disorders",
        },
        "ae_meddra": {
            "NEUTROPENIA": "Neutropenia", "ALOPECIA": "Alopecia",
            "THROMBOCYTOPENIA": "Thrombocytopenia", "PERIPHERAL NEUROPATHY": "Peripheral neuropathy",
            "MUCOSITIS": "Mucositis", "FEBRILE NEUTROPENIA": "Febrile neutropenia",
        },
        "cm_drugs": [
            ("Ondansetron", "Zofran", "Antiemetic", ["Oral", "IV"], [4, 8], "mg"),
            ("Granulocyte Colony-Stimulating Factor", "Neupogen", "Growth Factor", ["SC"], [300, 480], "mcg"),
            ("Dexamethasone", "Decadron", "Corticosteroid", ["Oral", "IV"], [4, 8], "mg"),
            ("Allopurinol", "Zyloprim", "Uricostatic", ["Oral"], [100, 200, 300], "mg"),
            ("Paclitaxel", "Taxol", "Chemotherapy", ["IV"], [135, 175, 200], "mg/m2"),
            ("Bevacizumab", "Avastin", "Antiangiogenic", ["IV"], [5, 7.5, 10, 15], "mg/kg"),
            ("Carboplatin", "Paraplatin", "Chemotherapy", ["IV"], [300, 400, 600], "mg"),
        ],
        "mh_terms": ["PRIOR MALIGNANCY", "HYPERTENSION", "DIABETES MELLITUS", "SMOKING HISTORY",
                     "CARDIAC DISEASE", "HEPATITIS B", "HEPATITIS C", "PRIOR SURGERY"],
        "lb_tests": [
            ("CA-125", "CA125", "U/mL", 0.0, 35.0),
            ("PSA", "PSA", "ng/mL", 0.0, 4.0),
            ("LDH", "LDH", "U/L", 140.0, 280.0),
            ("ALBUMIN", "ALB", "g/L", 35.0, 50.0),
            ("CREATININE", "CREAT", "umol/L", 53.0, 106.0),
            ("WHITE BLOOD CELL COUNT", "WBC", "10^9/L", 4.5, 11.0),
            ("NEUTROPHILS", "NEUT", "10^9/L", 1.8, 7.5),
            ("HAEMOGLOBIN", "HGB", "g/dL", 12.0, 17.5),
            ("PLATELET COUNT", "PLT", "10^9/L", 150.0, 400.0),
        ],
        "arms": ["Drug A 100 mg", "Drug B 200 mg", "Placebo"],
        "arm_codes": ["A", "B", "PBO"],
        "age_range": (40, 75),
    },
    "Cardiology": {
        "ae_terms": ["ATRIAL FIBRILLATION", "DYSPNOEA", "CHEST PAIN", "OEDEMA", "HYPOTENSION",
                     "PALPITATIONS", "SYNCOPE", "BRADYCARDIA", "HYPERTENSION", "VENTRICULAR TACHYCARDIA"],
        "ae_soc": {
            "ATRIAL FIBRILLATION": "Cardiac Disorders",
            "CHEST PAIN": "Cardiac Disorders",
            "OEDEMA": "General Disorders",
            "HYPOTENSION": "Vascular Disorders",
            "PALPITATIONS": "Cardiac Disorders",
            "SYNCOPE": "Nervous System Disorders",
            "BRADYCARDIA": "Cardiac Disorders",
            "VENTRICULAR TACHYCARDIA": "Cardiac Disorders",
        },
        "ae_meddra": {
            "ATRIAL FIBRILLATION": "Atrial fibrillation", "DYSPNOEA": "Dyspnoea",
            "CHEST PAIN": "Chest pain", "OEDEMA": "Peripheral oedema",
            "HYPOTENSION": "Hypotension", "PALPITATIONS": "Palpitations",
            "SYNCOPE": "Syncope", "BRADYCARDIA": "Bradycardia",
            "VENTRICULAR TACHYCARDIA": "Ventricular tachycardia",
        },
        "cm_drugs": [
            ("Bisoprolol", "Zebeta", "Beta Blocker", ["Oral"], [2.5, 5, 10], "mg"),
            ("Warfarin", "Coumadin", "Anticoagulant", ["Oral"], [2.5, 5, 7.5], "mg"),
            ("Apixaban", "Eliquis", "Anticoagulant", ["Oral"], [2.5, 5], "mg"),
            ("Atorvastatin", "Lipitor", "Statin", ["Oral"], [10, 20, 40, 80], "mg"),
            ("Furosemide", "Lasix", "Diuretic", ["Oral", "IV"], [20, 40, 80], "mg"),
            ("Carvedilol", "Coreg", "Beta Blocker", ["Oral"], [3.125, 6.25, 12.5, 25], "mg"),
            ("Sacubitril/Valsartan", "Entresto", "ARNI", ["Oral"], [24, 49, 97], "mg"),
        ],
        "mh_terms": ["CORONARY ARTERY DISEASE", "HEART FAILURE", "HYPERTENSION", "ATRIAL FIBRILLATION",
                     "DIABETES MELLITUS", "HYPERLIPIDAEMIA", "PRIOR MI", "PACEMAKER"],
        "lb_tests": [
            ("BNP", "BNP", "pg/mL", 0.0, 100.0),
            ("NT-PROBNP", "NTBNP", "pg/mL", 0.0, 125.0),
            ("TROPONIN I", "TROP", "ng/mL", 0.0, 0.04),
            ("CREATININE", "CREAT", "umol/L", 53.0, 106.0),
            ("POTASSIUM", "K", "mmol/L", 3.5, 5.0),
            ("SODIUM", "NA", "mmol/L", 136.0, 145.0),
            ("HAEMOGLOBIN", "HGB", "g/dL", 12.0, 17.5),
        ],
        "arms": ["Drug C 10 mg", "Drug C 20 mg", "Placebo"],
        "arm_codes": ["C10", "C20", "PBO"],
        "age_range": (50, 80),
    },
    "Neurology": {
        "ae_terms": ["HEADACHE", "DIZZINESS", "TREMOR", "COGNITIVE IMPAIRMENT", "SEIZURE",
                     "DEPRESSION", "INSOMNIA", "FATIGUE", "PERIPHERAL NEUROPATHY", "ATAXIA"],
        "ae_soc": {
            "TREMOR": "Nervous System Disorders",
            "COGNITIVE IMPAIRMENT": "Nervous System Disorders",
            "SEIZURE": "Nervous System Disorders",
            "ATAXIA": "Nervous System Disorders",
        },
        "ae_meddra": {
            "TREMOR": "Tremor", "COGNITIVE IMPAIRMENT": "Cognitive disorder",
            "SEIZURE": "Seizure", "PERIPHERAL NEUROPATHY": "Peripheral neuropathy",
            "ATAXIA": "Ataxia",
        },
        "cm_drugs": [
            ("Levodopa/Carbidopa", "Sinemet", "Dopaminergic", ["Oral"], [100, 200, 300], "mg"),
            ("Donepezil", "Aricept", "Cholinesterase Inhibitor", ["Oral"], [5, 10], "mg"),
            ("Memantine", "Namenda", "NMDA Antagonist", ["Oral"], [5, 10, 20], "mg"),
            ("Baclofen", "Lioresal", "Muscle Relaxant", ["Oral"], [5, 10, 20, 25], "mg"),
            ("Topiramate", "Topamax", "Anticonvulsant", ["Oral"], [25, 50, 100, 200], "mg"),
            ("Natalizumab", "Tysabri", "Monoclonal Antibody", ["IV"], [300], "mg"),
        ],
        "mh_terms": ["PARKINSON'S DISEASE", "MULTIPLE SCLEROSIS", "ALZHEIMER'S DISEASE",
                     "EPILEPSY", "MIGRAINE", "PERIPHERAL NEUROPATHY", "DEPRESSION"],
        "lb_tests": [
            ("ALBUMIN", "ALB", "g/L", 35.0, 50.0),
            ("CREATININE", "CREAT", "umol/L", 53.0, 106.0),
            ("VITAMIN B12", "VB12", "pmol/L", 148.0, 740.0),
            ("FOLATE", "FOLATE", "nmol/L", 7.0, 36.0),
            ("THYROID STIMULATING HORMONE", "TSH", "mIU/L", 0.4, 4.0),
        ],
        "arms": ["Drug D 50 mg", "Drug D 100 mg", "Placebo"],
        "arm_codes": ["D50", "D100", "PBO"],
        "age_range": (45, 80),
    },
    "Immunology": {
        "ae_terms": ["INJECTION SITE REACTION", "UPPER RESPIRATORY INFECTION", "NASOPHARYNGITIS",
                     "HEADACHE", "FATIGUE", "ARTHRALGIA", "RASH", "PRURITUS", "URTICARIA", "ANAPHYLAXIS"],
        "ae_soc": {
            "INJECTION SITE REACTION": "General Disorders",
            "URTICARIA": "Skin and Subcutaneous Tissue Disorders",
            "ANAPHYLAXIS": "Immune System Disorders",
            "ARTHRALGIA": "Musculoskeletal and Connective Tissue Disorders",
        },
        "ae_meddra": {
            "INJECTION SITE REACTION": "Injection site reaction",
            "UPPER RESPIRATORY INFECTION": "Upper respiratory tract infection",
            "NASOPHARYNGITIS": "Nasopharyngitis",
            "ARTHRALGIA": "Arthralgia",
            "URTICARIA": "Urticaria",
            "ANAPHYLAXIS": "Anaphylactic reaction",
        },
        "cm_drugs": [
            ("Methotrexate", "Rheumatrex", "DMARDs", ["Oral", "SC"], [7.5, 10, 15, 20], "mg"),
            ("Adalimumab", "Humira", "TNF Inhibitor", ["SC"], [40, 80], "mg"),
            ("Etanercept", "Enbrel", "TNF Inhibitor", ["SC"], [25, 50], "mg"),
            ("Prednisone", "Deltasone", "Corticosteroid", ["Oral"], [5, 10, 20, 40], "mg"),
            ("Hydroxychloroquine", "Plaquenil", "Antimalarial", ["Oral"], [200, 400], "mg"),
            ("Ustekinumab", "Stelara", "IL-12/23 Inhibitor", ["SC", "IV"], [45, 90], "mg"),
        ],
        "mh_terms": ["RHEUMATOID ARTHRITIS", "PSORIASIS", "INFLAMMATORY BOWEL DISEASE",
                     "ANKYLOSING SPONDYLITIS", "SYSTEMIC LUPUS ERYTHEMATOSUS", "ASTHMA"],
        "lb_tests": [
            ("C-REACTIVE PROTEIN", "CRP", "mg/L", 0.0, 10.0),
            ("ESR", "ESR", "mm/hr", 0, 20),
            ("RF", "RF", "IU/mL", 0.0, 14.0),
            ("ANTI-CCP", "ACCP", "U/mL", 0.0, 20.0),
            ("WHITE BLOOD CELL COUNT", "WBC", "10^9/L", 4.5, 11.0),
            ("ALANINE AMINOTRANSFERASE", "ALT", "U/L", 7.0, 56.0),
        ],
        "arms": ["Drug E 150 mg", "Drug E 300 mg", "Placebo"],
        "arm_codes": ["E150", "E300", "PBO"],
        "age_range": (25, 65),
    },
    "Infectious Disease": {
        "ae_terms": ["PYREXIA", "NAUSEA", "DIARRHOEA", "HEADACHE", "FATIGUE", "RASH",
                     "ABDOMINAL PAIN", "VOMITING", "MYALGIA", "ELEVATED LIVER ENZYMES"],
        "ae_soc": {
            "PYREXIA": "General Disorders",
            "ABDOMINAL PAIN": "Gastrointestinal Disorders",
            "MYALGIA": "Musculoskeletal and Connective Tissue Disorders",
            "ELEVATED LIVER ENZYMES": "Hepatobiliary Disorders",
        },
        "ae_meddra": {
            "PYREXIA": "Pyrexia", "ABDOMINAL PAIN": "Abdominal pain",
            "MYALGIA": "Myalgia", "ELEVATED LIVER ENZYMES": "Hepatic enzyme increased",
        },
        "cm_drugs": [
            ("Azithromycin", "Zithromax", "Antibiotic", ["Oral", "IV"], [250, 500], "mg"),
            ("Amoxicillin", "Amoxil", "Antibiotic", ["Oral"], [250, 500, 875], "mg"),
            ("Oseltamivir", "Tamiflu", "Antiviral", ["Oral"], [75], "mg"),
            ("Metronidazole", "Flagyl", "Antibiotic", ["Oral", "IV"], [250, 500], "mg"),
            ("Ceftriaxone", "Rocephin", "Antibiotic", ["IV", "IM"], [1000, 2000], "mg"),
        ],
        "mh_terms": ["HIV INFECTION", "HEPATITIS B", "HEPATITIS C", "DIABETES", "HYPERTENSION",
                     "CHRONIC KIDNEY DISEASE", "PRIOR INFECTIONS"],
        "lb_tests": [
            ("CD4 COUNT", "CD4", "cells/uL", 500, 1200),
            ("HIV RNA", "HIVRNA", "copies/mL", 0, 50),
            ("ALANINE AMINOTRANSFERASE", "ALT", "U/L", 7.0, 56.0),
            ("CREATININE", "CREAT", "umol/L", 53.0, 106.0),
            ("WHITE BLOOD CELL COUNT", "WBC", "10^9/L", 4.5, 11.0),
            ("C-REACTIVE PROTEIN", "CRP", "mg/L", 0.0, 10.0),
        ],
        "arms": ["Drug F 400 mg", "Drug F 800 mg", "Placebo"],
        "arm_codes": ["F400", "F800", "PBO"],
        "age_range": (18, 65),
    },
    "Metabolic/Endocrine": {
        "ae_terms": ["HYPOGLYCAEMIA", "HYPERGLYCAEMIA", "NAUSEA", "DIARRHOEA", "CONSTIPATION",
                     "WEIGHT GAIN", "WEIGHT LOSS", "OEDEMA", "FATIGUE", "THYROID DYSFUNCTION"],
        "ae_soc": {
            "HYPOGLYCAEMIA": "Metabolism and Nutrition Disorders",
            "HYPERGLYCAEMIA": "Metabolism and Nutrition Disorders",
            "THYROID DYSFUNCTION": "Endocrine Disorders",
        },
        "ae_meddra": {
            "HYPOGLYCAEMIA": "Hypoglycaemia", "HYPERGLYCAEMIA": "Hyperglycaemia",
            "THYROID DYSFUNCTION": "Thyroid disorder",
        },
        "cm_drugs": [
            ("Metformin", "Glucophage", "Antidiabetic", ["Oral"], [500, 850, 1000], "mg"),
            ("Insulin Glargine", "Lantus", "Insulin", ["SC"], [10, 20, 30, 40], "IU"),
            ("Sitagliptin", "Januvia", "DPP-4 Inhibitor", ["Oral"], [50, 100], "mg"),
            ("Liraglutide", "Victoza", "GLP-1 Agonist", ["SC"], [0.6, 1.2, 1.8], "mg"),
            ("Levothyroxine", "Synthroid", "Thyroid Hormone", ["Oral"], [25, 50, 100, 150], "mcg"),
            ("Empagliflozin", "Jardiance", "SGLT2 Inhibitor", ["Oral"], [10, 25], "mg"),
        ],
        "mh_terms": ["TYPE 2 DIABETES", "HYPOTHYROIDISM", "OBESITY", "HYPERLIPIDAEMIA",
                     "METABOLIC SYNDROME", "POLYCYSTIC OVARY SYNDROME", "HYPERTENSION"],
        "lb_tests": [
            ("GLUCOSE (FASTING)", "GLUC", "mmol/L", 3.9, 5.8),
            ("HBA1C", "HBA1C", "%", 4.0, 5.7),
            ("INSULIN", "INS", "pmol/L", 18, 173),
            ("THYROID STIMULATING HORMONE", "TSH", "mIU/L", 0.4, 4.0),
            ("TRIGLYCERIDES", "TRIG", "mmol/L", 0.45, 1.69),
            ("HDL CHOLESTEROL", "HDLC", "mmol/L", 1.0, 2.5),
            ("LDL CHOLESTEROL", "LDLC", "mmol/L", 0.0, 2.6),
        ],
        "arms": ["Drug G 10 mg", "Drug G 25 mg", "Placebo"],
        "arm_codes": ["G10", "G25", "PBO"],
        "age_range": (30, 70),
    },
    "Respiratory": {
        "ae_terms": ["COUGH", "DYSPNOEA", "BRONCHOSPASM", "WHEEZING", "UPPER RESPIRATORY INFECTION",
                     "NASOPHARYNGITIS", "SPUTUM PRODUCTION", "CHEST TIGHTNESS", "EXACERBATION", "PNEUMONIA"],
        "ae_soc": {
            "BRONCHOSPASM": "Respiratory, Thoracic and Mediastinal Disorders",
            "WHEEZING": "Respiratory, Thoracic and Mediastinal Disorders",
            "SPUTUM PRODUCTION": "Respiratory, Thoracic and Mediastinal Disorders",
            "CHEST TIGHTNESS": "Respiratory, Thoracic and Mediastinal Disorders",
            "EXACERBATION": "Respiratory, Thoracic and Mediastinal Disorders",
            "PNEUMONIA": "Infections and Infestations",
        },
        "ae_meddra": {
            "BRONCHOSPASM": "Bronchospasm", "WHEEZING": "Wheezing",
            "EXACERBATION": "Chronic obstructive pulmonary disease exacerbation",
            "PNEUMONIA": "Pneumonia",
        },
        "cm_drugs": [
            ("Salmeterol/Fluticasone", "Advair", "Combination ICS/LABA", ["Inhaled"], [100, 250, 500], "mcg"),
            ("Tiotropium", "Spiriva", "LAMA", ["Inhaled"], [18], "mcg"),
            ("Salbutamol", "Ventolin", "SABA", ["Inhaled"], [100, 200], "mcg"),
            ("Budesonide", "Pulmicort", "ICS", ["Inhaled"], [100, 200, 400], "mcg"),
            ("Montelukast", "Singulair", "Leukotriene Antagonist", ["Oral"], [4, 5, 10], "mg"),
            ("Prednisolone", "Prelone", "Corticosteroid", ["Oral"], [5, 10, 20, 30], "mg"),
        ],
        "mh_terms": ["ASTHMA", "COPD", "ALLERGIC RHINITIS", "SMOKING HISTORY",
                     "PRIOR HOSPITALIZATION FOR RESPIRATORY DISEASE", "OBSTRUCTIVE SLEEP APNOEA"],
        "lb_tests": [
            ("FEV1", "FEV1", "L", 1.5, 4.0),
            ("FVC", "FVC", "L", 2.0, 5.0),
            ("FEV1/FVC", "FEV1FVC", "%", 70, 85),
            ("EOSINOPHILS", "EOS", "10^9/L", 0.04, 0.44),
            ("IgE", "IGE", "IU/mL", 0, 100),
            ("C-REACTIVE PROTEIN", "CRP", "mg/L", 0.0, 10.0),
        ],
        "arms": ["Drug H 200 mcg", "Drug H 400 mcg", "Placebo"],
        "arm_codes": ["H200", "H400", "PBO"],
        "age_range": (25, 75),
    },
    "Rare Disease": {
        "ae_terms": ["FATIGUE", "MUSCLE WEAKNESS", "RESPIRATORY FAILURE", "DYSPHAGIA",
                     "PAIN", "OEDEMA", "COGNITIVE IMPAIRMENT", "SEIZURE", "VISION LOSS", "ATAXIA"],
        "ae_soc": {
            "MUSCLE WEAKNESS": "Musculoskeletal and Connective Tissue Disorders",
            "RESPIRATORY FAILURE": "Respiratory, Thoracic and Mediastinal Disorders",
            "DYSPHAGIA": "Gastrointestinal Disorders",
            "VISION LOSS": "Eye Disorders",
        },
        "ae_meddra": {
            "MUSCLE WEAKNESS": "Muscle weakness", "RESPIRATORY FAILURE": "Respiratory failure",
            "DYSPHAGIA": "Dysphagia", "VISION LOSS": "Visual acuity reduced",
        },
        "cm_drugs": [
            ("Alglucosidase alfa", "Myozyme", "Enzyme Replacement", ["IV"], [20], "mg/kg"),
            ("Miglustat", "Zavesca", "Enzyme Inhibitor", ["Oral"], [100], "mg"),
            ("Eculizumab", "Soliris", "Complement Inhibitor", ["IV"], [300, 600, 900], "mg"),
            ("Nusinersen", "Spinraza", "Antisense Oligonucleotide", ["Intrathecal"], [12], "mg"),
            ("Prednisolone", "Prelone", "Corticosteroid", ["Oral"], [5, 10, 20], "mg"),
        ],
        "mh_terms": ["GENETIC MUTATION CONFIRMED", "FAMILY HISTORY OF DISEASE", "ENZYME DEFICIENCY",
                     "PRIOR SYMPTOM ONSET", "DISABILITY"],
        "lb_tests": [
            ("CREATINE KINASE", "CK", "U/L", 25, 200),
            ("ALDOLASE", "ALD", "U/L", 1.0, 7.5),
            ("ALANINE AMINOTRANSFERASE", "ALT", "U/L", 7.0, 56.0),
            ("LACTATE DEHYDROGENASE", "LDH", "U/L", 140, 280),
        ],
        "arms": ["Drug I Active", "Placebo"],
        "arm_codes": ["ACT", "PBO"],
        "age_range": (5, 55),
    },
}

_TA_DEFAULT = {
    "ae_terms": _AE_TERMS,
    "ae_soc": _AE_SOC_MAP,
    "ae_meddra": _AE_MEDDRA_MAP,
    "cm_drugs": _CM_DRUG_PROFILES,
    "mh_terms": _MH_TERMS,
    "lb_tests": _LB_TESTS,
    "arms": _ARMS,
    "arm_codes": _ARM_CODES,
    "age_range": (18, 70),
}

_COL_ALIASES: dict[str, list[str]] = {
    "Study_ID":          ["Study_ID", "Study_Number", "Protocol_ID", "Trial_ID", "Study_Code"],
    "Site_Number":       ["Site_Number", "Site_ID", "Center_ID", "Investigator_Site", "Site_Code"],
    "Patient_ID":        ["Patient_ID", "Subject_ID", "Participant_ID", "Pt_ID", "Unique_Subject_ID"],
    "Subject_Number":    ["Subject_Number", "Subject_Seq", "Patient_Seq", "Enrollment_Number", "Subject_No"],
    "Visit_Name":        ["Visit_Name", "Visit", "Visit_Description", "Study_Visit", "Visit_Label"],
    "Visit_Date":        ["Visit_Date", "Visit_Dt", "Clinic_Date", "Assessment_Date"],
    "Data_Entry_Date":   ["Data_Entry_Date", "Entry_Date", "Form_Date", "CRF_Entry_Date"],
    "Data_Entry_By":     ["Data_Entry_By", "Entered_By", "User_ID", "Operator_ID"],
    "Record_Locked":     ["Record_Locked", "Lock_Status", "CRF_Locked", "Data_Locked"],
    "Record_Verified":   ["Record_Verified", "Verified_Flag", "SDV_Status", "SDV_Done"],
    "Source_System":     ["Source_System", "EDC_System", "Data_Capture_System", "Platform"],
    "Gender":            ["Gender", "Sex", "Patient_Sex", "Subject_Gender", "Biological_Sex"],
    "Race":              ["Race", "Racial_Group", "Patient_Race", "Race_Category"],
    "Ethnicity":         ["Ethnicity", "Ethnic_Group", "Hispanic_Origin", "Ethnic_Category"],
    "Age_at_Enrollment": ["Age_at_Enrollment", "Age", "Age_at_Study_Entry", "Subject_Age", "Age_Years"],
    "Age_Units":         ["Age_Units", "Age_Unit", "Unit_of_Age"],
    "Date_of_Birth":     ["Date_of_Birth", "DOB", "Birth_Date", "Patient_DOB", "Subject_DOB"],
    "Country_of_Birth":  ["Country_of_Birth", "Birth_Country", "Country", "Subject_Country"],
    "Treatment_Group":   ["Treatment_Group", "Arm_Name", "Study_Arm", "Trial_Arm", "Assigned_Treatment"],
    "Arm_Code":          ["Arm_Code", "Treatment_Code", "Arm_ID", "Treatment_ID", "Randomization_Arm"],
    "Randomization_Number": ["Randomization_Number", "Rand_Number", "Randomization_ID", "Rand_Code"],
    "Randomization_Date":   ["Randomization_Date", "Rand_Date", "Randomisation_Dt", "Date_Randomized"],
    "Informed_Consent_Date":["Informed_Consent_Date", "ICF_Date", "Consent_Date", "IC_Date"],
    "Patient_Initials":  ["Patient_Initials", "Subject_Initials", "Pt_Initials", "Name_Initials"],
    "Study_Start_Date":  ["Study_Start_Date", "First_Dose_Date", "Study_Entry_Date", "Treatment_Start"],
    "Study_End_Date":    ["Study_End_Date", "Last_Dose_Date", "Study_Exit_Date", "Treatment_End"],
    "Death_Flag":        ["Death_Flag", "Deceased", "Death_Indicator", "Fatal_Outcome", "Died"],
    "Date_of_Death":     ["Date_of_Death", "Death_Date", "DOD", "Fatal_Date"],
    "Adverse_Event":     ["Adverse_Event", "AE_Term", "AE_Description", "Event_Description", "Verbatim_AE"],
    "MedDRA_Preferred_Term": ["MedDRA_Preferred_Term", "MedDRA_PT", "Preferred_Term", "Coded_AE"],
    "System_Organ_Class":["System_Organ_Class", "SOC", "Body_System", "Organ_Class", "MedDRA_SOC"],
    "Severity":          ["Severity", "AE_Severity", "Intensity", "AE_Intensity", "Grade_Severity"],
    "Serious_AE":        ["Serious_AE", "SAE_Flag", "Is_Serious", "SAE_Indicator", "Serious_Flag"],
    "Causality":         ["Causality", "Relatedness", "AE_Causality", "Causal_Relationship"],
    "Outcome":           ["Outcome", "AE_Outcome", "Resolution_Status", "Event_Outcome"],
    "Action_Taken":      ["Action_Taken", "Drug_Action", "Treatment_Action", "Drug_Modification"],
    "AE_Start_Date":     ["AE_Start_Date", "Event_Start_Date", "Onset_Date", "AE_Onset_Date"],
    "AE_End_Date":       ["AE_End_Date", "Event_End_Date", "Resolution_Date", "AE_Resolution_Date"],
    "Toxicity_Grade":    ["Toxicity_Grade", "CTCAE_Grade", "Tox_Grade", "CTC_Grade", "NCI_Grade"],
    "Concomitant_Treatment": ["Concomitant_Treatment", "Concom_Meds", "Concurrent_Treatment"],
    "Drug_Name":         ["Drug_Name", "Trade_Name", "Brand_Name", "Medication_Name"],
    "Generic_Name":      ["Generic_Name", "INN", "Active_Ingredient", "Generic_Drug"],
    "Medication_Category":["Medication_Category", "Conmed_Category", "Med_Type", "Prior_Concomitant"],
    "Drug_Class":        ["Drug_Class", "ATC_Class", "Therapeutic_Class", "Pharmacological_Class"],
    "Dose":              ["Dose", "Dose_Amount", "Administered_Dose", "Dose_Strength", "Amount"],
    "Dose_Unit":         ["Dose_Unit", "Unit", "Dosage_Unit", "Dose_UOM", "Strength_Unit"],
    "Frequency":         ["Frequency", "Dosing_Frequency", "Dose_Frequency", "Admin_Frequency"],
    "Route_of_Admin":    ["Route_of_Admin", "Route", "Admin_Route", "Dosing_Route"],
    "Medication_Start":  ["Medication_Start", "CM_Start_Date", "Drug_Start_Date", "Med_Start_Dt"],
    "Medication_Stop":   ["Medication_Stop", "CM_End_Date", "Drug_Stop_Date", "Med_End_Dt"],
    "Still_Taking":      ["Still_Taking", "Ongoing_Flag", "Continuing", "Current_Med"],
    "Indication":        ["Indication", "Drug_Indication", "Reason_for_Use", "Therapeutic_Indication"],
    "Lab_Test_Name":     ["Lab_Test_Name", "Test_Name", "Lab_Parameter", "Lab_Test", "Analysis_Name"],
    "Lab_Test_Code":     ["Lab_Test_Code", "Test_Code", "Lab_Code", "Parameter_Code"],
    "Lab_Category":      ["Lab_Category", "Lab_Type", "Panel", "Test_Category", "Lab_Panel"],
    "Result_Value":      ["Result_Value", "Lab_Result", "Result", "Value", "Test_Result"],
    "Result_Unit":       ["Result_Unit", "Unit", "Lab_Unit", "UOM", "Test_Unit"],
    "Normal_Range_Lo":   ["Normal_Range_Lo", "Ref_Low", "Reference_Low", "Normal_Low", "LLN"],
    "Normal_Range_Hi":   ["Normal_Range_Hi", "Ref_High", "Reference_High", "Normal_High", "ULN"],
    "Abnormality_Flag":  ["Abnormality_Flag", "Flag", "Abnormal_Flag", "Out_of_Range", "Lab_Flag"],
    "Sample_Date":       ["Sample_Date", "Collection_Date", "Sampling_Date", "Draw_Date"],
    "Specimen_Type":     ["Specimen_Type", "Sample_Type", "Matrix", "Specimen"],
    "Vital_Sign":        ["Vital_Sign", "Measurement", "Parameter", "Vital_Parameter", "VS_Test"],
    "Measurement_Code":  ["Measurement_Code", "Test_Code", "VS_Code", "Param_Code"],
    "Measured_Value":    ["Measured_Value", "Result", "Value", "VS_Result", "Measurement_Value"],
    "Measurement_Unit":  ["Measurement_Unit", "Unit", "VS_Unit", "UOM"],
    "Normal_Low":        ["Normal_Low", "Ref_Low", "LLN", "Lower_Limit"],
    "Normal_High":       ["Normal_High", "Ref_High", "ULN", "Upper_Limit"],
    "Measurement_Date":  ["Measurement_Date", "Assessment_Date", "VS_Date", "Exam_Date"],
    "Patient_Position":  ["Patient_Position", "Position", "Body_Position", "Subject_Position"],
    "Body_Location":     ["Body_Location", "Measurement_Site", "Location", "Anatomical_Location"],
    "Investigational_Drug": ["Investigational_Drug", "Study_Drug", "Treatment", "IMP_Name", "Drug_Administered"],
    "Dose_Administered":    ["Dose_Administered", "Actual_Dose", "Administered_Dose", "Dose_Given"],
    "Dosage_Form":          ["Dosage_Form", "Formulation", "Drug_Form", "Admin_Form"],
    "Dosing_Frequency":     ["Dosing_Frequency", "Frequency", "Admin_Frequency", "Dose_Schedule"],
    "Route":                ["Route", "Route_of_Admin", "Admin_Route", "Administration_Route"],
    "Treatment_Start_Date": ["Treatment_Start_Date", "IMP_Start_Date", "First_Dose_Date", "Drug_Start_Date"],
    "Treatment_End_Date":   ["Treatment_End_Date", "IMP_End_Date", "Last_Dose_Date", "Drug_End_Date"],
    "Lot_Number":           ["Lot_Number", "Batch_Number", "Drug_Lot", "IMP_Lot"],
    "Study_Epoch":          ["Study_Epoch", "Trial_Period", "Epoch", "Study_Phase_Name"],
    "Medical_Condition":    ["Medical_Condition", "Condition", "Medical_History_Term", "Diagnosis", "Disease"],
    "Coded_Diagnosis":      ["Coded_Diagnosis", "MedDRA_Term", "Coded_Term", "MedDRA_Code"],
    "History_Category":     ["History_Category", "MH_Category", "Category", "History_Type"],
    "Body_System":          ["Body_System", "Body_Organ", "System_Organ_Class", "Organ_System"],
    "Pre_Specified":        ["Pre_Specified", "Protocol_Listed", "Pre_Existing", "Prior_Condition"],
    "Condition_Present":    ["Condition_Present", "Present_Flag", "Status", "Active_Flag"],
    "Condition_Start_Date": ["Condition_Start_Date", "Onset_Date", "Diagnosis_Date", "MH_Start_Date"],
    "Condition_End_Date":   ["Condition_End_Date", "Resolution_Date", "MH_End_Date", "End_Date"],
    "Ongoing":              ["Ongoing", "Continuing", "Still_Present", "Unresolved"],
    "Disposition_Status":   ["Disposition_Status", "Study_Status", "Completion_Status", "Final_Status"],
    "Reason_for_Stopping":  ["Reason_for_Stopping", "Discontinuation_Reason", "Withdrawal_Reason", "Stop_Reason"],
    "Disposition_Category": ["Disposition_Category", "DS_Category", "Event_Category", "Disposition_Type"],
    "Subcategory":          ["Subcategory", "DS_Subcategory", "Event_Subcategory", "Detail"],
    "Disposition_Date":     ["Disposition_Date", "DS_Date", "Completion_Date", "Final_Visit_Date"],
    "Study_Phase":          ["Study_Phase", "Trial_Phase", "Study_Period", "Epoch"],
    "Visit_Start_Date":     ["Visit_Start_Date", "Visit_Begin_Date", "Check_In_Date", "Visit_In_Date"],
    "Visit_End_Date":       ["Visit_End_Date", "Visit_Finish_Date", "Check_Out_Date", "Visit_Out_Date"],
    "Unplanned_Visit_Desc": ["Unplanned_Visit_Desc", "Unscheduled_Visit_Reason", "Visit_Comment"],
}

_RUNTIME_COL_MAP: dict[str, str] = {}

def _remap_col(canonical: str) -> str:
    """Return the alias chosen for this dataset run (consistent within one call)."""
    if canonical in _RUNTIME_COL_MAP:
        return _RUNTIME_COL_MAP[canonical]
    return canonical

def _init_col_map(domain: str) -> None:
    """Pick random aliases for all columns; call once per _gen_raw_edc invocation."""
    global _RUNTIME_COL_MAP
    _RUNTIME_COL_MAP = {}
    for canonical, aliases in _COL_ALIASES.items():
        _RUNTIME_COL_MAP[canonical] = random.choice(aliases)

# ─── Cross-domain subject pool ────────────────────────────────────────────────

def _build_subject_pool(n: int, study_id: str, ref_start: date, ta: dict) -> list[dict]:
    """Build a fixed roster of *n* subjects with consistent demographics and
    treatment assignments.  Every domain generator for the same generation call
    draws from this pool, guaranteeing USUBJID / SITEID / ARM correlation.
    """
    ta_arms = ta.get("arms", _ARMS)
    ta_arm_codes = ta.get("arm_codes", _ARM_CODES)
    ta_age_range = ta.get("age_range", (18, 70))
    n_sites = max(2, min(n, 10))
    site_ids = [f"{i:03d}" for i in range(1, n_sites + 1)]

    subjects: list[dict] = []
    for i in range(1, n + 1):
        site = site_ids[(i - 1) % n_sites]
        arm_idx = (i - 1) % len(ta_arm_codes)
        rfstdtc = _randdate(ref_start, ref_start + timedelta(days=90))
        rfendtc = rfstdtc + timedelta(days=random.randint(84, 365))
        dob = _randdate(
            date.today() - timedelta(days=int(ta_age_range[1] * 365.25)),
            date.today() - timedelta(days=int(ta_age_range[0] * 365.25)),
        )
        subjects.append({
            "usubjid":  _usubjid(study_id, site, i),
            "subjid":   f"{i:04d}",
            "siteid":   site,
            "arm_idx":  arm_idx,
            "armcd":    ta_arm_codes[arm_idx],
            "arm":      ta_arms[arm_idx],
            "rfstdtc":  rfstdtc,
            "rfendtc":  rfendtc,
            "dob":      dob,
            "age":      max(ta_age_range[0], min(ta_age_range[1], (ref_start - dob).days // 365)),
            "sex":      random.choice(["M", "F"]),
            "race":     random.choice(_RACES),
            "ethnic":   random.choice(_ETHNICS),
            "country":  random.choice(_COUNTRIES),
        })
    return subjects


def _call_gen(
    gen_fn,
    rows_per: int,
    study_id: str,
    dm_df: "pd.DataFrame | None",
    ref_start: date,
) -> "pd.DataFrame":
    """Call a domain generator, ensuring USUBJID correlation with *dm_df*.

    Generators that accept ``dm_df`` are called directly.  Generators with the
    legacy ``(n, study_id, ref_start)`` signature are called without it and their
    USUBJID column is then remapped to the subject pool from *dm_df*, so that
    every domain shares the same set of subject identifiers.
    """
    try:
        return gen_fn(rows_per, study_id, dm_df, ref_start)
    except TypeError:
        df = gen_fn(rows_per, study_id, ref_start)
        if dm_df is not None and len(dm_df) and "USUBJID" in df.columns:
            pool = dm_df["USUBJID"].tolist()
            df["USUBJID"] = [pool[i % len(pool)] for i in range(len(df))]
        return df


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _study_id() -> str:
    return "STUDY-001"

def _site_id(n: int = 5) -> str:
    return f"{random.randint(1, n):03d}"

def _usubjid(studyid: str, siteid: str, subjnum: int) -> str:
    return f"{studyid}-{siteid}-{subjnum:04d}"

def _randdate(start: date, end: date) -> date:
    delta = (end - start).days
    return start + timedelta(days=random.randint(0, max(delta, 0)))

def _fmt_date(d: date) -> str:
    return d.isoformat()

def _add_anomalies_to_df(df: pd.DataFrame, rate: float = 0.05) -> pd.DataFrame:
    """Inject realistic clinical data anomalies."""
    df = df.copy()
    n = len(df)
    rng = range(n)
    cols = list(df.columns)

    # 1. Missing values in non-key fields
    key_cols = {"STUDYID", "DOMAIN", "USUBJID"}
    non_key = [c for c in cols if c not in key_cols]
    for col in random.sample(non_key, min(3, len(non_key))):
        idx = random.sample(list(rng), max(1, int(n * rate)))
        df.loc[idx, col] = None

    # 2. Duplicate records
    dup_count = max(1, int(n * rate * 0.5))
    dup_rows = df.sample(n=min(dup_count, len(df))).copy()
    df = pd.concat([df, dup_rows], ignore_index=True)

    # 3. Outlier numeric values
    numeric_cols = df.select_dtypes(include=["number"]).columns.tolist()
    for col in numeric_cols[:2]:
        idx = random.randint(0, len(df) - 1)
        val = df.loc[idx, col]
        if pd.notna(val):
            df.loc[idx, col] = val * 10  # 10x outlier

    return df

# ─── SDTM Domain Generators ──────────────────────────────────────────────────

def _gen_dm(n: int, study_id: str, ref_start: date, subjects: list[dict] | None = None) -> pd.DataFrame:
    pool = subjects if subjects is not None else _build_subject_pool(n, study_id, ref_start, _TA_DEFAULT)
    rows = []
    for s in pool[:n]:
        rfstdtc = s["rfstdtc"]
        rfendtc = s["rfendtc"]
        rows.append({
            "STUDYID": study_id, "DOMAIN": "DM",
            "USUBJID": s["usubjid"], "SUBJID": s["subjid"],
            "RFSTDTC": _fmt_date(rfstdtc), "RFENDTC": _fmt_date(rfendtc),
            "RFXSTDTC": _fmt_date(rfstdtc), "RFXENDTC": _fmt_date(rfendtc),
            "RFICDTC": _fmt_date(rfstdtc - timedelta(days=random.randint(1, 14))),
            "RFPENDTC": _fmt_date(rfendtc + timedelta(days=30)),
            "DTHFL": random.choices(["", "Y"], weights=[0.97, 0.03])[0],
            "SITEID": s["siteid"], "AGE": s["age"], "AGEU": "YEARS",
            "SEX": s["sex"], "RACE": s["race"],
            "ETHNIC": s["ethnic"],
            "ARMCD": s["armcd"], "ARM": s["arm"],
            "ACTARMCD": s["armcd"], "ACTARM": s["arm"],
            "COUNTRY": s["country"],
            "DMDTC": _fmt_date(rfstdtc), "DMDY": 1,
        })
    return pd.DataFrame(rows)

def _gen_ae(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 3, 1) + 1)
    ]
    seq = 1
    total = 0
    while total < n:
        for usubjid in subjects:
            if total >= n:
                break
            term_idx = random.randint(0, len(_AE_TERMS) - 1)
            term = _AE_TERMS[term_idx]
            soc = random.choice(_AE_SOC)
            aestdtc = _randdate(ref_start, ref_start + timedelta(days=300))
            aeendtc = aestdtc + timedelta(days=random.randint(1, 30))
            rows.append({
                "STUDYID": study_id, "DOMAIN": "AE",
                "USUBJID": usubjid, "AESEQ": seq, "AESPID": f"AE{seq:04d}",
                "AETERM": term, "AELLT": term, "AELLTCD": random.randint(10000000, 99999999),
                "AEDECOD": term, "AEPTCD": random.randint(10000000, 99999999),
                "AEHLT": random.choice(_AE_HLT), "AEHLTCD": random.randint(10000000, 99999999),
                "AEHLGT": random.choice(_AE_HLGT), "AEHLGTCD": random.randint(10000000, 99999999),
                "AEBODSYS": soc, "AEBDSYCD": random.randint(10000000, 99999999),
                "AESOC": soc, "AESOCCD": random.randint(10000000, 99999999),
                "AESEV": random.choice(_AE_SEVERITY), "AESER": random.choice(_AE_SERIOUS),
                "AEACN": random.choice(_AE_ACTION), "AEREL": random.choice(_AE_RELATION),
                "AEOUT": random.choice(_AE_OUTCOME),
                "AESTDTC": _fmt_date(aestdtc), "AEENDTC": _fmt_date(aeendtc),
                "AESTDY": (aestdtc - ref_start).days + 1,
                "AEENDY": (aeendtc - ref_start).days + 1,
            })
            seq += 1
            total += 1

    return pd.DataFrame(rows)

def _gen_lb(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 10, 1) + 1)
    ]
    seq = 1
    total = 0
    visits = _VISITS[:6]
    while total < n:
        for usubjid in subjects:
            for visit in visits:
                if total >= n:
                    break
                test = random.choice(_LB_TESTS)
                lbdtc = _randdate(ref_start, ref_start + timedelta(days=350))
                normal_low, normal_high = test[3], test[4]
                val = round(random.uniform(normal_low * 0.8, normal_high * 1.2), 2)
                rows.append({
                    "STUDYID": study_id, "DOMAIN": "LB",
                    "USUBJID": usubjid, "LBSEQ": seq,
                    "LBTESTCD": test[1], "LBTEST": test[0],
                    "LBCAT": "CHEMISTRY", "LBSCAT": "",
                    "LBORRES": str(val), "LBORRESU": test[2],
                    "LBSTRESC": str(val), "LBSTRESN": val, "LBSTRESU": test[2],
                    "LBNRLO": str(test[3]), "LBNRHI": str(test[4]),
                    "LBNRIND": "LOW" if val < test[3] else ("HIGH" if val > test[4] else "NORMAL"),
                    "LBBLFL": "Y" if visit == "BASELINE" else "",
                    "VISIT": visit, "VISITNUM": _VISITS.index(visit),
                    "LBDTC": _fmt_date(lbdtc),
                    "LBDY": (lbdtc - ref_start).days + 1,
                })
                seq += 1
                total += 1
    return pd.DataFrame(rows)

def _gen_vs(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 6, 1) + 1)
    ]
    seq = 1
    total = 0
    visits = _VISITS[:5]
    while total < n:
        for usubjid in subjects:
            for visit in visits:
                if total >= n:
                    break
                test = random.choice(_VS_TESTS)
                vsdtc = _randdate(ref_start, ref_start + timedelta(days=350))
                val = round(random.uniform(test[3], test[4]), 1)
                rows.append({
                    "STUDYID": study_id, "DOMAIN": "VS",
                    "USUBJID": usubjid, "VSSEQ": seq,
                    "VSTESTCD": test[1], "VSTEST": test[0],
                    "VSCAT": "VITAL SIGNS",
                    "VSORRES": str(val), "VSORRESU": test[2],
                    "VSSTRESC": str(val), "VSSTRESN": val, "VSSTRESU": test[2],
                    "VSBLFL": "Y" if visit == "BASELINE" else "",
                    "VISIT": visit, "VISITNUM": _VISITS.index(visit),
                    "VSDTC": _fmt_date(vsdtc), "VSDY": (vsdtc - ref_start).days + 1,
                })
                seq += 1
                total += 1
    return pd.DataFrame(rows)

def _gen_cm(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 2, 1) + 1)
    ]
    seq = 1
    total = 0
    while total < n:
        for usubjid in subjects:
            if total >= n:
                break
            drug = random.choice(_CM_DRUGS)
            cmstdtc = _randdate(ref_start - timedelta(days=180), ref_start + timedelta(days=300))
            cmendtc = cmstdtc + timedelta(days=random.randint(7, 365))
            dose = random.randint(50, 500)
            unit = random.choice(_CM_DOSE_UNITS)
            rows.append({
                "STUDYID": study_id, "DOMAIN": "CM",
                "USUBJID": usubjid, "CMSEQ": seq, "CMSPID": f"CM{seq:04d}",
                "CMTRT": drug, "CMCAT": "PRIOR AND CONCOMITANT MEDICATIONS",
                "CMDOSE": dose, "CMDOSU": unit, "CMDOSFRQ": "QD",
                "CMROUTE": "ORAL",
                "CMSTDTC": _fmt_date(cmstdtc), "CMENDTC": _fmt_date(cmendtc),
                "CMSTDY": (cmstdtc - ref_start).days + 1,
                "CMENDY": (cmendtc - ref_start).days + 1,
            })
            seq += 1
            total += 1
    return pd.DataFrame(rows)

def _gen_ex(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 6, 1) + 1)
    ]
    seq = 1
    total = 0
    while total < n:
        for usubjid in subjects:
            for visit in _VISITS[1:7]:
                if total >= n:
                    break
                exdtc = _randdate(ref_start, ref_start + timedelta(days=300))
                rows.append({
                    "STUDYID": study_id, "DOMAIN": "EX",
                    "USUBJID": usubjid, "EXSEQ": seq,
                    "EXTRT": "STUDY DRUG", "EXCAT": "STUDY MEDICATION",
                    "EXDOSE": 100, "EXDOSU": "mg", "EXDOSFRM": "TABLET",
                    "EXDOSFRQ": "QD", "EXROUTE": "ORAL",
                    "VISIT": visit, "VISITNUM": _VISITS.index(visit),
                    "EXSTDTC": _fmt_date(exdtc), "EXENDTC": _fmt_date(exdtc),
                    "EXSTDY": (exdtc - ref_start).days + 1,
                    "EXENDY": (exdtc - ref_start).days + 1,
                })
                seq += 1
                total += 1
    return pd.DataFrame(rows)

def _gen_mh(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // 2, 1) + 1)
    ]
    seq = 1
    total = 0
    while total < n:
        for usubjid in subjects:
            if total >= n:
                break
            term = random.choice(_MH_TERMS)
            mhstdtc = _randdate(ref_start - timedelta(days=3650), ref_start)
            rows.append({
                "STUDYID": study_id, "DOMAIN": "MH",
                "USUBJID": usubjid, "MHSEQ": seq, "MHSPID": f"MH{seq:04d}",
                "MHTERM": term, "MHDECOD": term,
                "MHBODSYS": random.choice(_AE_SOC), "MHCAT": "MEDICAL HISTORY",
                "MHPRESP": "Y", "MHOCCUR": "Y",
                "MHSTDTC": _fmt_date(mhstdtc),
            })
            seq += 1
            total += 1
    return pd.DataFrame(rows)

def _gen_ds(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, n + 1)
    ]
    rows_data = []
    for i, usubjid in enumerate(subjects[:n]):
        dscode = random.choices(
            _DS_DSCODES, weights=[0.70, 0.10, 0.08, 0.05, 0.03, 0.02, 0.02]
        )[0]
        dsdtc = _randdate(ref_start + timedelta(days=84), ref_start + timedelta(days=400))
        rows_data.append({
            "STUDYID": study_id, "DOMAIN": "DS",
            "USUBJID": usubjid, "DSSEQ": i + 1, "DSSPID": f"DS{i+1:04d}",
            "DSTERM": dscode, "DSDECOD": dscode,
            "DSCAT": "DISPOSITION EVENT", "DSSCAT": "STUDY COMPLETION",
            "EPOCH": "TREATMENT",
            "DSDTC": _fmt_date(dsdtc), "DSDY": (dsdtc - ref_start).days + 1,
        })
    return pd.DataFrame(rows_data)

def _gen_sv(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    rows = []
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, max(n // len(_VISITS), 1) + 1)
    ]
    seq = 1
    total = 0
    while total < n:
        for usubjid in subjects:
            for vi, visit in enumerate(_VISITS):
                if total >= n:
                    break
                svstdtc = ref_start + timedelta(days=vi * 14 + random.randint(-2, 2))
                svstdtc = max(svstdtc, ref_start - timedelta(days=14))
                rows.append({
                    "STUDYID": study_id, "DOMAIN": "SV",
                    "USUBJID": usubjid, "VISITNUM": vi, "VISIT": visit,
                    "VISITDY": vi * 14, "SVSTDTC": _fmt_date(svstdtc),
                    "SVENDTC": _fmt_date(svstdtc), "SVSTDY": (svstdtc - ref_start).days + 1,
                    "SVENDY": (svstdtc - ref_start).days + 1,
                })
                seq += 1
                total += 1
    return pd.DataFrame(rows)

def _gen_ie(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    ie_tests = [("Inclusion: Age >= 18", "INCL01", "Y"), ("Inclusion: Diagnosis confirmed", "INCL02", "Y"),
                ("Exclusion: Prior treatment", "EXCL01", "N"), ("Exclusion: Pregnancy", "EXCL02", "N")]
    for i in range(1, n + 1):
        site = _site_id()
        test_term, test_code, expected = random.choice(ie_tests)
        iedtc = _randdate(ref_start - timedelta(days=14), ref_start)
        rows.append({
            "STUDYID": study_id, "DOMAIN": "IE",
            "USUBJID": _usubjid(study_id, site, i),
            "IESEQ": i, "IETESTCD": test_code, "IETEST": test_term,
            "IEORRES": expected, "IEDTC": _fmt_date(iedtc),
        })
    return pd.DataFrame(rows)

def _gen_qs(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    qs_tests = [("QUESTIONNAIRE ITEM 1", "QS01", "Score"), ("QUESTIONNAIRE ITEM 2", "QS02", "Score"),
                ("QUESTIONNAIRE ITEM 3", "QS03", "Score"), ("TOTAL SCORE", "QSTOT", "Total")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name, cat = random.choice([(t[1], t[0], t[2]) for t in qs_tests])
        score = random.randint(0, 10)
        qsdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "QS",
            "USUBJID": _usubjid(study_id, site, i),
            "QSSEQ": i, "QSTESTCD": test_code, "QSTEST": test_name,
            "QSORRES": str(score), "QSSTRESN": float(score),
            "VISIT": random.choice(_VISITS), "QSDTC": _fmt_date(qsdtc),
        })
    return pd.DataFrame(rows)

def _gen_pe(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    pe_tests = [("GENERAL APPEARANCE", "GENAPP"), ("CARDIOVASCULAR", "CARDIO"),
                ("RESPIRATORY", "RESP"), ("ABDOMEN", "ABD"), ("NEUROLOGICAL", "NEURO")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(pe_tests)
        pedtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "PE",
            "USUBJID": _usubjid(study_id, site, i),
            "PESEQ": i, "PETESTCD": test_code, "PETEST": test_name,
            "PEORRES": random.choice(["NORMAL", "ABNORMAL", "NOT DONE"]),
            "PEDTC": _fmt_date(pedtc),
            "PESTAT": random.choice(["", "NOT DONE"]),
        })
    return pd.DataFrame(rows)

def _gen_sc(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    sc_tests = [("EDUCATION LEVEL", "EDLEVEL"), ("EMPLOYMENT STATUS", "EMPLOY"),
                ("SMOKING STATUS", "SMOKE"), ("ALCOHOL USE", "ALCOHOL")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(sc_tests)
        scdtc = _randdate(ref_start - timedelta(days=14), ref_start)
        rows.append({
            "STUDYID": study_id, "DOMAIN": "SC",
            "USUBJID": _usubjid(study_id, site, i),
            "SCSEQ": i, "SCTESTCD": test_code, "SCTEST": test_name,
            "SCORRES": random.choice(["YES", "NO", "UNKNOWN", "N/A"]),
            "SCDTC": _fmt_date(scdtc),
        })
    return pd.DataFrame(rows)

def _gen_co(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    co_tests = [("PROTOCOL DEVIATION", "PROTDEV"), ("GENERAL COMMENT", "GENCOM"),
                ("QUERY RESPONSE", "QRYRESP")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(co_tests)
        codtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "CO",
            "USUBJID": _usubjid(study_id, site, i),
            "COSEQ": i, "COTESTCD": test_code, "COTEST": test_name,
            "COVAL": fake.sentence(nb_words=8),
            "CODTC": _fmt_date(codtc),
        })
    return pd.DataFrame(rows)

def _gen_pc(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    pc_tests = [("DRUG CONCENTRATION", "CONC"), ("METABOLITE A", "META"),
                ("FREE DRUG", "FREEDRUG")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(pc_tests)
        pcdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        val = round(random.uniform(0.1, 500.0), 3)
        rows.append({
            "STUDYID": study_id, "DOMAIN": "PC",
            "USUBJID": _usubjid(study_id, site, i),
            "PCSEQ": i, "PCTESTCD": test_code, "PCTEST": test_name,
            "PCORRES": str(val), "PCSTRESC": str(val), "PCSTRESN": val,
            "PCSTRESU": random.choice(["ng/mL", "ug/mL", "mg/L"]),
            "PCDTC": _fmt_date(pcdtc),
            "PCRFTDTC": _fmt_date(pcdtc - timedelta(hours=random.randint(0, 24))),
        })
    return pd.DataFrame(rows)

def _gen_pr(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    pr_tests = [("BIOPSY", "BIOPSY"), ("SURGERY", "SURG"), ("INFUSION", "INF"),
                ("LUMBAR PUNCTURE", "LP"), ("BONE MARROW ASPIRATION", "BMA")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(pr_tests)
        prstdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        prenddtc = prstdtc + timedelta(days=random.randint(0, 7))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "PR",
            "USUBJID": _usubjid(study_id, site, i),
            "PRSEQ": i, "PRTESTCD": test_code, "PRTEST": test_name,
            "PROCCUR": random.choice(["Y", "N"]),
            "PRSTDTC": _fmt_date(prstdtc), "PRENDDTC": _fmt_date(prenddtc),
        })
    return pd.DataFrame(rows)

def _gen_rs(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    rs_tests = [("OVERALL RESPONSE", "OVRLRESP"), ("BEST OVERALL RESPONSE", "BESTRESP")]
    response_vals = ["COMPLETE RESPONSE", "PARTIAL RESPONSE", "STABLE DISEASE", "PROGRESSIVE DISEASE"]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(rs_tests)
        rsdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rsorres = random.choice(response_vals)
        rows.append({
            "STUDYID": study_id, "DOMAIN": "RS",
            "USUBJID": _usubjid(study_id, site, i),
            "RSSEQ": i, "RSTESTCD": test_code, "RSTEST": test_name,
            "RSORRES": rsorres, "RSSTRESC": rsorres,
            "RSDTC": _fmt_date(rsdtc),
            "RSEVAL": random.choice(["INVESTIGATOR", "INDEPENDENT ASSESSOR"]),
        })
    return pd.DataFrame(rows)

def _gen_is(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    is_tests = [("ANTI-DRUG ANTIBODY", "ADA"), ("NEUTRALIZING ANTIBODY", "NAB"),
                ("TOTAL ANTIBODY", "TOTAB")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(is_tests)
        isdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        val = round(random.uniform(0.0, 100.0), 2)
        rows.append({
            "STUDYID": study_id, "DOMAIN": "IS",
            "USUBJID": _usubjid(study_id, site, i),
            "ISSEQ": i, "ISTESTCD": test_code, "ISTEST": test_name,
            "ISORRES": str(val), "ISSTRESC": str(val),
            "ISBLFL": "Y" if random.random() < 0.2 else "",
            "ISDTC": _fmt_date(isdtc),
        })
    return pd.DataFrame(rows)

def _gen_fa(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    fa_tests = [("CAUSALITY ASSESSMENT", "CAUSAL"), ("SERIOUSNESS CRITERIA", "SERIO"),
                ("ACTION TAKEN", "ACTION")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(fa_tests)
        fadtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "FA",
            "USUBJID": _usubjid(study_id, site, i),
            "FASEQ": i, "FATESTCD": test_code, "FATEST": test_name,
            "FAOBJ": random.choice(["ADVERSE EVENT", "CONCOMITANT MED", "PROCEDURE"]),
            "FAORRES": random.choice(["YES", "NO", "UNKNOWN"]),
            "FADTC": _fmt_date(fadtc),
            "FALNKID": f"FA{i:04d}",
        })
    return pd.DataFrame(rows)

def _gen_ho(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    ho_terms = ["HOSPITALISATION", "EMERGENCY ROOM VISIT", "OUTPATIENT SURGERY", "CLINIC VISIT"]
    for i in range(1, n + 1):
        site = _site_id()
        hostdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        hoenddtc = hostdtc + timedelta(days=random.randint(1, 14))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "HO",
            "USUBJID": _usubjid(study_id, site, i),
            "HOSEQ": i,
            "HOHOSPFL": random.choice(["Y", "N"]),
            "HOENRTPT": random.choice(["BEFORE", "DURING", "AFTER"]),
            "HOENRLOC": random.choice(["HOSPITAL", "CLINIC", "ER"]),
            "HOSTDTC": _fmt_date(hostdtc), "HOENDDTC": _fmt_date(hoenddtc),
            "HOTERM": random.choice(ho_terms),
        })
    return pd.DataFrame(rows)

def _gen_tu(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    tu_tests = [("TARGET LESION 1", "TU01"), ("TARGET LESION 2", "TU02"),
                ("NON-TARGET LESION 1", "NTU01")]
    for i in range(1, n + 1):
        site = _site_id()
        test_code, test_name = random.choice(tu_tests)
        tudtc = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "DOMAIN": "TU",
            "USUBJID": _usubjid(study_id, site, i),
            "TUSEQ": i, "TUTESTCD": test_code, "TUTEST": test_name,
            "TULOC": random.choice(["LUNG", "LIVER", "LYMPH NODE", "BONE", "SKIN"]),
            "TUORRES": str(round(random.uniform(5.0, 100.0), 1)),
            "TUSTRESN": round(random.uniform(5.0, 100.0), 1),
            "TUDTC": _fmt_date(tudtc),
            "TUEVAL": random.choice(["INVESTIGATOR", "INDEPENDENT ASSESSOR"]),
        })
    return pd.DataFrame(rows)

# ─── ADaM Dataset Generators ─────────────────────────────────────────────────

def _gen_adsl(n: int, study_id: str, ref_start: date, subjects: list[dict] | None = None) -> pd.DataFrame:
    dm = _gen_dm(n, study_id, ref_start, subjects=subjects)
    adam = dm.rename(columns={"RFSTDTC": "TRTSDT", "RFENDTC": "TRTEDT"}).copy()
    adam["STUDYID"] = study_id
    adam["SUBJID"] = dm["SUBJID"]
    adam["TRTPN"] = dm["ARMCD"].map({"A": 1, "B": 2, "PBO": 3}).fillna(0).astype(int)
    adam["TRTP"] = dm["ARM"]
    adam["TRTAP"] = dm["ARM"]
    adam["TRTAN"] = adam["TRTPN"]
    adam["SAFFL"] = "Y"
    adam["ITTFL"] = "Y"
    adam["PPROTFL"] = random.choices(["Y", "N"], weights=[0.85, 0.15], k=len(dm))
    adam["COMPLFL"] = random.choices(["Y", "N"], weights=[0.78, 0.22], k=len(dm))
    adam["DCDECOD"] = random.choices(_DS_DSCODES, weights=[0.70,0.10,0.08,0.05,0.03,0.02,0.02], k=len(dm))
    adam["EOSSTT"] = adam["DCDECOD"].apply(lambda x: "COMPLETED" if x == "COMPLETED" else "DISCONTINUED")
    adam["RACEN"] = adam["RACE"].map({r: i+1 for i, r in enumerate(_RACES)}).fillna(0)
    adam["SEXN"] = adam["SEX"].map({"M": 1, "F": 2, "U": 3}).fillna(0)
    return adam

def _gen_adae(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    ae = _gen_ae(n, study_id, dm_df, ref_start)
    adae = ae.copy()
    adae["TRTEMFL"] = "Y"
    adae["AETOXGR"] = ae["AESEV"].map({"MILD": "1", "MODERATE": "2", "SEVERE": "3"})
    adae["AETOXGRN"] = adae["AETOXGR"].astype(float)
    adae["AERELN"] = ae["AEREL"].map({
        "NOT RELATED": 0, "POSSIBLY RELATED": 1, "PROBABLY RELATED": 2, "RELATED": 3
    }).fillna(0)
    adae["STUDYID"] = study_id
    adae["ANL01FL"] = "Y"
    return adae

def _gen_adlb(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    lb = _gen_lb(n, study_id, dm_df, ref_start)
    adlb = lb.copy()
    adlb["STUDYID"] = study_id
    adlb["PARAMCD"] = lb["LBTESTCD"]
    adlb["PARAM"] = lb["LBTEST"]
    adlb["AVAL"] = lb["LBSTRESN"]
    adlb["AVALC"] = lb["LBSTRESC"]
    adlb["AVALU"] = lb["LBSTRESU"]
    adlb["ANL01FL"] = "Y"
    adlb["DTYPE"] = ""
    # Baseline flag
    adlb["ABLFL"] = lb["LBBLFL"]
    return adlb

def _gen_advs(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    vs = _gen_vs(n, study_id, dm_df, ref_start)
    advs = vs.copy()
    advs["STUDYID"] = study_id
    advs["PARAMCD"] = vs["VSTESTCD"]
    advs["PARAM"] = vs["VSTEST"]
    advs["AVAL"] = vs["VSSTRESN"]
    advs["AVALC"] = vs["VSSTRESC"]
    advs["AVALU"] = vs["VSSTRESU"]
    advs["ANL01FL"] = "Y"
    advs["ABLFL"] = vs["VSBLFL"]
    return advs

def _gen_adcm(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    cm = _gen_cm(n, study_id, dm_df, ref_start)
    adcm = cm.copy()
    adcm["STUDYID"] = study_id
    adcm["ANL01FL"] = "Y"
    return adcm

def _gen_adtte(n: int, study_id: str, dm_df: pd.DataFrame | None, ref_start: date) -> pd.DataFrame:
    subjects = dm_df["USUBJID"].tolist() if dm_df is not None and len(dm_df) else [
        _usubjid(study_id, _site_id(), i) for i in range(1, n + 1)
    ]
    rows = []
    for usubjid in subjects[:n]:
        aval = random.uniform(10, 365)
        cnsr = random.choices([0, 1], weights=[0.30, 0.70])[0]
        rows.append({
            "STUDYID": study_id, "USUBJID": usubjid,
            "PARAMCD": "OS", "PARAM": "Overall Survival",
            "AVAL": round(aval, 1), "AVALU": "DAYS",
            "CNSR": cnsr, "CNSRSDT": "",
            "EVNTDESC": "DEATH" if cnsr == 0 else "CENSORED",
            "SRCDOM": "DS", "SRCVAR": "DSDTC",
            "ANL01FL": "Y",
        })
    return pd.DataFrame(rows)

def _gen_adex(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    arms = [("Drug A 100 mg", 1, 100, "mg"), ("Drug B 200 mg", 2, 200, "mg"), ("Placebo", 3, 0, "mg")]
    for i in range(1, n + 1):
        site = _site_id()
        arm_name, arm_n, dose, unit = random.choice(arms)
        exstdtc = _randdate(ref_start, ref_start + timedelta(days=300))
        exendtc = exstdtc + timedelta(days=random.randint(1, 14))
        rows.append({
            "STUDYID": study_id, "USUBJID": _usubjid(study_id, site, i),
            "TRTA": arm_name, "TRTAN": arm_n,
            "DOSE": dose, "DOSEUNIT": unit,
            "EXSTDTC": _fmt_date(exstdtc), "EXENDTC": _fmt_date(exendtc),
            "DOSFRQ": random.choice(["QD", "BID", "TID"]),
            "DOSFRMCD": random.choice(["TABLET", "CAPSULE", "INJECTION"]),
        })
    return pd.DataFrame(rows)

def _gen_admh(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    for i in range(1, n + 1):
        site = _site_id()
        term = random.choice(_MH_TERMS)
        mhstdtc = _randdate(ref_start - timedelta(days=3650), ref_start)
        mhenddtc = _randdate(mhstdtc, ref_start) if random.random() < 0.4 else None
        rows.append({
            "STUDYID": study_id, "USUBJID": _usubjid(study_id, site, i),
            "MHTERM": term, "MHDECOD": term,
            "MHBODSYS": random.choice(_AE_SOC),
            "MHSTDTC": _fmt_date(mhstdtc),
            "MHENDDTC": _fmt_date(mhenddtc) if mhenddtc else "",
            "MHONGO": "Y" if not mhenddtc else "N",
            "MHPRESP": "Y",
        })
    return pd.DataFrame(rows)

def _gen_adpp(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    params = [("AUC0-INF", "AUCINF", "ng*h/mL"), ("CMAX", "CMAX", "ng/mL"),
              ("TMAX", "TMAX", "h"), ("T1/2", "THALF", "h"), ("CL/F", "CLF", "L/h")]
    for i in range(1, n + 1):
        site = _site_id()
        param, paramcd, avalu = random.choice(params)
        aval = round(random.uniform(1.0, 1000.0), 3)
        rows.append({
            "STUDYID": study_id, "USUBJID": _usubjid(study_id, site, i),
            "PARAM": param, "PARAMCD": paramcd,
            "AVAL": aval, "AVALU": avalu,
            "PPCAT": "ANALYTE", "PPSPEC": random.choice(["PLASMA", "SERUM", "WHOLE BLOOD"]),
            "PPORRES": str(aval), "PPSTRESC": str(aval),
        })
    return pd.DataFrame(rows)

def _gen_adrs(n: int, study_id: str, ref_start: date) -> pd.DataFrame:
    rows = []
    responses = [("COMPLETE RESPONSE", "CR", 4), ("PARTIAL RESPONSE", "PR", 3),
                 ("STABLE DISEASE", "SD", 2), ("PROGRESSIVE DISEASE", "PD", 1)]
    for i in range(1, n + 1):
        site = _site_id()
        resp, paramcd, aval = random.choice(responses)
        adt = _randdate(ref_start, ref_start + timedelta(days=300))
        rows.append({
            "STUDYID": study_id, "USUBJID": _usubjid(study_id, site, i),
            "PARAM": "Best Overall Response", "PARAMCD": paramcd,
            "AVAL": aval, "AVALC": resp,
            "ADT": _fmt_date(adt), "ADY": (adt - ref_start).days + 1,
            "DTYPE": random.choice(["", "LOCF"]),
            "RSEVAL": random.choice(["INVESTIGATOR", "INDEPENDENT ASSESSOR"]),
        })
    return pd.DataFrame(rows)

# ─── CRF / Raw EDC Generators ────────────────────────────────────────────────

def _gen_crf(domain: str, n: int, study_id: str, ref_start: date, subjects: list[dict] | None = None) -> pd.DataFrame:
    """Generate raw CRF-style data (pre-CDISC, as collected) with domain-specific fields."""
    dom = domain.upper()
    rows = []
    for i in range(1, n + 1):
        # Pull subject demographics from pool when available
        if subjects:
            s = subjects[(i - 1) % len(subjects)]
            site  = s["siteid"]
            subj  = s["subjid"]
        else:
            site = _site_id()
            subj = f"{i:04d}"
        visit = random.choice(_VISITS)
        collected_date = _randdate(ref_start, ref_start + timedelta(days=300))

        row: dict[str, Any] = {
            "study_id":    study_id,
            "site_id":     site,
            "subject_id":  subj,
            "crf_page":    random.randint(1, 50),
            "visit_name":  visit,
            "collected_date": _fmt_date(collected_date),
            "form_name":   dom,
            "query_flag":  random.choices([0, 1], weights=[0.95, 0.05])[0],
            "missing_flag": random.choices([0, 1], weights=[0.97, 0.03])[0],
        }

        if dom == "AE":
            row.update({
                "ae_term":      random.choice(_AE_TERMS),
                "ae_severity":  random.choice(_AE_SEVERITY),
                "ae_serious":   random.choice(["YES", "NO"]),
                "ae_related":   random.choice(["YES", "NO", "POSSIBLE"]),
                "ae_outcome":   random.choice(_AE_OUTCOME),
                "ae_start_dt":  _fmt_date(collected_date),
                "ae_end_dt":    _fmt_date(_randdate(collected_date, collected_date + timedelta(days=30))),
            })
        elif dom == "DM":
            if subjects:
                _s = subjects[(i - 1) % len(subjects)]
                dob = _s["dob"]
                arm_idx = _s["arm_idx"]
                arm_name = _s["arm"]
                arm_code_val = _s["armcd"]
                sex_val = "Male" if _s["sex"] == "M" else "Female"
                race_val = _s["race"].title()
                country_val = _s["country"]
            else:
                dob = _randdate(date(1940, 1, 1), date(2000, 1, 1))
                arm_idx = random.randint(0, len(_ARM_CODES) - 1)
                arm_name = _ARMS[arm_idx]
                arm_code_val = _ARM_CODES[arm_idx]
                sex_val = random.choice(["Male", "Female"])
                race_val = random.choice(_RACES).title()
                country_val = random.choice(_COUNTRIES)
            row.update({
                "sex":          sex_val,
                "race":         race_val,
                "date_of_birth": _fmt_date(dob),
                "age":          (ref_start - dob).days // 365,
                "country":      country_val,
                "treatment_arm": arm_name,
                "arm_code":     arm_code_val,
            })
        elif dom == "CM":
            generic, brand, drug_class, routes, doses, dose_unit = random.choice(_CM_DRUG_PROFILES)
            row.update({
                "medication":   brand,
                "generic_name": generic,
                "drug_class":   drug_class,
                "dose":         str(random.choice(doses)),
                "dose_unit":    dose_unit,
                "route":        random.choice(routes),
                "frequency":    random.choice(["Daily", "Twice Daily", "As Needed"]),
                "start_date":   _fmt_date(_randdate(ref_start - timedelta(days=90), collected_date)),
                "stop_date":    _fmt_date(_randdate(collected_date, collected_date + timedelta(days=90))) if random.random() < 0.6 else "N/A",
            })
        elif dom == "LB":
            test_name, test_code, unit, lo, hi = random.choice(_LB_TESTS)
            row.update({
                "lab_test":     test_name,
                "lab_code":     test_code,
                "result":       str(round(random.uniform(lo * 0.7, hi * 1.3), 2)),
                "unit":         unit,
                "normal_low":   str(lo),
                "normal_high":  str(hi),
                "specimen":     random.choice(["BLOOD", "SERUM", "URINE"]),
            })
        elif dom == "VS":
            test_name, test_code, unit, lo, hi = random.choice(_VS_TESTS)
            row.update({
                "vs_test":      test_name,
                "vs_code":      test_code,
                "result":       str(round(random.uniform(lo * 0.9, hi * 1.1), 1)),
                "unit":         unit,
                "position":     random.choice(["SITTING", "STANDING", "SUPINE"]),
            })
        else:
            row.update({
                "field_name":   f"FIELD_{random.choice(string.ascii_uppercase)}{random.randint(1,9)}",
                "field_value":  str(random.choice([random.randint(0, 200), fake.word()])),
                "data_type":    random.choice(["TEXT", "NUMERIC", "DATE"]),
            })

        rows.append(row)
    return pd.DataFrame(rows)

def _gen_raw_edc(domain: str, n: int, study_id: str, ref_start: date, therapeutic_area: str = "", subjects: list[dict] | None = None) -> pd.DataFrame:
    """Generate raw EDC export data with domain-specific clinical columns (wide format).

    Column names mirror how real EDC systems (Medidata Rave, Oracle Clinical) name
    fields — human-readable, NOT SDTM variable names.  The SDTM mapper must do real
    semantic mapping (e.g. Gender → SEX, Patient_ID → USUBJID, Adverse_Event → AETERM).
    """
    _SYSTEM = random.choice(["MEDIDATA_RAVE", "ORACLE_CLINICAL", "VEEVA_VAULT", "DATATRAK"])
    dom = domain.upper()
    ta = _TA_PROFILES.get(therapeutic_area, _TA_DEFAULT)
    _init_col_map(dom)
    rows = []

    for i in range(1, n + 1):
        # Draw from subject pool when available — guarantees cross-domain correlation
        if subjects:
            s = subjects[(i - 1) % len(subjects)]
            site       = s["siteid"]
            subj       = s["subjid"]
            patient_id = s["usubjid"]
        else:
            site       = _site_id()
            subj       = f"{i:04d}"
            patient_id = f"{study_id}-{site}-{subj}"
        visit_dt = _randdate(ref_start, ref_start + timedelta(days=365))
        entry_dt = _randdate(visit_dt, visit_dt + timedelta(days=5))
        visit    = random.choice(_VISITS)

        # ── Common EDC admin columns — human-readable names ───────────────────
        row: dict[str, Any] = {
            _remap_col("Study_ID"):        study_id,
            _remap_col("Site_Number"):     site,
            _remap_col("Patient_ID"):      patient_id,
            _remap_col("Subject_Number"):  subj,
            _remap_col("Visit_Name"):      visit,
            _remap_col("Visit_Date"):      _fmt_date(visit_dt),
            _remap_col("Data_Entry_Date"): _fmt_date(entry_dt),
            _remap_col("Data_Entry_By"):   f"USER_{random.randint(1, 20):03d}",
            _remap_col("Record_Locked"):   random.choices(["Yes", "No"], weights=[0.9, 0.1])[0],
            _remap_col("Record_Verified"): random.choices(["Yes", "No"], weights=[0.85, 0.15])[0],
            _remap_col("Source_System"):   _SYSTEM,
        }

        # ── Domain-specific clinical columns — real-world EDC naming ──────────
        if dom == "AE":
            ae_start = _randdate(ref_start, ref_start + timedelta(days=300))
            ae_end   = _randdate(ae_start, ae_start + timedelta(days=30))
            ae_verbatim = random.choice(ta["ae_terms"])
            is_serious  = random.choices(["Yes", "No"], weights=[0.15, 0.85])[0]
            row.update({
                _remap_col("Adverse_Event"):        ae_verbatim.title(),
                _remap_col("MedDRA_Preferred_Term"): ta["ae_meddra"].get(ae_verbatim, ae_verbatim.title()),
                _remap_col("System_Organ_Class"):   ta["ae_soc"].get(ae_verbatim, "General Disorders"),
                _remap_col("Severity"):             random.choice(_AE_SEVERITY).title(),
                _remap_col("Serious_AE"):           is_serious,
                "SAE_Criteria":                     random.choice(_SAE_CRITERIA) if is_serious == "Yes" else "Not Applicable",
                _remap_col("Causality"):            random.choice(["Not Related", "Possibly Related", "Probably Related", "Related"]),
                _remap_col("Outcome"):              random.choice(_AE_OUTCOME).title(),
                _remap_col("Action_Taken"):         random.choice(["Dose Not Changed", "Dose Reduced", "Drug Withdrawn", "Not Applicable"]),
                _remap_col("AE_Start_Date"):        _fmt_date(ae_start),
                _remap_col("AE_End_Date"):          _fmt_date(ae_end),
                _remap_col("Toxicity_Grade"):       str(random.choice([1, 2, 3, 4, 5])),
                _remap_col("Concomitant_Treatment"): random.choice(["Yes", "No"]),
            })

        elif dom == "DM":
            ta_arms = ta.get("arms", _ARMS)
            ta_arm_codes = ta.get("arm_codes", _ARM_CODES)
            ta_age_range = ta.get("age_range", (18, 70))
            if subjects:
                _s = subjects[(i - 1) % len(subjects)]
                arm_code = _s["armcd"]
                arm_name = _s["arm"]
                dob      = _s["dob"]
                consent_dt = _randdate(_s["rfstdtc"] - timedelta(days=14), _s["rfstdtc"])
                rand_dt    = _randdate(consent_dt, _s["rfstdtc"] + timedelta(days=7))
                sex_str    = "Male" if _s["sex"] == "M" else "Female"
                race_str   = _s["race"].title()
                ethnic_str = _s["ethnic"].title()
                country_str = _s["country"]
            else:
                arm_idx    = random.randint(0, len(ta_arm_codes) - 1)
                arm_code   = ta_arm_codes[arm_idx]
                arm_name   = ta_arms[arm_idx]
                dob = _randdate(
                    date.today() - timedelta(days=int(ta_age_range[1] * 365.25)),
                    date.today() - timedelta(days=int(ta_age_range[0] * 365.25)),
                )
                consent_dt = _randdate(ref_start - timedelta(days=14), ref_start)
                rand_dt    = _randdate(consent_dt, ref_start + timedelta(days=7))
                sex_str    = random.choice(["Male", "Female"])
                race_str   = random.choice(_RACES).title()
                ethnic_str = random.choice(_ETHNICS).title()
                country_str = random.choice(_COUNTRIES)
            row.update({
                _remap_col("Visit_Name"):            random.choice(["SCREENING", "BASELINE"]),
                _remap_col("Visit_Date"):            _fmt_date(consent_dt),
                _remap_col("Patient_Initials"):      fake.lexify("???").upper(),
                _remap_col("Gender"):                sex_str,
                _remap_col("Race"):                  race_str,
                _remap_col("Ethnicity"):             ethnic_str,
                _remap_col("Age_at_Enrollment"):     (ref_start - dob).days // 365,
                _remap_col("Age_Units"):             "Years",
                _remap_col("Country_of_Birth"):      country_str,
                _remap_col("Date_of_Birth"):         _fmt_date(dob),
                _remap_col("Informed_Consent_Date"): _fmt_date(consent_dt),
                _remap_col("Randomization_Number"):  f"RAND-{random.randint(1000, 9999)}",
                _remap_col("Randomization_Date"):    _fmt_date(rand_dt),
                _remap_col("Treatment_Group"):       arm_name,
                _remap_col("Arm_Code"):              arm_code,
                _remap_col("Study_Start_Date"):      _fmt_date(ref_start),
                _remap_col("Study_End_Date"):        _fmt_date(ref_start + timedelta(days=random.randint(84, 365))),
                _remap_col("Death_Flag"):            random.choices(["Yes", "No"], weights=[0.02, 0.98])[0],
                _remap_col("Date_of_Death"):         _fmt_date(_randdate(ref_start, ref_start + timedelta(days=365))) if random.random() < 0.02 else "N/A",
            })

        elif dom == "CM":
            cm_start = _randdate(ref_start - timedelta(days=90), ref_start + timedelta(days=200))
            cm_end   = _randdate(cm_start, cm_start + timedelta(days=90)) if random.random() < 0.6 else None
            generic, brand, drug_class, routes, doses, dose_unit = random.choice(ta["cm_drugs"])
            row.update({
                _remap_col("Drug_Name"):          brand,
                _remap_col("Generic_Name"):       generic,
                _remap_col("Medication_Category"): random.choice(["Prior", "Concomitant"]),
                _remap_col("Drug_Class"):         drug_class,
                _remap_col("Dose"):               str(random.choice(doses)),
                _remap_col("Dose_Unit"):          dose_unit,
                _remap_col("Frequency"):          random.choice(["Once Daily", "Twice Daily", "Three Times Daily", "As Needed"]),
                _remap_col("Route_of_Admin"):     random.choice(routes),
                _remap_col("Medication_Start"):   _fmt_date(cm_start),
                _remap_col("Medication_Stop"):    _fmt_date(cm_end) if cm_end else "N/A",
                _remap_col("Still_Taking"):       "No" if cm_end else "Yes",
                _remap_col("Indication"):         random.choice(["Pain", "Hypertension", "Diabetes", "Dyslipidaemia", "Prophylaxis", "Nausea", "Other"]),
            })

        elif dom == "LB":
            test_name, test_code, unit, lo, hi = random.choice(ta["lb_tests"])
            result = round(random.uniform(lo * 0.7, hi * 1.3), 2)
            row.update({
                _remap_col("Lab_Test_Name"):   test_name,
                _remap_col("Lab_Test_Code"):   test_code,
                _remap_col("Lab_Category"):    random.choice(["Chemistry", "Hematology", "Urinalysis"]),
                _remap_col("Result_Value"):    str(result),
                _remap_col("Result_Unit"):     unit,
                _remap_col("Normal_Range_Lo"): str(round(lo, 2)),
                _remap_col("Normal_Range_Hi"): str(round(hi, 2)),
                _remap_col("Abnormality_Flag"): "Low" if result < lo else ("High" if result > hi else "Normal"),
                _remap_col("Sample_Date"):     _fmt_date(visit_dt),
                _remap_col("Specimen_Type"):   random.choice(["Blood", "Serum", "Urine"]),
            })

        elif dom == "VS":
            test_name, test_code, unit, lo, hi = random.choice(_VS_TESTS)
            result = round(random.uniform(lo * 0.9, hi * 1.1), 1)
            row.update({
                _remap_col("Vital_Sign"):        test_name,
                _remap_col("Measurement_Code"):  test_code,
                _remap_col("Measured_Value"):    str(result),
                _remap_col("Measurement_Unit"):  unit,
                _remap_col("Normal_Low"):        str(lo),
                _remap_col("Normal_High"):       str(hi),
                _remap_col("Measurement_Date"):  _fmt_date(visit_dt),
                _remap_col("Patient_Position"):  random.choice(["Sitting", "Standing", "Supine"]),
                _remap_col("Body_Location"):     random.choice(["Left Arm", "Right Arm", ""]),
            })

        elif dom == "EX":
            ex_start = _randdate(ref_start, ref_start + timedelta(days=300))
            ex_end   = _randdate(ex_start, ex_start + timedelta(days=14))
            ta_arms = ta.get("arms", _ARMS)
            row.update({
                _remap_col("Investigational_Drug"): random.choice(ta_arms),
                _remap_col("Dose_Administered"):    str(random.choice([25, 50, 100, 200])),
                _remap_col("Dose_Unit"):            "mg",
                _remap_col("Dosage_Form"):          random.choice(["Tablet", "Capsule", "Injection", "Solution"]),
                _remap_col("Dosing_Frequency"):     random.choice(["Once Daily", "Twice Daily", "Single Dose"]),
                _remap_col("Route"):                random.choice(["Oral", "Intravenous", "Subcutaneous"]),
                _remap_col("Treatment_Start_Date"): _fmt_date(ex_start),
                _remap_col("Treatment_End_Date"):   _fmt_date(ex_end),
                _remap_col("Lot_Number"):           f"LOT{random.randint(1000, 9999)}",
                _remap_col("Study_Epoch"):          random.choice(["Treatment", "Follow-Up"]),
            })

        elif dom == "MH":
            mh_start = _randdate(date(2010, 1, 1), ref_start - timedelta(days=30))
            row.update({
                _remap_col("Medical_Condition"):    random.choice(ta["mh_terms"]),
                _remap_col("Coded_Diagnosis"):      random.choice(ta["mh_terms"]),
                _remap_col("History_Category"):     "Medical History",
                _remap_col("Body_System"):          random.choice(["Cardiac", "Metabolic", "Respiratory", "Neurological", "Other"]),
                _remap_col("Pre_Specified"):        random.choice(["Yes", "No"]),
                _remap_col("Condition_Present"):    random.choice(["Yes", "No", "Unknown"]),
                _remap_col("Condition_Start_Date"): _fmt_date(mh_start),
                _remap_col("Condition_End_Date"):   _fmt_date(_randdate(mh_start, ref_start)) if random.random() < 0.4 else "",
                _remap_col("Ongoing"):              random.choice(["Yes", "No"]),
            })

        elif dom == "DS":
            ds_date = _randdate(ref_start, ref_start + timedelta(days=400))
            row.update({
                _remap_col("Disposition_Status"):  random.choice(_DS_DSCODES),
                _remap_col("Reason_for_Stopping"): random.choice(_DS_DSCODES),
                _remap_col("Disposition_Category"): random.choice(["Disposition Event", "Protocol Milestone"]),
                _remap_col("Subcategory"):          random.choice(["Study Completion", "Early Termination", "Randomisation"]),
                _remap_col("Disposition_Date"):     _fmt_date(ds_date),
                _remap_col("Study_Phase"):          random.choice(["Screening", "Treatment", "Follow-Up"]),
            })

        elif dom == "SV":
            sv_start = _randdate(ref_start, ref_start + timedelta(days=300))
            sv_end   = _randdate(sv_start, sv_start + timedelta(days=3))
            row.update({
                _remap_col("Visit_Start_Date"):  _fmt_date(sv_start),
                _remap_col("Visit_End_Date"):    _fmt_date(sv_end),
                _remap_col("Unplanned_Visit_Desc"): f"Unplanned visit {random.randint(1,10)}" if random.random() < 0.1 else "",
                _remap_col("Study_Phase"):       random.choice(["Screening", "Treatment", "Follow-Up"]),
            })

        else:
            row.update({
                "Field_Name":  f"{dom}_Field_{random.choice(string.ascii_uppercase)}{random.randint(1,99)}",
                "Field_Value": str(random.choice([random.randint(0, 500), fake.word(), fake.name()])),
                "Unit":        random.choice(["mg", "mL", "%", "days", ""]),
            })

        rows.append(row)

    return pd.DataFrame(rows)

# ─── Domain dispatch tables ───────────────────────────────────────────────────

SDTM_GENERATORS = {
    "DM": _gen_dm,
    "AE": _gen_ae,
    "LB": _gen_lb,
    "VS": _gen_vs,
    "CM": _gen_cm,
    "EX": _gen_ex,
    "MH": _gen_mh,
    "DS": _gen_ds,
    "SV": _gen_sv,
    "IE": _gen_ie,
    "QS": _gen_qs,
    "PE": _gen_pe,
    "SC": _gen_sc,
    "CO": _gen_co,
    "PC": _gen_pc,
    "PR": _gen_pr,
    "RS": _gen_rs,
    "IS": _gen_is,
    "FA": _gen_fa,
    "HO": _gen_ho,
    "TU": _gen_tu,
}

ADAM_GENERATORS = {
    "ADSL": _gen_adsl,
    "ADAE": _gen_adae,
    "ADLB": _gen_adlb,
    "ADVS": _gen_advs,
    "ADCM": _gen_adcm,
    "ADTTE": _gen_adtte,
    "ADEX": _gen_adex,
    "ADMH": _gen_admh,
    "ADPP": _gen_adpp,
    "ADRS": _gen_adrs,
}

SDTM_DOMAINS = list(SDTM_GENERATORS.keys())
ADAM_DOMAINS = list(ADAM_GENERATORS.keys())
CRF_FORMS = ["AE", "DM", "CM", "LB", "VS", "MH", "DS", "EX", "SV", "QS", "PE", "SC"]
EDC_FORMS = CRF_FORMS
PROTOCOL_SECTIONS = ["TITLE", "OBJECTIVES", "DESIGN", "POPULATION", "ENDPOINTS",
                     "PROCEDURES", "STATISTICS", "SAFETY", "REFERENCES"]

# ─── Data generation entry point ─────────────────────────────────────────────

def _build_domain_dfs(
    data_type: str,
    sub_domains: list[str],
    num_rows: int,
    add_anomalies: bool,
    study_id: str,
    ref_start: date,
    therapeutic_area: str = "",
) -> dict[str, pd.DataFrame]:
    """Return {domain_name: DataFrame} for the requested configuration."""
    dfs: dict[str, pd.DataFrame] = {}

    if data_type == "SDTM":
        domains = [d for d in sub_domains if d in SDTM_GENERATORS] or SDTM_DOMAINS[:3]
        rows_per = max(1, num_rows // len(domains))
        ta = _TA_PROFILES.get(therapeutic_area, _TA_DEFAULT)
        # Build ONE consistent subject pool — ensures USUBJID/SITEID/ARM match
        # across every domain in this generation call.
        n_subjects = max(5, min(rows_per, 500))
        subj_pool = _build_subject_pool(n_subjects, study_id, ref_start, ta)
        # Always materialise DM (even when not explicitly requested) so every
        # other generator has a concrete subject roster to reference.
        dm_df = _gen_dm(n_subjects, study_id, ref_start, subjects=subj_pool)
        if "DM" in domains:
            dfs["DM"] = _add_anomalies_to_df(dm_df) if add_anomalies else dm_df
        for domain in [d for d in domains if d != "DM"]:
            df = _call_gen(SDTM_GENERATORS[domain], rows_per, study_id, dm_df, ref_start)
            if add_anomalies:
                df = _add_anomalies_to_df(df)
            dfs[domain] = df

    elif data_type == "ADaM":
        domains = [d for d in sub_domains if d in ADAM_GENERATORS] or ADAM_DOMAINS[:3]
        rows_per = max(1, num_rows // len(domains))
        ta = _TA_PROFILES.get(therapeutic_area, _TA_DEFAULT)
        n_subjects = max(5, min(rows_per, 500))
        subj_pool = _build_subject_pool(n_subjects, study_id, ref_start, ta)
        # Always materialise ADSL as the subject anchor for all ADaM datasets.
        adsl_df = _gen_adsl(n_subjects, study_id, ref_start, subjects=subj_pool)
        if "ADSL" in domains:
            dfs["ADSL"] = _add_anomalies_to_df(adsl_df) if add_anomalies else adsl_df
        for domain in [d for d in domains if d != "ADSL"]:
            df = _call_gen(ADAM_GENERATORS[domain], rows_per, study_id, adsl_df, ref_start)
            if add_anomalies:
                df = _add_anomalies_to_df(df)
            dfs[domain] = df

    elif data_type == "CRF":
        forms = [f for f in sub_domains if f in CRF_FORMS] or CRF_FORMS[:3]
        rows_per = max(1, num_rows // len(forms))
        ta = _TA_PROFILES.get(therapeutic_area, _TA_DEFAULT)
        subj_pool = _build_subject_pool(max(5, min(rows_per, 500)), study_id, ref_start, ta)
        for form in forms:
            df = _gen_crf(form, rows_per, study_id, ref_start, subjects=subj_pool)
            if add_anomalies:
                df = _add_anomalies_to_df(df)
            dfs[form] = df

    elif data_type == "RawEDC":
        forms = [f for f in sub_domains if f in EDC_FORMS] or EDC_FORMS[:3]
        rows_per = max(1, num_rows // len(forms))
        ta = _TA_PROFILES.get(therapeutic_area, _TA_DEFAULT)
        subj_pool = _build_subject_pool(max(5, min(rows_per, 500)), study_id, ref_start, ta)
        for form in forms:
            df = _gen_raw_edc(form, rows_per, study_id, ref_start, therapeutic_area, subjects=subj_pool)
            if add_anomalies:
                df = _add_anomalies_to_df(df)
            dfs[form] = df

    elif data_type in ("Protocol", "TLF"):
        # Protocol/TLF: metadata table only, no rows concept
        sections = sub_domains or PROTOCOL_SECTIONS[:5]
        rows_data = []
        for sec in sections:
            rows_data.append({
                "SECTION": sec, "TITLE": sec.replace("_", " ").title(),
                "CONTENT_SUMMARY": fake.paragraph(nb_sentences=3),
                "VERSION": "1.0", "AUTHOR": fake.name(),
                "APPROVED_DATE": _fmt_date(ref_start - timedelta(days=30)),
                "STATUS": "FINAL",
            })
        dfs["PROTOCOL"] = pd.DataFrame(rows_data)

    return dfs


# ─── Format serialisers ───────────────────────────────────────────────────────

def _to_csv_zip(dfs: dict[str, pd.DataFrame]) -> tuple[bytes, str, str]:
    """Return (bytes, filename, mimetype) for a ZIP of CSV files."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, df in dfs.items():
            csv_bytes = df.to_csv(index=False).encode("utf-8")
            zf.writestr(f"{name}.csv", csv_bytes)
    return buf.getvalue(), "data.zip", "application/zip"


def _to_xls(dfs: dict[str, pd.DataFrame]) -> tuple[bytes, str, str]:
    """Return Excel workbook with one sheet per domain."""
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        for name, df in dfs.items():
            # Excel max 1M rows
            df_slice = df.iloc[:1_048_576]
            df_slice.to_excel(writer, sheet_name=name[:31], index=False)
    return buf.getvalue(), "data.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _to_xpt_zip(dfs: dict[str, pd.DataFrame]) -> tuple[bytes, str, str]:
    """Return ZIP of SAS transport (XPT v5) files using pyreadstat."""
    import pyreadstat  # lazy import

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, df in dfs.items():
            xpt_buf = io.BytesIO()
            # Convert all object columns to string, numeric stays numeric
            df_xpt = df.copy()
            for col in df_xpt.select_dtypes(include=["object"]).columns:
                df_xpt[col] = df_xpt[col].fillna("").astype(str)
            for col in df_xpt.select_dtypes(include=["float", "int"]).columns:
                df_xpt[col] = pd.to_numeric(df_xpt[col], errors="coerce").fillna(0)
            # Truncate column names to 8 chars (SAS requirement)
            df_xpt.columns = [c[:8] for c in df_xpt.columns]
            # pyreadstat needs a file path; write to temp bytes via StringIO workaround
            import tempfile, os
            with tempfile.NamedTemporaryFile(suffix=".xpt", delete=False) as tmp:
                tmp_path = tmp.name
            try:
                pyreadstat.write_xport(df_xpt, tmp_path, file_label=name[:40])
                with open(tmp_path, "rb") as f:
                    zf.writestr(f"{name.lower()}.xpt", f.read())
            finally:
                os.unlink(tmp_path)
    return buf.getvalue(), "data_xpt.zip", "application/zip"


def _to_pdf(dfs: dict[str, pd.DataFrame], data_type: str, study_id: str) -> tuple[bytes, str, str]:
    """Return a regulatory-style PDF listing with summary tables."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4),
                            leftMargin=1.5*cm, rightMargin=1.5*cm,
                            topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()
    story = []

    # Cover section
    story.append(Paragraph(f"<b>{data_type} Test Data Report</b>", styles["Title"]))
    story.append(Paragraph(f"Study: {study_id} | Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} UTC", styles["Normal"]))
    story.append(Spacer(1, 0.5*cm))

    for domain, df in dfs.items():
        story.append(Paragraph(f"<b>Domain / Dataset: {domain}</b>  ({len(df)} records)", styles["Heading2"]))
        story.append(Spacer(1, 0.2*cm))

        # Summary stats
        n_cols = len(df.columns)
        n_rows = len(df)
        n_missing = int(df.isnull().sum().sum())
        story.append(Paragraph(
            f"Columns: {n_cols} | Rows: {n_rows} | Missing cells: {n_missing}",
            styles["Normal"]
        ))
        story.append(Spacer(1, 0.3*cm))

        # First 30 rows preview
        preview = df.head(30)
        # Limit columns to fit on page
        max_cols = 10
        if len(preview.columns) > max_cols:
            preview = preview.iloc[:, :max_cols]
            story.append(Paragraph(f"<i>(Showing first {max_cols} of {n_cols} columns)</i>", styles["Italic"]))

        table_data = [list(preview.columns)] + [
            [str(v)[:20] if v is not None else "" for v in row]
            for row in preview.values.tolist()
        ]
        col_w = [(landscape(A4)[0] - 3*cm) / len(preview.columns)] * len(preview.columns)
        tbl = Table(table_data, colWidths=col_w, repeatRows=1)
        tbl.setStyle(TableStyle([
            ("BACKGROUND",    (0, 0), (-1, 0), colors.HexColor("#4F46E5")),
            ("TEXTCOLOR",     (0, 0), (-1, 0), colors.white),
            ("FONTNAME",      (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE",      (0, 0), (-1, -1), 7),
            ("ROWBACKGROUNDS",(0, 1), (-1, -1), [colors.white, colors.HexColor("#F1F5F9")]),
            ("GRID",          (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
            ("VALIGN",        (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING",   (0, 0), (-1, -1), 3),
            ("RIGHTPADDING",  (0, 0), (-1, -1), 3),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 0.6*cm))

    doc.build(story)
    return buf.getvalue(), "data_report.pdf", "application/pdf"


# ─── Public API ───────────────────────────────────────────────────────────────

def generate(
    data_type: str,
    sub_domains: list[str],
    output_format: str,
    num_rows: int,
    add_anomalies: bool,
    study_id: str = "STUDY-001",
    therapeutic_area: str = "",
) -> tuple[bytes, str, str]:
    """
    Generate synthetic clinical data.

    Returns (file_bytes, filename, mime_type).
    """
    ref_start = date(2024, 1, 1)
    dfs = _build_domain_dfs(data_type, sub_domains, num_rows, add_anomalies, study_id, ref_start, therapeutic_area)

    if not dfs:
        raise ValueError(f"No data generated for data_type={data_type}, sub_domains={sub_domains}")

    fmt = output_format.upper()
    if fmt == "CSV":
        return _to_csv_zip(dfs)
    elif fmt == "XLS":
        return _to_xls(dfs)
    elif fmt == "XPT":
        return _to_xpt_zip(dfs)
    elif fmt == "PDF":
        return _to_pdf(dfs, data_type, study_id)
    else:
        raise ValueError(f"Unsupported output_format: {output_format}")
