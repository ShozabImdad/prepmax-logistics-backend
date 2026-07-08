-- ============================================================================
-- 0007_branch_volumetric_divisor
-- Per-branch volumetric-weight divisor (architecture plan §5). Default 5000 =
-- the standard cm/kg courier divisor. A branch that ships in inches/lb would
-- use 139. Stored per branch so each can be configured independently.
-- ============================================================================

ALTER TABLE branches
  ADD COLUMN volumetric_divisor integer NOT NULL DEFAULT 5000
    CHECK (volumetric_divisor > 0);
