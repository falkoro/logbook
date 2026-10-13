-- Logbook schema. Runs unchanged on D1 (wrangler d1 migrations) and bun:sqlite (src/db/sqlite.ts).
-- Imported rows keep their Linear UUID as id, so a re-import updates instead of duplicating.
-- Every write also lands in `changes` (see src/core/log.ts); the column lists there must match this file
-- (test/schema.test.ts checks it).

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
  name TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate')),
  color TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX states_team ON states(team_id, position);

-- team_id NULL = workspace-wide. A group (is_group = 1) cannot be applied; exclusive = 1 allows one child per issue.
CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id),
  parent_id TEXT REFERENCES labels(id),
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  exclusive INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE docs (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'staging', 'live', 'rolled_back')),
  deployed_at TEXT,
  notes_doc_id TEXT REFERENCES docs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (team_id, version)
);

-- parent_id and duplicate_of_id carry no foreign key on purpose: the importer writes issues before their parents exist.
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state_id TEXT NOT NULL REFERENCES states(id),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id TEXT REFERENCES actors(id),
  creator_id TEXT REFERENCES actors(id),
  parent_id TEXT,
  release_id TEXT REFERENCES releases(id),
  duplicate_of_id TEXT,
  dedupe_key TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  archived_at TEXT,
  UNIQUE (team_id, number)
);
CREATE INDEX issues_updated ON issues(updated_at);
CREATE INDEX issues_state ON issues(state_id);
CREATE INDEX issues_parent ON issues(parent_id);
CREATE INDEX issues_release ON issues(release_id);
CREATE INDEX issues_dedupe ON issues(team_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_labels_label ON issue_labels(label_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  author_id TEXT REFERENCES actors(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX comments_issue ON comments(issue_id, created_at);

-- Either a stored file (blob_key) or an external link (url).
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  issue_id TEXT REFERENCES issues(id),
  comment_id TEXT REFERENCES comments(id),
  doc_id TEXT REFERENCES docs(id),
  blob_key TEXT,
  url TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  author_id TEXT REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (blob_key IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX attachments_issue ON attachments(issue_id);

-- The captain inbox. Only a human may answer (src/core/decisions.ts).
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  issue_id TEXT REFERENCES issues(id),
  kind TEXT NOT NULL DEFAULT 'decide' CHECK (kind IN ('decide', 'review')),
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT,
  asked_by_id TEXT REFERENCES actors(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'withdrawn')),
  answer TEXT,
  answered_by_id TEXT REFERENCES actors(id),
  answered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX decisions_status ON decisions(status, created_at);
CREATE INDEX decisions_issue ON decisions(issue_id);

CREATE TABLE pr_links (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  provider TEXT NOT NULL CHECK (provider IN ('origin', 'github')),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('draft', 'open', 'merged', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (issue_id, provider, repo, number)
);

-- Append-only. sync_id only goes up; clients (and sub-project B's sync engine) read "everything after N".
CREATE TABLE changes (
  sync_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create', 'update', 'archive', 'import')),
  actor_id TEXT,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX changes_entity ON changes(entity, entity_id, sync_id);

-- Full-text search over issues and comments (external-content FTS5, kept in step by triggers).
CREATE VIRTUAL TABLE issues_fts USING fts5(title, description, content='issues', content_rowid='rowid');
CREATE TRIGGER issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
END;
CREATE TRIGGER issues_fts_au AFTER UPDATE OF title, description ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO issues_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;

CREATE VIRTUAL TABLE comments_fts USING fts5(body, content='comments', content_rowid='rowid');
CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER comments_fts_au AFTER UPDATE OF body ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
