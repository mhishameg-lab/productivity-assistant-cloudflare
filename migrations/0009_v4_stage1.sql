UPDATE settings
   SET setting_value = 'Martino',
       updated_at = '2026-11-24T00:00:00.000Z'
 WHERE setting_key = 'display_name';

INSERT OR IGNORE INTO settings (setting_key, setting_value, description, category, updated_at)
VALUES
  ('display_name', 'Martino', 'Telegram display name', 'Display', '2026-11-24T00:00:00.000Z'),
  ('area_growth_hint', 'Learning that builds my future (HVAC/BIM, Python, automation)', 'Growth area placeholder', 'Display', '2026-11-24T00:00:00.000Z'),
  ('area_work_hint', 'GTMx and SDR work, Upflex prep', 'Work area placeholder', 'Display', '2026-11-24T00:00:00.000Z'),
  ('area_life_hint', 'Health, gym, money, errands', 'Life area placeholder', 'Display', '2026-11-24T00:00:00.000Z'),
  ('tone', 'cheeky', 'Friendly check-in tone', 'Companion', '2026-11-24T00:00:00.000Z');
