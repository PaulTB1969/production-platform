-- Two more role actions (Users & Roles):
--   uploadCsv             upload the Production Schedule and Stock Collections CSV files
--   generateRequisitions  generate requisitions from the Production Schedule
-- On for Admin and Production manager (and any role that can manage users);
-- off for the rest, as Paul asked (Oct 2026).
UPDATE roles SET actions = actions || jsonb_build_object(
  'uploadCsv', name IN ('Admin', 'Production manager') OR COALESCE((actions->>'manageUsers')::boolean, false),
  'generateRequisitions', name IN ('Admin', 'Production manager') OR COALESCE((actions->>'manageUsers')::boolean, false));
