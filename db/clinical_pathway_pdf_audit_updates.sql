-- Idempotent updates from re-auditing /home/buma/Downloads/clinical_guidelines_institutional.pdf.
-- Adds explicit investigations and monitoring inputs that were present in the PDF but not linked
-- to their pathway nodes.

BEGIN;

SET search_path TO clinical, public;

INSERT INTO investigations (investigation_key, name, aliases, result_type) VALUES
('renal_doppler_ultrasound', 'Renal Doppler ultrasound', ARRAY['renal doppler','doppler ultrasound of the renals'], 'imaging'),
('echocardiogram', 'Echocardiogram', ARRAY['echo'], 'imaging'),
('kub_ultrasound', 'KUB ultrasound', ARRAY['kidney ureter bladder ultrasound'], 'imaging'),
('urine_catecholamine_metabolites_24h', '24-hour urine catecholamine metabolite testing', ARRAY['24-hour urine vma','vanillylmandelic acid','metanephrines','unconjugated catecholamines'], 'panel'),
('urine_ketones', 'Urine ketones', ARRAY['ketones in urine','urine ketone test'], 'semiquantitative'),
('serum_bicarbonate', 'Serum bicarbonate', ARRAY['bicarbonate','hco3'], 'numeric'),
('serial_weight', 'Serial weight monitoring', ARRAY['hourly weighing','weigh hourly'], 'numeric'),
('volume_status_assessment', 'Volume status assessment', ARRAY['jvp','pedal oedema','sacral oedema','volume status'], 'clinical_assessment')
ON CONFLICT (investigation_key) DO UPDATE
SET name = EXCLUDED.name,
    aliases = EXCLUDED.aliases,
    result_type = EXCLUDED.result_type;

WITH wanted(node_key, investigation_key, timing, notes) AS (
  VALUES
  ('pvb_stable_active_bleeding','cbc','initial','Blood count abnormalities affect admission decision.'),
  ('pvb_stable_resolved_bleeding','cbc','initial','Persistent anaemia or thrombocytopenia should prompt admission.'),
  ('fever_uti','urinalysis','initial','Urinary symptoms pathway includes pyuria/frank haematuria assessment.'),
  ('bp_preg_under_20_severe_chronic_htn','renal_doppler_ultrasound','initial','Rule out secondary causes.'),
  ('bp_preg_under_20_severe_chronic_htn','ecg','initial','Rule out secondary causes.'),
  ('bp_preg_under_20_severe_chronic_htn','echocardiogram','initial','Rule out secondary causes.'),
  ('bp_preg_under_20_severe_chronic_htn','kub_ultrasound','initial','Rule out secondary causes.'),
  ('bp_preg_under_20_severe_chronic_htn','urine_catecholamine_metabolites_24h','initial','24-hour urine VMA, metanephrines, and unconjugated catecholamines.'),
  ('bp_preg_under_20_mild_chronic_htn','cbc','baseline','Baseline investigations should be normal before conservative management.'),
  ('bp_preg_under_20_mild_chronic_htn','renal_function','baseline','Baseline investigations should be normal before conservative management.'),
  ('bp_preg_under_20_mild_chronic_htn','urinalysis','baseline','Baseline investigations should be normal before conservative management.'),
  ('hyperkalaemia_stepwise','electrolytes','initial','Confirmed serum potassium above normal.'),
  ('hyperkalaemia_stepwise','ecg','monitoring','Monitor for cardiotoxicity and treatment effects.'),
  ('dka_management','random_blood_sugar','initial','Blood sugar above 11 mmol/L is part of the pathway.'),
  ('dka_management','urine_ketones','initial','Urine ketones above 2+ are part of the pathway.'),
  ('dka_management','blood_gas','initial','pH below 7.3 and acidaemia guide the pathway.'),
  ('dka_management','serum_bicarbonate','initial','Bicarbonate below 15 is part of the pathway.'),
  ('dka_management','electrolytes','monitoring','Electrolytes are assessed every 2 hours after IV therapy starts.'),
  ('dka_management','ecg','monitoring','Repeat ECG 4 hours after potassium chloride.'),
  ('hypernatraemia_treatment','electrolytes','monitoring','Check sodium every 4 hours until below 150 mmol/L.'),
  ('hypernatraemia_treatment','serial_weight','monitoring','Perform hourly weighing.'),
  ('hyponatraemia_emergency','electrolytes','initial','Serum sodium below 130 mmol/L defines pathway entry.'),
  ('hyponatraemia_emergency','volume_status_assessment','initial','Assess hypovolaemic, euvolaemic, or hypervolaemic status.'),
  ('pph_risk_assessment','cbc','initial','Complete blood count is required for postpartum haemorrhage.'),
  ('pph_risk_assessment','renal_function','initial','Renal function tests are required for postpartum haemorrhage.'),
  ('pph_risk_assessment','crossmatch','initial','Grouping and cross-matching is required for postpartum haemorrhage.')
)
INSERT INTO pathway_investigations (pathway_node_id, investigation_id, timing, notes)
SELECT pn.id, i.id, wanted.timing, wanted.notes
FROM wanted
JOIN pathway_nodes pn ON pn.node_key = wanted.node_key
JOIN investigations i ON i.investigation_key = wanted.investigation_key
ON CONFLICT (pathway_node_id, investigation_id, timing) DO UPDATE
SET notes = EXCLUDED.notes;

COMMIT;
