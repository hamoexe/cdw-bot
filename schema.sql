-- schema.sql — matches ensureSchema() in cdw.js exactly.
-- Applied by deploy.sh (idempotent — CREATE TABLE IF NOT EXISTS everywhere).
-- IMPORTANT: deploy.sh's parser splits on ';' and reads the result
-- line-by-line, so every statement below MUST stay on a single line —
-- do not reformat these across multiple lines.
-- The Worker also runs these same statements itself on first DB use each
-- cold start, so this file is a pre-warm, not a hard dependency — but keep
-- it in sync if ensureSchema() in cdw.js ever changes.
CREATE TABLE IF NOT EXISTS tiktok_cache (video_id TEXT PRIMARY KEY, log_msg_ids TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS instagram_cache (video_id TEXT PRIMARY KEY, log_msg_ids TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS youtube_cache (video_id TEXT PRIMARY KEY, log_msg_ids TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS yt_jobs (job_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, user_id INTEGER, video_id TEXT NOT NULL, format TEXT NOT NULL, task_url TEXT NOT NULL, api_key TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS spotify_cache (track_id TEXT PRIMARY KEY, log_msg_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_users (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, request_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, platform TEXT, message TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_usage (user_id INTEGER NOT NULL, date TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, date));
CREATE TABLE IF NOT EXISTS unlimited_users (user_id INTEGER PRIMARY KEY, added_at INTEGER NOT NULL);
