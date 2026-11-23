CREATE UNIQUE INDEX calendar_appointment_reminder_unique
  ON reminder_history(related_record_id, scheduled_at)
  WHERE category = 'Calendar appointment'
    AND related_record_id IS NOT NULL;
