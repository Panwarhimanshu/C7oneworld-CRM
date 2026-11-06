-- Leads, their visits and notes are permanent business records: nobody may delete them,
-- whatever the role. Enforced in the database so no code path or manual query can bypass it.

CREATE TRIGGER leads_no_delete BEFORE DELETE ON leads
BEGIN
  SELECT RAISE(ABORT, 'Leads cannot be deleted');
END;

CREATE TRIGGER visits_no_delete BEFORE DELETE ON visits
BEGIN
  SELECT RAISE(ABORT, 'Visits cannot be deleted');
END;

CREATE TRIGGER lead_notes_no_delete BEFORE DELETE ON lead_notes
BEGIN
  SELECT RAISE(ABORT, 'Lead notes cannot be deleted');
END;
