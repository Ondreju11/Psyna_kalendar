CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE daily_place_suggests (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
