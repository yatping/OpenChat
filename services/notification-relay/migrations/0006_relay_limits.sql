-- For the configurable limits. New installations a day are counted by created_at, and devices per installation
-- from subscriptions.
CREATE INDEX installations_created_idx ON installations (created_at);
CREATE INDEX subscriptions_installation_device_idx ON subscriptions (installation_id, device_id);
