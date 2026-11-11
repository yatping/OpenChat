-- Contract step for 0004. Neither column has been read since ADR-0017. Before launch, the owner accepted that the
-- previous Worker, which still wrote an empty `locale`, cannot register a device between this and the deploy.
ALTER TABLE workspaces DROP COLUMN display_name;
ALTER TABLE devices DROP COLUMN locale;
