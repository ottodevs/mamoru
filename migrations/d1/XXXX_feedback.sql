-- In-app feedback: one button, two paths — support (answered in Mattermost, one thread per request) and
-- feedback, bug or idea (a short line, weekly triage by hand) (otto/mamoru#72). Additive only.

-- The row is the source of truth; a Mattermost post is best-effort fan-out and never blocks or loses it
-- (mm_post_id is set only once that post succeeds). No IP, no user agent: `contact` is whatever the sender
-- chose to type, and `account_key` is set only when the sender ticked "attach my account" and a session
-- owning one existed at the time.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,            -- ISO
  kind TEXT NOT NULL,                  -- 'support' | 'bug' | 'idea'
  body TEXT NOT NULL,
  contact TEXT,
  route TEXT NOT NULL,                 -- SPA path the form was opened from, e.g. '/'
  app_version TEXT,                    -- unset today; reserved for when the SPA starts sending one
  account_key TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'ticketed' | 'closed', set by hand during weekly triage
  mm_post_id TEXT,                     -- the Mattermost post; 'posting:<epoch>' while a run is posting it
  post_attempts INTEGER NOT NULL DEFAULT 0,  -- tries to post it; after 5 it is left for a person (feedback.ts)
  ticket_url TEXT
);
CREATE INDEX feedback_created_at ON feedback(created_at);
