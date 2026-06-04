-- Clinical pathway database schema and seed data.
-- Source document: /home/buma/Downloads/clinical_guidelines_institutional.pdf
-- Generated for PostgreSQL. Run inside the Postgres container/database used by n8n,
-- or in a separate clinical database.

BEGIN;

CREATE SCHEMA IF NOT EXISTS clinical;
SET search_path TO clinical, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS pathway_action_medications CASCADE;
DROP TABLE IF EXISTS pathway_actions CASCADE;
DROP TABLE IF EXISTS pathway_investigations CASCADE;
DROP TABLE IF EXISTS pathway_edges CASCADE;
DROP TABLE IF EXISTS pathway_nodes CASCADE;
DROP TABLE IF EXISTS clinical_context_state CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_sessions CASCADE;
DROP TABLE IF EXISTS medications CASCADE;
DROP TABLE IF EXISTS investigations CASCADE;
DROP TABLE IF EXISTS conditions CASCADE;
DROP TABLE IF EXISTS source_documents CASCADE;

CREATE TABLE source_documents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  edition TEXT,
  source_file TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conditions (
  id BIGSERIAL PRIMARY KEY,
  source_document_id BIGINT REFERENCES source_documents(id) ON DELETE CASCADE,
  condition_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT,
  display_order INTEGER NOT NULL,
  synonyms TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pathway_nodes (
  id BIGSERIAL PRIMARY KEY,
  condition_id BIGINT NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL UNIQUE,
  parent_node_id BIGINT REFERENCES pathway_nodes(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'terminal',
  display_order INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'routine',
  disposition TEXT,
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_facts TEXT[] NOT NULL DEFAULT '{}',
  missing_fact_question TEXT,
  summary TEXT NOT NULL,
  management_text TEXT NOT NULL,
  source_section TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (node_type IN ('decision', 'terminal', 'protocol', 'appendix')),
  CHECK (severity IN ('routine', 'urgent', 'emergency', 'critical'))
);

CREATE TABLE pathway_edges (
  id BIGSERIAL PRIMARY KEY,
  from_node_id BIGINT NOT NULL REFERENCES pathway_nodes(id) ON DELETE CASCADE,
  to_node_id BIGINT NOT NULL REFERENCES pathway_nodes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  rule JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE investigations (
  id BIGSERIAL PRIMARY KEY,
  investigation_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  result_type TEXT
);

CREATE TABLE pathway_investigations (
  id BIGSERIAL PRIMARY KEY,
  pathway_node_id BIGINT NOT NULL REFERENCES pathway_nodes(id) ON DELETE CASCADE,
  investigation_id BIGINT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  timing TEXT NOT NULL DEFAULT 'initial',
  notes TEXT,
  UNIQUE (pathway_node_id, investigation_id, timing)
);

CREATE TABLE medications (
  id BIGSERIAL PRIMARY KEY,
  medication_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE pathway_actions (
  id BIGSERIAL PRIMARY KEY,
  pathway_node_id BIGINT NOT NULL REFERENCES pathway_nodes(id) ON DELETE CASCADE,
  action_order INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  action_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE pathway_action_medications (
  id BIGSERIAL PRIMARY KEY,
  pathway_action_id BIGINT NOT NULL REFERENCES pathway_actions(id) ON DELETE CASCADE,
  medication_id BIGINT NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  dose_text TEXT,
  route TEXT,
  frequency_text TEXT,
  duration_text TEXT,
  notes TEXT
);

CREATE TABLE chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clinical_context_state (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  latest_condition_key TEXT REFERENCES conditions(condition_key) ON DELETE SET NULL,
  selected_node_id BIGINT REFERENCES pathway_nodes(id) ON DELETE SET NULL,
  selected_node_key TEXT,
  known_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_facts TEXT[] NOT NULL DEFAULT '{}',
  last_assistant_output TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conditions_title_trgm ON conditions USING gin (title gin_trgm_ops);
CREATE INDEX idx_conditions_synonyms ON conditions USING gin (synonyms);
CREATE INDEX idx_nodes_criteria ON pathway_nodes USING gin (criteria);
CREATE INDEX idx_nodes_required_facts ON pathway_nodes USING gin (required_facts);
CREATE INDEX idx_nodes_summary_trgm ON pathway_nodes USING gin (summary gin_trgm_ops);
CREATE INDEX idx_nodes_management_trgm ON pathway_nodes USING gin (management_text gin_trgm_ops);
CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_context_state_session_id ON clinical_context_state(session_id);
CREATE INDEX idx_context_state_known_facts ON clinical_context_state USING gin (known_facts);

INSERT INTO source_documents (id, title, edition, source_file)
VALUES (1, 'Clinical Management Guidelines', 'Institutional Edition', '/home/buma/Downloads/clinical_guidelines_institutional.pdf');

INSERT INTO conditions (source_document_id, condition_key, title, category, display_order, synonyms) VALUES
(1, 'pv_bleeding', 'Per Vaginal Bleeding', 'obstetrics_gynaecology', 1, ARRAY['per vaginal bleeding','pv bleeding','vaginal bleeding','abnormal uterine bleeding','antepartum haemorrhage']),
(1, 'acute_fever', 'Hotness of Body (Acute Fever Syndromes)', 'infectious_disease', 2, ARRAY['fever','hotness of body','pyrexia','febrile illness']),
(1, 'bp_pregnancy', 'Elevated Blood Pressure in Pregnancy', 'obstetrics_gynaecology', 3, ARRAY['hypertension in pregnancy','pre-eclampsia','preeclampsia','gestational hypertension']),
(1, 'head_injury', 'Head Injury', 'trauma', 4, ARRAY['head trauma','traumatic brain injury','tbi']),
(1, 'abdominal_injury', 'Abdominal Injury', 'trauma', 5, ARRAY['abdominal trauma','blunt abdominal injury','penetrating abdominal injury']),
(1, 'chest_trauma', 'Chest Trauma', 'trauma', 6, ARRAY['thoracic trauma','chest injury','pneumothorax','haemothorax']),
(1, 'epigastric_pain', 'Epigastric Pain', 'gastroenterology', 7, ARRAY['upper abdominal pain','gastritis','peptic ulcer disease','upper gi bleed']),
(1, 'asthma_attack', 'Wheeze and Difficulty Breathing (Asthmatic Attack)', 'respiratory', 8, ARRAY['wheeze','asthma','asthmatic attack','difficulty breathing']),
(1, 'burns', 'Burns', 'trauma', 9, ARRAY['burn injury','thermal burn','chemical burn','electrical burn']),
(1, 'hyperkalaemia', 'Hyperkalaemia Management', 'electrolytes', 10, ARRAY['high potassium','hyperkalemia']),
(1, 'dka', 'Diabetic Ketoacidosis Management', 'endocrinology', 12, ARRAY['dka','diabetic ketoacidosis','ketones','kussmaul breathing']),
(1, 'paediatric_fluids', 'Fluid Management in Neonates and Children', 'paediatrics', 13, ARRAY['dehydration','ors','plan a','plan b','plan c','neonate fluids']),
(1, 'hypernatraemia', 'Hypernatraemia Treatment', 'electrolytes', 14, ARRAY['high sodium','hypernatremia']),
(1, 'hyponatraemia', 'Hyponatraemia Treatment', 'electrolytes', 15, ARRAY['low sodium','hyponatremia']),
(1, 'pph_risk', 'High-Risk Obstetric Conditions (Postpartum Haemorrhage Risk Assessment)', 'obstetrics_gynaecology', 16, ARRAY['postpartum haemorrhage','pph','obstetric bleeding']);

INSERT INTO investigations (investigation_key, name, aliases, result_type) VALUES
('cbc', 'Complete blood count', ARRAY['fbc','full blood count','blood count'], 'panel'),
('crossmatch', 'Grouping and cross-match', ARRAY['group and crossmatch','blood grouping'], 'panel'),
('pelvic_ultrasound', 'Pelvic ultrasound', ARRAY['pelvic us','gynaecological ultrasound'], 'imaging'),
('obstetric_ultrasound', 'Obstetric ultrasound', ARRAY['obstetric scan','pregnancy ultrasound'], 'imaging'),
('coagulation_profile', 'Coagulation profile', ARRAY['coags','pt','aptt','inr'], 'panel'),
('peripheral_blood_film', 'Peripheral blood film', ARRAY['blood film','pbf'], 'microscopy'),
('malaria_antigen', 'Malaria antigen test', ARRAY['mrdt','malaria test'], 'binary'),
('renal_function', 'Renal function tests', ARRAY['rft','urea and electrolytes','creatinine'], 'panel'),
('liver_function', 'Liver function tests', ARRAY['lft'], 'panel'),
('random_blood_sugar', 'Random blood sugar', ARRAY['rbs','blood glucose'], 'numeric'),
('lumbar_puncture', 'Lumbar puncture', ARRAY['lp','csf'], 'procedure'),
('urinalysis', 'Urinalysis', ARRAY['urine dipstick','urine test'], 'panel'),
('fast_ultrasound', 'FAST ultrasound', ARRAY['focused assessment with sonography in trauma','fast scan'], 'imaging'),
('chest_xray', 'Chest x-ray', ARRAY['cxr'], 'imaging'),
('ct_head', 'CT scan of the head', ARRAY['head ct','ct brain'], 'imaging'),
('h_pylori_antigen', 'Helicobacter pylori antigen test', ARRAY['h pylori','hpylori'], 'binary'),
('blood_gas', 'Blood gas analysis', ARRAY['abg','vbg'], 'panel'),
('electrolytes', 'Electrolytes', ARRAY['sodium','potassium','chloride'], 'panel'),
('ecg', 'Electrocardiogram', ARRAY['ekg'], 'tracing'),
('renal_doppler_ultrasound', 'Renal Doppler ultrasound', ARRAY['renal doppler','doppler ultrasound of the renals'], 'imaging'),
('echocardiogram', 'Echocardiogram', ARRAY['echo'], 'imaging'),
('kub_ultrasound', 'KUB ultrasound', ARRAY['kidney ureter bladder ultrasound'], 'imaging'),
('urine_catecholamine_metabolites_24h', '24-hour urine catecholamine metabolite testing', ARRAY['24-hour urine vma','vanillylmandelic acid','metanephrines','unconjugated catecholamines'], 'panel'),
('urine_ketones', 'Urine ketones', ARRAY['ketones in urine','urine ketone test'], 'semiquantitative'),
('serum_bicarbonate', 'Serum bicarbonate', ARRAY['bicarbonate','hco3'], 'numeric'),
('serial_weight', 'Serial weight monitoring', ARRAY['hourly weighing','weigh hourly'], 'numeric'),
('volume_status_assessment', 'Volume status assessment', ARRAY['jvp','pedal oedema','sacral oedema','volume status'], 'clinical_assessment');

INSERT INTO medications (medication_key, name, aliases) VALUES
('tranexamic_acid', 'Tranexamic acid', ARRAY['txa']),
('ceftriaxone', 'Ceftriaxone', ARRAY[]::TEXT[]),
('metronidazole', 'Metronidazole', ARRAY[]::TEXT[]),
('cefuroxime', 'Cefuroxime', ARRAY[]::TEXT[]),
('paracetamol', 'Paracetamol', ARRAY['acetaminophen']),
('amoxicillin_clavulanate', 'Amoxicillin/clavulanate', ARRAY['augmentin','amoxclav']),
('artemether_lumefantrine', 'Artemether/lumefantrine', ARRAY['al']),
('artesunate', 'Artesunate', ARRAY[]::TEXT[]),
('ranferon', 'Ranferon', ARRAY[]::TEXT[]),
('midazolam', 'Midazolam', ARRAY[]::TEXT[]),
('dextrose_10', '10% dextrose', ARRAY['d10']),
('ciprofloxacin', 'Ciprofloxacin', ARRAY[]::TEXT[]),
('hydralazine', 'Hydralazine', ARRAY[]::TEXT[]),
('magnesium_sulphate', 'Magnesium sulphate', ARRAY['magnesium sulfate','mgso4']),
('methyldopa', 'Methyldopa', ARRAY[]::TEXT[]),
('phenytoin', 'Phenytoin', ARRAY[]::TEXT[]),
('tetanus_toxoid', 'Tetanus toxoid', ARRAY['tt']),
('clarithromycin', 'Clarithromycin', ARRAY[]::TEXT[]),
('ranitidine', 'Ranitidine', ARRAY[]::TEXT[]),
('esomeprazole', 'Esomeprazole', ARRAY[]::TEXT[]),
('salbutamol', 'Salbutamol', ARRAY['albuterol']),
('prednisolone', 'Prednisolone', ARRAY[]::TEXT[]),
('ipratropium', 'Ipratropium', ARRAY[]::TEXT[]),
('hydrocortisone', 'Hydrocortisone', ARRAY[]::TEXT[]),
('flucloxacillin', 'Flucloxacillin', ARRAY[]::TEXT[]),
('silver_sulfadiazine', 'Silver sulfadiazine cream', ARRAY[]::TEXT[]),
('pethidine', 'Pethidine', ARRAY[]::TEXT[]),
('omeprazole', 'Omeprazole', ARRAY[]::TEXT[]),
('calcium_polystyrene', 'Sodium or calcium polystyrene sulphonate', ARRAY['cation exchange resin']),
('calcium_gluconate', '10% calcium gluconate', ARRAY[]::TEXT[]),
('sodium_bicarbonate', 'Sodium bicarbonate', ARRAY[]::TEXT[]),
('insulin_soluble', 'Soluble insulin', ARRAY['regular insulin']),
('mannitol', 'Mannitol', ARRAY[]::TEXT[]),
('zinc_sulphate', 'Zinc sulphate', ARRAY['zinc sulfate']),
('hypertonic_saline_3', '3% hypertonic saline', ARRAY[]::TEXT[]);

INSERT INTO pathway_nodes (
  condition_id, node_key, title, node_type, display_order, severity, disposition,
  criteria, required_facts, missing_fact_question, summary, management_text, source_section
)
SELECT c.id, v.node_key, v.title, v.node_type, v.display_order, v.severity, v.disposition,
       v.criteria::jsonb, v.required_facts, v.missing_fact_question, v.summary, v.management_text, v.source_section
FROM conditions c
JOIN (
  VALUES
  ('pv_bleeding','pvb_non_pregnant_shock','Non-pregnant patient with signs of shock','terminal',101,'critical','admit',
   '{"pregnant":false,"shock":true,"symptoms":["per vaginal bleeding"],"investigations":{"cbc":["normal","granulocytosis","thrombocytopenia","haemoglobin_below_10"]}}',
   ARRAY['pregnancy_status','shock_status'],'Is the patient pregnant and are there signs of shock?',
   'Abnormal uterine bleeding complicated by hypovolaemic shock.',
   'Use ABC stabilisation immediately. Secure IV access, start fluid resuscitation, send CBC and cross-match, and arrange pelvic ultrasound. If CBC is normal, continue resuscitation and evaluate structural or endocrine causes. If granulocytosis is present, consider infection and add liver function tests. If thrombocytopenia is present, investigate coagulopathy with coagulation profile and peripheral blood film. If haemoglobin is below 10 g/dL, manage anaemia with bleeding and consider transfusion depending on stability. Admit all unstable patients for gynaecological review. Treat with IV tranexamic acid 1 g three times daily, IV ceftriaxone 50 mg/kg, and IV metronidazole 7.5 mg/kg.',
   '1.1'),
  ('pv_bleeding','pvb_pregnant_under_20w_shock','Pregnant patient less than 20 weeks with signs of shock','terminal',102,'critical','admit',
   '{"pregnant":true,"gestation_weeks":{"lt":20},"shock":true,"symptoms":["per vaginal bleeding"]}',
   ARRAY['gestation_weeks','shock_status'],'How many weeks pregnant is the patient and are there signs of shock?',
   'Abortion complicated by haemodynamic instability.',
   'Manage with immediate ABC resuscitation. Use obstetric ultrasound to guide intervention. Actively assess infection, coagulopathy, and anaemia and treat accordingly. Admit for gynaecological review. Give IV tranexamic acid, ceftriaxone, and metronidazole as in the bleeding shock pathway.',
   '1.2'),
  ('pv_bleeding','pvb_pregnant_over_20w_shock','Pregnant patient more than 20 weeks with signs of shock','terminal',103,'critical','admit',
   '{"pregnant":true,"gestation_weeks":{"gt":20},"shock":true,"symptoms":["per vaginal bleeding"]}',
   ARRAY['gestation_weeks','shock_status'],'How many weeks pregnant is the patient and are there signs of shock?',
   'Antepartum haemorrhage until proven otherwise.',
   'Prioritise maternal stabilisation, then urgent obstetric assessment and ultrasound evaluation. Identify coagulopathy, anaemia, and infection early. Admit for gynaecological review. Give IV tranexamic acid, ceftriaxone, and metronidazole as above.',
   '1.3'),
  ('pv_bleeding','pvb_stable_active_bleeding','Haemodynamically stable with active bleeding','terminal',104,'urgent','admit',
   '{"shock":false,"active_bleeding":true,"symptoms":["per vaginal bleeding"]}',
   ARRAY['shock_status','active_bleeding'],'Is the patient stable, and is bleeding ongoing?',
   'Stable patient with ongoing PV bleeding.',
   'Admit for specialist review. Treat with IV tranexamic acid, ceftriaxone, and metronidazole. Persistent blood count abnormalities such as anaemia or thrombocytopenia should prompt admission.',
   '1.4'),
  ('pv_bleeding','pvb_stable_resolved_bleeding','Haemodynamically stable with resolved bleeding','terminal',105,'routine','outpatient',
   '{"shock":false,"active_bleeding":false,"symptoms":["per vaginal bleeding"]}',
   ARRAY['shock_status','active_bleeding'],'Is bleeding ongoing or has it resolved?',
   'Stable patient after bleeding has resolved.',
   'Outpatient management may be appropriate. Prescribe oral tranexamic acid 1 g three times daily, oral cefuroxime 50 mg/kg, and oral metronidazole 7.5 mg/kg. Arrange follow-up in the general outpatient clinic. Admit if anaemia, thrombocytopenia, or other persistent blood count abnormality is present.',
   '1.4'),

  ('acute_fever','fever_no_danger_malaria_negative_normal_cbc','Fever without danger signs: normal CBC and malaria negative','terminal',201,'routine','outpatient',
   '{"duration_days":{"lt":7},"danger_signs":false,"neurological_symptoms":false,"malaria":"negative","cbc":"normal"}',
   ARRAY['danger_signs','neurological_symptoms','malaria_result','cbc_result'],'Are there danger signs or neurological symptoms, and what are CBC and malaria results?',
   'Viral or self-limiting febrile illness.',
   'Manage as outpatient with antipyretics: paracetamol 10 mg/kg per dose and supportive care including tepid sponging. Review in 7 days.',
   '2.1'),
  ('acute_fever','fever_no_danger_granulocytosis_malaria_negative','Fever without danger signs: granulocytosis and malaria negative','terminal',202,'routine','outpatient',
   '{"danger_signs":false,"neurological_symptoms":false,"malaria":"negative","cbc":"granulocytosis"}',
   ARRAY['malaria_result','cbc_result'],NULL,
   'Acute bacterial infection.',
   'Outpatient oral amoxicillin/clavulanate plus paracetamol. Dose: over 12 years 375-750 mg; under 12 years 25-50 mg/kg/day. Follow up in 7 days.',
   '2.1'),
  ('acute_fever','fever_no_danger_lymphocytosis_malaria_negative','Fever without danger signs: lymphocytosis and malaria negative','terminal',203,'routine','outpatient',
   '{"danger_signs":false,"neurological_symptoms":false,"malaria":"negative","cbc":"lymphocytosis"}',
   ARRAY['malaria_result','cbc_result'],NULL,
   'Viral febrile illness.',
   'Outpatient symptomatic management with paracetamol.',
   '2.1'),
  ('acute_fever','fever_no_danger_anaemia_malaria_negative','Fever without danger signs: anaemia and malaria negative','terminal',204,'urgent','admit',
   '{"danger_signs":false,"neurological_symptoms":false,"malaria":"negative","haemoglobin_g_dl":{"lt":10}}',
   ARRAY['malaria_result','haemoglobin'],NULL,
   'Anaemia complicating acute febrile illness.',
   'Admit for further workup and possible transfusion.',
   '2.1'),
  ('acute_fever','fever_uncomplicated_malaria','Uncomplicated malaria','terminal',205,'routine','outpatient',
   '{"malaria":"positive","cbc":["normal","lymphocytosis"],"danger_signs":false}',
   ARRAY['malaria_result','cbc_result'],NULL,
   'Uncomplicated malaria.',
   'Outpatient oral artemether/lumefantrine dosed by body weight plus paracetamol. Follow up in 3 days.',
   '2.1'),
  ('acute_fever','fever_mixed_bacterial_malaria','Mixed bacterial infection and malaria','terminal',206,'urgent','admit',
   '{"malaria":"positive","cbc":"granulocytosis"}',
   ARRAY['malaria_result','cbc_result'],NULL,
   'Mixed bacterial infection and malaria.',
   'Admit for parenteral treatment with artesunate 2.4 mg/kg loading dose, paracetamol, and ceftriaxone 50 mg/kg.',
   '2.1'),
  ('acute_fever','fever_severe_malaria_or_anaemia','Severe malaria or malaria with anaemia/thrombocytopenia','terminal',207,'critical','admit',
   '{"malaria":"positive","severity_features":["anaemia","thrombocytopenia","other_severity_signs"]}',
   ARRAY['malaria_result','severity_features'],NULL,
   'Malaria with severity features.',
   'Admit for parenteral treatment. Transfuse if haemoglobin is below 5 g/dL and give oral ranferon when haemoglobin is above 6 g/dL.',
   '2.1'),
  ('acute_fever','fever_neurological_symptoms','Fever with neurological symptoms','terminal',208,'critical','admit',
   '{"fever":true,"neurological_symptoms":true,"symptoms_any":["confusion","hallucinations","abnormal posturing"]}',
   ARRAY['neurological_symptoms'],'Are confusion, hallucinations, abnormal posturing, seizure, or reduced consciousness present?',
   'Possible CNS infection, metabolic derangement, or severe malaria.',
   'Initial tests: CBC, malaria antigen, renal function tests, and random blood sugar. If tests are negative, consider viral encephalitis, meningitis, or non-infective cause; admit for lumbar puncture and start IV ceftriaxone 100 mg/kg twice daily plus paracetamol. If leucocytosis is present, treat as bacterial meningitis or brain abscess with high-dose IV ceftriaxone, paracetamol, and midazolam 0.15 mg/kg for bizarre behaviour or seizure control. If hypoglycaemia, hyperglycaemia, or severe sodium disturbance is present, correct the metabolic abnormality and give empiric ceftriaxone. All cases require admission, close monitoring, seizure control if needed, and specialist consultation.',
   '2.2'),
  ('acute_fever','fever_child_under_60_days_convulsions','Fever with convulsions in child under 60 days','terminal',209,'critical','admit',
   '{"age_days":{"lt":60},"fever":true,"convulsions":true}',
   ARRAY['age_days','convulsions'],NULL,
   'Possible neonatal sepsis or meningitis.',
   'Admit for full septic workup including lumbar puncture if no signs of raised intracranial pressure. Give ceftriaxone 100 mg/kg per dose, paracetamol as needed, and seizure management per appendix. If malaria positive, add artesunate 3 mg/kg per dose. If hypoglycaemia is present, give 5 mL/kg of 10% dextrose stat.',
   '2.3'),
  ('acute_fever','fever_pneumonia_child_over_60_days','Fever with fast or difficult breathing in child over 60 days','terminal',210,'urgent','depends_on_severity',
   '{"age_days":{"gt":60},"fever":true,"respiratory_symptoms":true,"classification":["very severe pneumonia","severe pneumonia","non-severe pneumonia","no pneumonia"]}',
   ARRAY['age_days','respiratory_classification'],'Classify breathing using danger signs, chest indrawing, tachypnoea, and ability to feed.',
   'WHO pneumonia severity classification.',
   'Very severe pneumonia: admit for oxygen and IV amoxicillin/clavulanate 40 mg/kg/day plus IV paracetamol. Severe pneumonia: admit for IV amoxicillin/clavulanate 40 mg/kg/day and IV paracetamol. Non-severe pneumonia: outpatient oral amoxicillin/clavulanate 40 mg/kg/day plus paracetamol, follow up in 2 days. No pneumonia: no antibiotics; outpatient symptomatic treatment and follow-up in 5 days.',
   '2.4'),
  ('acute_fever','fever_otitis_media','Fever with ear pain / otitis media','terminal',211,'urgent','depends_on_age_and_complications',
   '{"fever":true,"ear_pain":true,"age_months_rules":["under_3_any_fever_admit","3_to_6_months_admit","over_6_months_uncomplicated_outpatient"],"complicated_signs":["persistent otorrhoea","recurrent otorrhoea","mastoiditis","cranial nerve involvement"]}',
   ARRAY['age_months','complicated_otitis_signs'],NULL,
   'Otitis media pathway.',
   'Child under 3 months with any fever, or any age with complicated infection: admit for IV amoxicillin/clavulanate 40 mg/kg per dose and IV paracetamol. Child over 6 months with uncomplicated otitis media and no danger signs: outpatient oral amoxicillin/clavulanate 45 mg/kg per dose plus paracetamol. Child aged 3 to 6 months with fever: admit for IV antibiotics regardless of other signs.',
   '2.5'),
  ('acute_fever','fever_uti','Fever with dysuria and urinary symptoms','terminal',212,'urgent','depends_on_complication',
   '{"fever":true,"urinary_symptoms":true,"complicated_signs":["flank pain","suprapubic tenderness","frank haematuria","vomiting","pyuria"]}',
   ARRAY['complicated_uti_signs'],NULL,
   'Urinary tract infection pathway.',
   'Stable uncomplicated infection: outpatient oral cefuroxime 50 mg/kg per dose plus paracetamol, follow up in 7 days, counsel hygiene and hydration. Complicated infection with flank pain, suprapubic tenderness, frank haematuria, vomiting, or pyuria: admit for IV ciprofloxacin. Dosing: 4 mg/kg per dose for infants 1 month to 1 year, maximum 400 mg; 6 mg/kg per dose for children 1 to 18 years. Avoid ciprofloxacin in pregnancy. Add IV paracetamol for pain.',
   '2.6'),

  ('bp_pregnancy','bp_preg_severe_preeclampsia','More than 20 weeks pregnant with target organ damage','terminal',301,'critical','admit',
   '{"pregnant":true,"gestation_weeks":{"gt":20},"blood_pressure":{"gte":"140/90"},"target_organ_damage":true}',
   ARRAY['gestation_weeks','blood_pressure','target_organ_damage'],'Is gestation above 20 weeks, what is the blood pressure, and are severe headache, blurred vision, epigastric pain, oliguria, or liver tenderness present?',
   'Severe pre-eclampsia.',
   'Investigate with CBC, urinalysis, renal and liver function tests, and coagulation profile. Admit immediately for urgent gynaecology review. Place in left lateral position. If BP exceeds 160/110 mmHg, give IV hydralazine 5 mg slowly over 10 minutes. Give magnesium sulphate: 4 g of 20% magnesium sulphate over 15 minutes, then 1 g hourly for 24 hours while monitoring respiratory rate, urine output, and patellar reflexes. Continue for 24 hours after delivery, whichever comes first. Restrict fluids to 80 mL/hour of Ringer lactate and avoid dextrose solutions.',
   '3.1'),
  ('bp_pregnancy','bp_preg_mild_preeclampsia_or_gestational_htn','More than 20 weeks pregnant without target organ damage','terminal',302,'urgent','admit_observe',
   '{"pregnant":true,"gestation_weeks":{"gt":20},"blood_pressure":{"gte":"140/90"},"target_organ_damage":false}',
   ARRAY['gestation_weeks','blood_pressure','target_organ_damage'],NULL,
   'Gestational hypertension or mild pre-eclampsia.',
   'If CBC, renal function, and urinalysis are normal, manage with oral methyldopa 250 mg three times daily and admission for observation. Anaemia or thrombocytopenia requires further investigation and specialist care.',
   '3.2'),
  ('bp_pregnancy','bp_preg_under_20_severe_chronic_htn','Less than 20 weeks pregnant with severe hypertension and target organ damage','terminal',303,'urgent','admit',
   '{"pregnant":true,"gestation_weeks":{"lt":20},"severe_hypertension":true,"target_organ_damage":true}',
   ARRAY['gestation_weeks','blood_pressure','target_organ_damage'],NULL,
   'Severe chronic hypertension.',
   'Investigate secondary causes with renal Doppler ultrasound, ECG, echocardiogram, KUB ultrasound, and 24-hour urine for vanillylmandelic acid, metanephrines, and unconjugated catecholamines. Admit for BP control with oral methyldopa 250 mg three times daily.',
   '3.3'),
  ('bp_pregnancy','bp_preg_under_20_mild_chronic_htn','Less than 20 weeks pregnant with mild hypertension and no target organ damage','terminal',304,'urgent','admit_review',
   '{"pregnant":true,"gestation_weeks":{"lt":20},"mild_hypertension":true,"target_organ_damage":false}',
   ARRAY['gestation_weeks','blood_pressure','target_organ_damage'],NULL,
   'Mild chronic hypertension.',
   'If baseline investigations are normal, admit for specialist review. Immediate treatment may not be needed.',
   '3.4'),

  ('head_injury','head_mild_with_associated_features','GCS 13 or above with associated features','terminal',401,'urgent','admit',
   '{"gcs":{"gte":13},"associated_features_any":["convulsions","confusion","csf otorrhoea","csf rhinorrhoea","penetrating injury","palpable fracture","deformity","blurred vision","vomiting","anisocoria","lateralising signs","age under 5","age over 60"]}',
   ARRAY['gcs','associated_features'],NULL,
   'Mild head injury with high-risk features.',
   'Admit for observation and urgent surgical consult. Order urgent CT head. Give IV ceftriaxone 100 mg/kg per dose, paracetamol 10 mg/kg per dose, phenytoin 20 mg/kg over 15 minutes with ECG and BP monitoring, and tetanus toxoid 0.5 mg IM for patients over 5 years old.',
   '4.1'),
  ('head_injury','head_moderate','GCS 8 to 12','terminal',402,'critical','admit',
   '{"gcs":{"gte":8,"lte":12}}',
   ARRAY['gcs'],NULL,
   'Moderate head injury.',
   'Immediate admission, urgent CT head, and surgical review. Give ceftriaxone, paracetamol, phenytoin, and tetanus toxoid as above.',
   '4.2'),
  ('head_injury','head_severe','GCS below 8','terminal',403,'critical','admit_high_level_care',
   '{"gcs":{"lt":8}}',
   ARRAY['gcs'],NULL,
   'Severe head injury.',
   'Requires immediate high-level care, admission, surgical review, and urgent CT head. Give ceftriaxone, paracetamol, phenytoin, and tetanus toxoid as above.',
   '4.3'),

  ('abdominal_injury','abdomen_injury_shock','Abdominal injury with signs of shock','terminal',501,'critical','admit',
   '{"abdominal_injury":true,"shock":true}',
   ARRAY['shock_status','injury_type'],NULL,
   'Abdominal trauma with shock.',
   'Immediate resuscitation and urgent surgical consult. Do not remove impaled penetrating objects. If no impaled object, pack wound with sterile gauze. Perform FAST ultrasound during resuscitation. Send CBC, renal function, liver function, and cross-match. Admit and give IV ceftriaxone 50 mg/kg per dose, IV metronidazole 7.5 mg/kg per dose, and paracetamol 10 mg/kg per dose. Give tetanus toxoid 0.5 mg IM for penetrating injuries in patients over 5 years old.',
   '5.1'),
  ('abdominal_injury','abdomen_injury_stable','Haemodynamically stable abdominal injury','terminal',502,'urgent','admit_observe',
   '{"abdominal_injury":true,"shock":false}',
   ARRAY['shock_status','injury_type'],NULL,
   'Stable abdominal trauma.',
   'Admit for observation with maintenance IV fluids. Perform FAST ultrasound and same lab workup. Give tetanus prophylaxis and IV ceftriaxone plus metronidazole as above.',
   '5.2'),

  ('chest_trauma','chest_shock_normal_percussion','Chest trauma with shock and normal percussion note','terminal',601,'critical','admit',
   '{"chest_trauma":true,"shock":true,"percussion_note":"normal"}',
   ARRAY['shock_status','percussion_note'],NULL,
   'Blunt chest trauma with haemodynamic compromise.',
   'Resuscitate, give oxygen, obtain chest x-ray, and request urgent specialist consultation. Give ceftriaxone 50 mg/kg per dose, metronidazole 7.5 mg/kg per dose, and paracetamol.',
   '6.1'),
  ('chest_trauma','chest_tension_pneumothorax','Chest trauma with shock and hyper-resonant percussion note','terminal',602,'critical','admit',
   '{"chest_trauma":true,"shock":true,"percussion_note":"hyper-resonant"}',
   ARRAY['shock_status','percussion_note'],NULL,
   'Tension pneumothorax.',
   'Immediate needle decompression at the 2nd intercostal space mid-clavicular line before imaging. Then resuscitate, give oxygen, obtain chest x-ray, and request specialist consultation.',
   '6.2'),
  ('chest_trauma','chest_haemothorax','Chest trauma with shock and dull percussion note','terminal',603,'critical','admit',
   '{"chest_trauma":true,"shock":true,"percussion_note":"dull"}',
   ARRAY['shock_status','percussion_note'],NULL,
   'Possible haemothorax.',
   'Resuscitate, give oxygen, request urgent surgical review, and obtain chest x-ray. Chest tube insertion may be required.',
   '6.3'),
  ('chest_trauma','chest_no_shock','Chest trauma without shock','terminal',604,'urgent','admit_observe',
   '{"chest_trauma":true,"shock":false}',
   ARRAY['shock_status'],NULL,
   'Stable blunt chest trauma.',
   'Reassure, give maintenance IV fluids, admit for observation, and obtain chest x-ray. If pneumothorax or haemothorax is found, manage accordingly. Give ceftriaxone, metronidazole, and paracetamol. All chest trauma patients require specialist consultation.',
   '6.4'),

  ('epigastric_pain','epi_bloody_vomit_shock','Epigastric pain with bloody vomitus and shock','terminal',701,'critical','admit',
   '{"epigastric_pain":true,"bloody_vomitus":true,"shock":true}',
   ARRAY['bloody_vomitus','shock_status'],NULL,
   'Presumed upper gastrointestinal bleeding with shock.',
   'Immediate resuscitation. Send FBC, renal and liver function tests, and H. pylori antigen. Admit for urgent surgical consultation. Start IV fluids according to hypovolaemic shock protocol. Give IV clarithromycin, IV Augmentin, IV ranitidine for patients over 16 years, and IV tranexamic acid 10 mg/kg per dose three times daily. Manage anaemia, thrombocytopenia, and deranged liver or renal function concurrently.',
   '7.1'),
  ('epigastric_pain','epi_bloody_vomit_no_shock','Epigastric pain with bloody vomitus but no shock','terminal',702,'urgent','admit',
   '{"epigastric_pain":true,"bloody_vomitus":true,"shock":false}',
   ARRAY['bloody_vomitus','shock_status'],NULL,
   'Upper gastrointestinal bleeding without shock.',
   'Use same diagnostic and management approach but with less intensive resuscitation. Start IV normal saline while awaiting consultation. Admit for endoscopy and surgical review. Give clarithromycin, Augmentin, ranitidine, and tranexamic acid as above.',
   '7.2'),
  ('epigastric_pain','epi_non_bloody_vomit_shock','Epigastric pain with non-bloody vomitus and shock','terminal',703,'critical','admit',
   '{"epigastric_pain":true,"bloody_vomitus":false,"vomiting":true,"shock":true}',
   ARRAY['vomiting','bloody_vomitus','shock_status'],NULL,
   'Severe gastritis or peptic ulcer disease with shock.',
   'Admit, resuscitate with IV fluids, and request surgical consultation. Give clarithromycin, Augmentin, and ranitidine. Tranexamic acid may be omitted if there is no bleeding.',
   '7.3'),
  ('epigastric_pain','epi_stable_h_pylori_negative','Stable mild epigastric pain with negative H. pylori','terminal',704,'routine','outpatient',
   '{"epigastric_pain":true,"vomiting":false,"shock":false,"h_pylori":"negative"}',
   ARRAY['vomiting','shock_status','h_pylori_result'],NULL,
   'Stable mild epigastric pain without H. pylori.',
   'Outpatient management with a proton pump inhibitor such as esomeprazole. Adult dose over 12 years: 20 mg twice daily. Paediatric dosing by weight: 3.5 kg: 2.5 mg daily; 3.5-7.5 kg: 5 mg daily; over 7.5 kg: 10 mg daily. Follow up in 7 days.',
   '7.4'),
  ('epigastric_pain','epi_stable_h_pylori_positive','Stable mild epigastric pain with positive H. pylori','terminal',705,'routine','outpatient',
   '{"epigastric_pain":true,"vomiting":false,"shock":false,"h_pylori":"positive"}',
   ARRAY['vomiting','shock_status','h_pylori_result'],NULL,
   'Stable mild epigastric pain with H. pylori.',
   'Outpatient H. pylori eradication kit with esomeprazole, amoxicillin, and clarithromycin plus paracetamol. Follow up in 7 days.',
   '7.4'),

  ('asthma_attack','asthma_mild','Mild asthmatic attack','terminal',801,'routine','outpatient',
   '{"mental_state":"normal","talking":"sentences","accessory_muscles":false,"wheeze":"end-expiration","pulse_rate":{"lt":100},"pulsus_paradoxus":"absent_or_below_10"}',
   ARRAY['asthma_severity_features'],NULL,
   'Mild asthma attack.',
   'Outpatient nebulised salbutamol: 1 month to 11 years 2.5 mg; over 11 years 5 mg, repeated up to 3 doses in the first hour. Add oral prednisolone 1 mg/kg daily for 7 days. Follow up in 24 hours.',
   '8.1'),
  ('asthma_attack','asthma_moderate','Moderate asthmatic attack','terminal',802,'urgent','admit',
   '{"accessory_muscles":true,"wheeze":"loud throughout exhalation","pulse_rate":"100-120_or_age_adjusted","pulsus_paradoxus":"10-25"}',
   ARRAY['asthma_severity_features'],NULL,
   'Moderate asthma attack.',
   'Admit for repeated nebulised salbutamol, IV ipratropium 200 micrograms, and IV hydrocortisone: 1-5 years 50 mg; 6-12 years 100 mg. Call a physician immediately.',
   '8.2'),
  ('asthma_attack','asthma_severe','Severe asthmatic attack','terminal',803,'critical','admit',
   '{"sitting_upright":true,"agitation":true,"wheeze":"loud_inspiration_and_exhalation","pulse_rate":{"gt":120},"pulsus_paradoxus":"adult_gte_25_or_child_20_to_40"}',
   ARRAY['asthma_severity_features'],NULL,
   'Severe asthma attack.',
   'Admit for intensive nebulised salbutamol, IV ipratropium, and IV hydrocortisone. Obtain blood gas analysis. Call a physician immediately.',
   '8.3'),
  ('asthma_attack','asthma_respiratory_failure','Impending or actual respiratory failure','terminal',804,'critical','critical_care',
   '{"features_any":["drowsiness","confusion","paradoxical thoracoabdominal movement","absence of wheeze","bradycardia","absence of pulsus paradoxus"]}',
   ARRAY['respiratory_failure_features'],NULL,
   'Impending or actual respiratory failure in asthma.',
   'Admit to critical care for possible intubation. Intubate if necessary. Give aggressive bronchodilator and steroid therapy. Call a physician immediately.',
   '8.4'),

  ('burns','burn_mild','Mild burn injury','terminal',901,'routine','outpatient',
   '{"criteria_any":["age 10-50 and partial thickness <15% TBSA","age <10 or >50 and partial thickness <10% TBSA","any age full thickness <2% TBSA"]}',
   ARRAY['age_years','burn_depth','tbsa_percent','special_area_burn'],NULL,
   'Burn suitable for outpatient management.',
   'Outpatient oral flucloxacillin 50 mg/kg per dose, paracetamol 10 mg/kg per dose, and topical silver sulfadiazine. Cleanse with 0.25% chlorhexidine and apply clean wraps. Follow up in 3 days.',
   '9.1'),
  ('burns','burn_moderate','Moderate burn injury','terminal',902,'urgent','admit',
   '{"criteria_any":["age 10-50 and partial thickness 15-25% TBSA","age <10 or >50 and partial thickness 10-20% TBSA","any age full thickness 2-10% TBSA","burns involving face hands feet genitalia perineum or major joints"]}',
   ARRAY['age_years','burn_depth','tbsa_percent','special_area_burn'],NULL,
   'Burn requiring admission.',
   'Admit for surgical review. Give IV flucloxacillin 50 mg/kg per dose, IV metronidazole 7.5 mg/kg, IM pethidine 50 mg for pain, and topical silver sulfadiazine. For facial burns, add tetracycline eye ointment. Give omeprazole 4 mg/kg per dose for GI protection. Follow fluid management protocols.',
   '9.2'),
  ('burns','burn_severe','Severe burn injury','terminal',903,'critical','specialised_unit',
   '{"criteria_any":["age 10-50 and partial thickness >25% TBSA","age <10 or >50 and partial thickness >20% TBSA","any age full thickness >10% TBSA","electrical burn","chemical burn","inhalation injury","circumferential burn","burn with concomitant trauma","pre-existing medical disorder complicating management"]}',
   ARRAY['age_years','burn_depth','tbsa_percent','special_area_burn','burn_mechanism','comorbidity'],NULL,
   'Burn requiring specialised unit or intensive care.',
   'Requires aggressive fluid resuscitation, IV flucloxacillin and metronidazole, blood product support, coagulation profile monitoring, liver function tests, and surgical review.',
   '9.3'),

  ('hyperkalaemia','hyperkalaemia_stepwise','Confirmed hyperkalaemia stepwise management','protocol',1001,'critical','depends_on_response',
   '{"serum_potassium":"above_normal"}',
   ARRAY['serum_potassium'],NULL,
   'Stepwise hyperkalaemia management.',
   'Stop all potassium intake. Give sodium or calcium polystyrene sulphonate 0.5-1.0 g/kg orally or by high enema. Give 10% calcium gluconate 0.5-1.0 mg/kg IV over 5-10 minutes for cardioprotection. Shift potassium into cells with 4% sodium bicarbonate 1-2 mL/kg IV over 5-10 minutes, 50% dextrose water 1-2 mL/kg IV over 15-30 minutes with soluble insulin 1 unit per 5 g dextrose if used, and nebulised salbutamol 2.5 mg over 20 minutes or as specified. If ineffective, initiate dialysis.',
   '10'),
  ('dka','dka_management','Diabetic ketoacidosis management','protocol',1201,'critical','admit',
   '{"features":["polyuria","polydipsia","weight loss","abdominal pain","tiredness","vomiting","dehydration >5%","kussmaul breathing","ketone breath","urine ketones >2+","blood sugar >11 mmol/L","pH <7.3","bicarbonate <15"]}',
   ARRAY['blood_glucose','ketones','ph','bicarbonate','dehydration_status'],NULL,
   'DKA fluid, insulin, electrolyte, and monitoring protocol.',
   'Assess dehydration. Moderate dehydration: delayed capillary refill >2 seconds and increased respiratory rate. Severe dehydration: capillary refill >=3 seconds, mottled skin, shock, deep acidotic breathing, or reduced turgor. Calculate fluid as deficit plus maintenance over 48 hours. If reduced pulses, reduced consciousness, or coma: secure airway, consider NG tube, give 100% oxygen, and administer 0.9% saline 10 mL/kg over 10-30 minutes until circulation is restored, repeat if needed. Use 0.9% saline for total correction. If potassium is normal/low or insulin/bicarbonate was given, give potassium chloride 20-30 mmol/hour after first 30-60 minutes; delay if potassium is high. Start insulin 0.1 IU/kg/hour, or 0.05 IU/kg/hour in younger children. When glucose reaches 15 mmol/L or falls by >5 mmol/hour, change to 0.45% saline with 5% dextrose and adjust insulin to 0.05 IU/kg/hour. Monitor neurological status hourly and electrolytes every 2 hours. Transition to subcutaneous insulin once clinically well and tolerating oral fluids. If acidosis does not improve, review fluid calculations, delivery system, insulin dose, and resuscitation need. For suspected cerebral oedema, give mannitol 0.5-1 g/kg, restrict IV fluids by 50%, call senior reviewer/ICU, and image only after stabilisation.',
   '12'),
  ('paediatric_fluids','fluids_neonate','Fluid management in neonates','protocol',1301,'urgent','protocol',
   '{"patient_group":"neonate"}',
   ARRAY['age_days','weight_kg'],NULL,
   'Neonatal maintenance fluid protocol.',
   'Day 1: 60 mL/kg/day. Day 2: 90 mL/kg/day. Day 3: 120 mL/kg/day. Thereafter increase by 30 mL/kg/day and encourage breastfeeding.',
   '13'),
  ('paediatric_fluids','fluids_child_no_dehydration_plan_a','Child no dehydration: Plan A','protocol',1302,'routine','outpatient',
   '{"dehydration":"none"}',
   ARRAY['dehydration_status','age_months'],NULL,
   'Plan A oral fluid management.',
   'Breastfeed and encourage plenty of oral fluids. ORS: 50-100 mL after every loose motion for children below 2 years; 100-200 mL after every loose motion for children above 2 years. If vomiting, wait 10 minutes then continue feeding. Zinc sulphate: 10 mg once daily for 14 days below 6 months; 20 mg above 6 months. Give review advice and encourage feeding.',
   '13'),
  ('paediatric_fluids','fluids_child_some_dehydration_plan_b','Child some dehydration: Plan B','protocol',1303,'urgent','observe_reassess',
   '{"dehydration":"some","criteria_two_or_more":["restlessness or irritability","thirst and drinking eagerly","sunken eyes","slow skin pinch >2 seconds"]}',
   ARRAY['dehydration_status','weight_kg','age_months'],NULL,
   'Plan B rehydration.',
   'Give ORS 75 mL/kg over first 4 hours, reassess hydration status, and manage accordingly. Give zinc sulphate for 2 weeks: 20 mg above 6 months, 10 mg below 6 months. Encourage feeding and other oral fluids. Give review advice.',
   '13'),
  ('paediatric_fluids','fluids_child_severe_dehydration_plan_c','Child severe dehydration: Plan C','protocol',1304,'critical','urgent_rehydration',
   '{"dehydration":"severe","criteria_two_or_more":["drinking poorly","skin pinch return >=2 seconds","sunken eyes","lethargy or unconsciousness"]}',
   ARRAY['dehydration_status','weight_kg','age_months'],NULL,
   'Plan C IV rehydration.',
   'Children under 12 months: Ringer lactate 100 mL/kg as 30 mL/kg in first 1 hour, then 70 mL/kg over next 5 hours, then reassess. Children above 12 months: 30 mL/kg over first 30 minutes, then 70 mL/kg over 150 minutes, then reassess. Administer zinc sulphate and reclassify hydration status.',
   '13'),
  ('hypernatraemia','hypernatraemia_treatment','Hypernatraemia treatment','protocol',1401,'critical','admit_monitor',
   '{"serum_sodium_mmol_l":{"gt":150}}',
   ARRAY['serum_sodium','weight_kg'],NULL,
   'Controlled correction of sodium above 150 mmol/L.',
   'Common causes include hypernatraemic dehydration and salt poisoning. Use hypotonic solutions. Give half-strength Darrow solution at 0.5-1.0 mmol/hour over 24 hours. Check sodium every 4 hours until below 150 mmol/L and weigh hourly. If sodium falls too rapidly and weight increases, reduce infusion rate. If sodium falls too rapidly and weight does not change, change to fluid with higher sodium. If sodium falls very slowly and weight does not increase, step up infusion rate. If sodium falls very slowly and weight increases, change to lower sodium solution such as normal saline or half-normal saline with dextrose and potassium.',
   '14'),
  ('hyponatraemia','hyponatraemia_emergency','Hyponatraemia emergency and volume-status management','protocol',1501,'critical','admit_monitor',
   '{"serum_sodium_mmol_l":{"lt":130},"severe_threshold_mmol_l":{"lt":115},"emergency_features":["seizure","coma","suspected cerebral herniation"]}',
   ARRAY['serum_sodium','neurological_status','volume_status'],NULL,
   'Emergency treatment and volume status approach for hyponatraemia.',
   'If seizure, coma, or suspected cerebral herniation due to hyponatraemia, give IV 3% hypertonic saline 100-150 mL over 5-10 minutes, then reassess. If no clinical improvement, repeat a second bolus. Stop all fluids after the second bolus to avoid overcorrection. If hypertonic saline is unavailable, give one ampoule sodium bicarbonate over 5 minutes. Assess volume status using history, heart rate, blood pressure, JVP, and oedema. Hypovolaemic hyponatraemia: restore circulating volume; Ringer lactate is recommended because it raises sodium more slowly than normal saline. Euvolemic: restrict free fluid to less than 1 L/day. Hypervolemic: treat underlying cause and consider fluid restriction and diuretics.',
   '15'),
  ('pph_risk','pph_risk_assessment','Postpartum haemorrhage risk assessment and immediate response','appendix',1601,'critical','prepare_or_resuscitate',
   '{"pph_definition":["vaginal bleeding >500 mL","caesarean blood loss >1000 mL"],"high_risk_factors":["suspected placenta praevia/increta/percreta","known placenta praevia or accreta","prior classic caesarean section or myomectomy","multiple gestation","platelet count <70000","known coagulopathy","active bleeding on admission","chorioamnionitis","prolonged oxytocin >24h","prolonged second stage","two or more medium-risk factors"],"medium_risk_factors":["prior caesarean section","uterine surgery","estimated fetal weight >4000 g","BMI >40","haematocrit <30%","more than 4 prior births","large myomas"]}',
   ARRAY['obstetric_risk_factors','estimated_blood_loss'],NULL,
   'PPH risk factors and immediate response.',
   'High-risk factors should prompt increased vigilance and preparation. For any patient with postpartum haemorrhage, defined as vaginal bleeding exceeding 500 mL or caesarean blood loss exceeding 1000 mL, initiate immediate resuscitation, complete blood count, renal function tests, and grouping and cross-matching of blood.',
   'Appendix')
) AS v(condition_key,node_key,title,node_type,display_order,severity,disposition,criteria,required_facts,missing_fact_question,summary,management_text,source_section)
ON c.condition_key = v.condition_key;

INSERT INTO pathway_actions (pathway_node_id, action_order, action_type, action_text)
SELECT id, 1, 'management', management_text
FROM pathway_nodes;

INSERT INTO pathway_investigations (pathway_node_id, investigation_id, timing, notes)
SELECT pn.id, i.id, 'initial', 'Recommended in source pathway'
FROM pathway_nodes pn
JOIN investigations i ON i.investigation_key = ANY (
  CASE pn.node_key
    WHEN 'pvb_non_pregnant_shock' THEN ARRAY['cbc','crossmatch','pelvic_ultrasound','liver_function','coagulation_profile','peripheral_blood_film']
    WHEN 'pvb_pregnant_under_20w_shock' THEN ARRAY['obstetric_ultrasound','cbc','coagulation_profile']
    WHEN 'pvb_pregnant_over_20w_shock' THEN ARRAY['obstetric_ultrasound','cbc','coagulation_profile']
    WHEN 'pvb_stable_active_bleeding' THEN ARRAY['cbc']
    WHEN 'pvb_stable_resolved_bleeding' THEN ARRAY['cbc']
    WHEN 'fever_no_danger_malaria_negative_normal_cbc' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_no_danger_granulocytosis_malaria_negative' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_no_danger_lymphocytosis_malaria_negative' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_no_danger_anaemia_malaria_negative' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_uncomplicated_malaria' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_mixed_bacterial_malaria' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_severe_malaria_or_anaemia' THEN ARRAY['cbc','malaria_antigen']
    WHEN 'fever_neurological_symptoms' THEN ARRAY['cbc','malaria_antigen','renal_function','random_blood_sugar','lumbar_puncture']
    WHEN 'fever_child_under_60_days_convulsions' THEN ARRAY['lumbar_puncture','malaria_antigen','random_blood_sugar']
    WHEN 'fever_uti' THEN ARRAY['urinalysis']
    WHEN 'bp_preg_severe_preeclampsia' THEN ARRAY['cbc','urinalysis','renal_function','liver_function','coagulation_profile']
    WHEN 'bp_preg_mild_preeclampsia_or_gestational_htn' THEN ARRAY['cbc','urinalysis','renal_function']
    WHEN 'bp_preg_under_20_severe_chronic_htn' THEN ARRAY['renal_doppler_ultrasound','ecg','echocardiogram','kub_ultrasound','urine_catecholamine_metabolites_24h']
    WHEN 'bp_preg_under_20_mild_chronic_htn' THEN ARRAY['cbc','renal_function','urinalysis']
    WHEN 'head_mild_with_associated_features' THEN ARRAY['ct_head']
    WHEN 'head_moderate' THEN ARRAY['ct_head']
    WHEN 'head_severe' THEN ARRAY['ct_head']
    WHEN 'abdomen_injury_shock' THEN ARRAY['fast_ultrasound','cbc','renal_function','liver_function','crossmatch']
    WHEN 'abdomen_injury_stable' THEN ARRAY['fast_ultrasound','cbc','renal_function','liver_function','crossmatch']
    WHEN 'chest_shock_normal_percussion' THEN ARRAY['chest_xray']
    WHEN 'chest_tension_pneumothorax' THEN ARRAY['chest_xray']
    WHEN 'chest_haemothorax' THEN ARRAY['chest_xray']
    WHEN 'chest_no_shock' THEN ARRAY['chest_xray']
    WHEN 'epi_bloody_vomit_shock' THEN ARRAY['cbc','renal_function','liver_function','h_pylori_antigen']
    WHEN 'epi_bloody_vomit_no_shock' THEN ARRAY['cbc','renal_function','liver_function','h_pylori_antigen']
    WHEN 'asthma_severe' THEN ARRAY['blood_gas']
    WHEN 'burn_severe' THEN ARRAY['coagulation_profile','liver_function']
    WHEN 'hyperkalaemia_stepwise' THEN ARRAY['electrolytes','ecg']
    WHEN 'dka_management' THEN ARRAY['random_blood_sugar','urine_ketones','blood_gas','serum_bicarbonate','electrolytes','ecg']
    WHEN 'hypernatraemia_treatment' THEN ARRAY['electrolytes','serial_weight']
    WHEN 'hyponatraemia_emergency' THEN ARRAY['electrolytes','volume_status_assessment']
    WHEN 'pph_risk_assessment' THEN ARRAY['cbc','renal_function','crossmatch']
    ELSE ARRAY[]::TEXT[]
  END
);

COMMIT;

-- Example pathway lookup for n8n after extracting facts to JSON:
-- SELECT pn.*
-- FROM clinical.pathway_nodes pn
-- JOIN clinical.conditions c ON c.id = pn.condition_id
-- WHERE c.condition_key = $1
--   AND pn.criteria @> $2::jsonb
-- ORDER BY pn.severity DESC, pn.display_order
-- LIMIT 1;
