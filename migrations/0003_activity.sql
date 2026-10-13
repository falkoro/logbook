-- list_activity filters by actor, and list_users reads each actor's latest write.
CREATE INDEX changes_actor ON changes(actor_id, sync_id);
