CREATE TABLE events (
  id TEXT PRIMARY KEY,
  edit_key_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_creates (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
