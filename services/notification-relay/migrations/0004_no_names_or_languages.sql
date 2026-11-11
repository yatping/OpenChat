-- ADR-0017: the relay no longer holds workspace names or phone languages. Clears what is stored now. Both columns
-- are still read by the previous Worker, so they are dropped in a later migration, once it is gone.
UPDATE workspaces SET display_name = NULL;
UPDATE devices SET locale = '';
