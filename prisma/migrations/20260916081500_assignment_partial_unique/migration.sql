-- Job-level technician assignments need their own unique index.
--
-- UNIQUE (jobId, jobVisitId, technicianId) does not constrain rows where jobVisitId is
-- NULL, because Postgres treats NULLs as distinct: the same technician could be assigned
-- to the same job any number of times. A partial unique index covers exactly that case,
-- while the three-column index continues to cover visit-scoped assignments.
CREATE UNIQUE INDEX "JobAssignment_job_tech_no_visit_key"
  ON "JobAssignment" ("jobId", "technicianId")
  WHERE "jobVisitId" IS NULL;
