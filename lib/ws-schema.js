/**
 * WebSocket message type registry.
 *
 * Documents every message type flowing between client and server.
 * Each entry: { direction, handler, description }
 *   direction: "c2s" (client to server), "s2c" (server to client), "both" (bidirectional)
 *   handler: file path where this message type is processed
 *   description: brief description
 *
 * This file is informational. It is not imported at runtime.
 * Use it as a reference when adding new message types.
 */

var schema = {

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------
  "switch_session":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Switch the active session by local ID" },
  "new_session":              { direction: "c2s", handler: "lib/project-sessions.js", description: "Create a new blank session (private:true: in the actor's personal channel)" },
  "open_room_main":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Aigora: open (get-or-create) a room's single main thread" },
  "channel_ensure":           { direction: "c2s", handler: "lib/project-channels.js", description: "Create or get the actor's personal channel in the active session's room" },
  "channel_list":             { direction: "c2s", handler: "lib/project-channels.js", description: "List own personal channels (room administrators also get a read-only room listing)" },
  "channel_close":            { direction: "c2s", handler: "lib/project-channels.js", description: "Close the actor's own personal channel in the active room (owner only)" },
  "channel_rename":           { direction: "c2s", handler: "lib/project-channels.js", description: "Rename the actor's own active personal channel in the room (owner only; name 1-30 characters, empty clears)" },
  "channel_state":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Personal channel state: own channels, optional admin room listing, ensured channel id" },
  "delete_session":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Delete a session by ID" },
  "rename_session":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Rename a session" },
  "set_session_bookmark":     { direction: "c2s", handler: "lib/project-sessions.js", description: "Bookmark or unbookmark a session in the sidebar" },
  "reorder_session_bookmarks": { direction: "c2s", handler: "lib/project-sessions.js", description: "Reorder favorited sessions within the favorites area" },
  "bulk_delete_sessions":    { direction: "c2s", handler: "lib/project-sessions.js", description: "Delete a group of sessions at once" },
  "mark_cross_project_read": { direction: "c2s", handler: "lib/project-sessions.js", description: "Clear the cross-project unread badge for a project slug without switching to it (lr-13c047)" },
  "resume_session":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Resume a CLI session by its CLI session ID" },
  "set_session_visibility":   { direction: "c2s", handler: "lib/project-sessions.js", description: "Show or hide a session in the sidebar" },
  "search_sessions":          { direction: "c2s", handler: "lib/project-sessions.js", description: "Search session titles" },
  "search_session_content":   { direction: "c2s", handler: "lib/project-sessions.js", description: "Full-text search within a session" },
  "list_cli_sessions":        { direction: "c2s", handler: "lib/project-sessions.js", description: "List active CLI sessions available for resume" },
  "load_more_history":        { direction: "c2s", handler: "lib/project-sessions.js", description: "Request older history entries for the current session" },
  "fork_session":             { direction: "c2s", handler: "lib/project-sessions.js", description: "Fork a session from a given message UUID" },
  "input_sync":               { direction: "c2s", handler: "lib/project-sessions.js", description: "Sync the current input field text to other clients" },

  // lr-66c118: session_list items carry isProcessing/unread/ownerId — the
  // exact fields lib/public/modules/activity-state.js's sessionActivity()
  // derives every render surface's dot from. No new wire message type was
  // added for "activity"; it is data already on this existing message.
  "session_list":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full list of sessions for the sidebar" },
  "session_switched":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Confirmation that active session changed" },
  "session_id":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "CLI session ID assigned to the current session" },
  "session_presence":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Which users are present in which sessions" },
  "session_io":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Notify that a session has new output activity" },
  "session_unread":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Unread message count for a session" },
  "search_results":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Session title search results" },
  "search_content_results":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full-text content search results" },
  "cli_session_list":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "List of resumable CLI sessions" },
  "fork_complete":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Fork succeeded, includes new session ID" },
  "input_sync_broadcast":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast input text from another client" },

  // -----------------------------------------------------------------------
  // History replay
  // -----------------------------------------------------------------------
  "history_meta":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Metadata about history replay (total count, starting index)" },
  "history_prepend":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Batch of older history entries prepended to timeline" },
  "history_done":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "History replay finished, includes last usage stats" },

  // -----------------------------------------------------------------------
  // Chat / streaming
  // -----------------------------------------------------------------------
  "message":                  { direction: "c2s", handler: "lib/project-user-message.js", description: "Send a user chat message" },
  "member_message":           { direction: "c2s", handler: "lib/project-user-message.js", description: "Aigora: plain message to room members (never reaches an agent)" },
  "coaching_list":            { direction: "c2s", handler: "lib/project-prompt-coaching.js", description: "Aigora: the caller's own prompt-coaching history (never anyone else's)" },
  "coaching_share":           { direction: "c2s", handler: "lib/project-prompt-coaching.js", description: "Aigora: the author explicitly shares one coached prompt with the room" },
  "prompt_coaching":          { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: one prompt's rubric result, sent only to the author's sockets until the author shares it" },
  "prompt_coaching_history":  { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: the caller's own coaching history entries" },
  "coaching_shared":          { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: the author's share was committed" },
  "coaching_error":           { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: a coaching request was refused or failed" },
  "coaching_complete":        { direction: "c2s", handler: "lib/project-prompt-coaching.js", description: "Aigora: the author asks for one coached prompt to be completed by a single tool-less model call ({ id }); author only, 1 in flight, 30 per hour" },
  "coaching_completed":       { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: the completed instruction ({ mid, text, ts }), sent only to the author's own sockets" },
  "coaching_complete_error":  { direction: "s2c", handler: "lib/public/aigora/coaching.js", description: "Aigora: a completion was refused or failed ({ mid, code: forbidden | not_found | busy | rate_limited | unavailable | timeout | failed })" },
  "coaching_share_card":      { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: a shared prompt-improvement card in the room's main thread (never agent input)" },
  "attachment_card":          { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: a file attached to the room or a private channel, as a feed card (never agent input)" },
  "skill_notice":             { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: a short system line in the feed (skill switch, workspace backup skipped, workspace restored); never agent input" },
  "attachment_transcript":    { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: transcription state (running, done, failed; never the text) of an audio file's card; never agent input" },
  "attachment_card_removed":  { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: the file behind an attachment_card was deleted; the card is hidden" },
  "ai_result_files":          { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: the files an AI turn wrote to outbox/, as a result card (legacy: with a publish button; now only files that could not be posted) (names only, never agent input)" },
  "ai_result_published":      { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: one file of an ai_result_files card was published; the card marks it" },
  "shared_post_card":         { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: a shared result card in the room's main thread (never agent input)" },
  "user_message":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Echo of the user message in the timeline" },
  "delta":                    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Incremental text delta from the assistant" },
  "result":                   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Final assistant result text" },
  "status":                   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Processing status update (e.g. 'processing')" },
  "run_queue":                { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Run scheduler: this turn is waiting for a slot (position n, 1-based); 0 = no longer queued" },
  "done":                     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Query complete, includes exit code" },
  "error":                    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Error message from server" },
  "info":                     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Project info payload sent on connection" },
  "stderr":                   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "stderr output from Claude process" },
  "compacting":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Conversation compaction in progress (active: true/false)" },
  "message_uuid":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "UUID assigned to a user or assistant message" },
  "prompt_suggestion":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Suggested follow-up prompt from the assistant" },
  "context_preview":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Preview of context sources included in a query" },
  "orchestration_event":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Aigora orchestration run event + run snapshot, recorded in the root room conversation (lib/orchestration/engine.js)" },
  "route_decision":           { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora automatic model selection result for one request {routeId,forMid,from,decision:{abstain,reason,agent,option,top},_ts}, recorded in the root room conversation (lib/orchestration/engine.js); rendered as the chip by the standalone Aigora client only" },
  "run_feedback":             { direction: "c2s", handler: "lib/project-user-message.js", description: "Aigora: thumbs up/down {routeId,value:1|-1} on an automatically routed request; accepted only from the member who sent it, once" },
  "run_feedback_ack":         { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora: the stored feedback value {routeId,value} for the requesting member only" },
  "orchestration_answer":     { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Aigora orchestration final answer {runId,stepId,stepRole?,verdict?,agent,label?,text,_mid,_ts}, recorded once in the root room conversation (lib/orchestration/engine.js); rendered by the standalone Aigora client only" },
  // lr-66c118 fold-in: found missing from this schema by the new CI
  // absence-invariant (test/activity-state-lr-66c118.test.js) that scans
  // every real sendAndRecord(session, { type: "..." }) call site — these 4
  // were live, sent types with no documentation entry.
  "plan_content":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Plan-mode content for the plan card" },
  "sdk_notification":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Informational notification surfaced from the vendor SDK" },
  "diagnostic":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Session-scoped diagnostic toast (settings preflight, memory shedding, adapter warnings)" },

  // -----------------------------------------------------------------------
  // Thinking
  // -----------------------------------------------------------------------
  "thinking_start":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Assistant started a thinking block" },
  "thinking_delta":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Incremental thinking text delta" },
  "thinking_stop":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Thinking block finished, includes duration" },

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------
  "tool_start":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Assistant started a tool use block" },
  "tool_executing":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Tool is executing with parsed input" },
  "tool_result":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Tool execution result" },
  "slash_command_result":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Output of a slash command" },

  // -----------------------------------------------------------------------
  // Subagents / tasks
  // -----------------------------------------------------------------------
  "subagent_activity":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Activity indicator for a subagent" },
  "subagent_tool":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Subagent tool use event" },
  "subagent_done":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Subagent task completed" },
  "team_state":               { direction: "s2c", handler: "lib/public/modules/team-panel.js", description: "Full team snapshot: members, tasks, state" },
  "team_member_update":       { direction: "s2c", handler: "lib/public/modules/team-panel.js", description: "Single teammate liveness/activity change" },
  "team_task_update":         { direction: "s2c", handler: "lib/public/modules/team-panel.js", description: "Shared task state change" },
  "team_message":             { direction: "s2c", handler: "lib/public/modules/team-panel.js", description: "Teammate SendMessage event (peer DM)" },
  "team_gone":                { direction: "s2c", handler: "lib/public/modules/team-panel.js", description: "Team was deleted/cleaned up" },
  "team_request_state":       { direction: "c2s", handler: "lib/project-team.js", description: "Client requests current team snapshot" },
  "task_started":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Background task started" },
  "task_progress":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Background task progress update" },
  // lr-66c118 fold-in: see the plan_content/sdk_notification/diagnostic note above.
  "task_updated":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Background task status/description patch" },

  // -----------------------------------------------------------------------
  // Permissions
  // -----------------------------------------------------------------------
  "permission_request":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Tool permission request from assistant" },
  "permission_request_pending": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Permission request that was pending when client connected" },
  "permission_response":      { direction: "c2s", handler: "lib/project-sessions.js", description: "User response to a permission request" },
  "permission_resolved":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Permission request resolved" },
  "permission_cancel":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Permission request cancelled (e.g. interrupted)" },

  // -----------------------------------------------------------------------
  // Ask user (interactive input)
  // -----------------------------------------------------------------------
  "ask_user":                 { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Assistant is requesting user input via ask_user tool" },
  "ask_user_response":        { direction: "c2s", handler: "lib/project-sessions.js", description: "User reply to an ask_user request" },
  "ask_user_answered":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Confirmation that ask_user was answered" },

  // -----------------------------------------------------------------------
  // Elicitation
  // -----------------------------------------------------------------------
  "elicitation_request":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Structured form elicitation request from assistant" },
  "elicitation_response":     { direction: "c2s", handler: "lib/project-sessions.js", description: "User response to an elicitation form" },
  "elicitation_resolved":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Elicitation request resolved" },

  // -----------------------------------------------------------------------
  // Stop / control
  // -----------------------------------------------------------------------
  "stop":                     { direction: "c2s", handler: "lib/project-sessions.js", description: "Stop the current assistant query" },
  "stop_task":                { direction: "c2s", handler: "lib/project-sessions.js", description: "Stop a specific background task by ID" },
  "kill_process":             { direction: "c2s", handler: "lib/project-sessions.js", description: "Kill a system process by PID" },
  "process_killed":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Process was successfully killed" },
  "process_conflict":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Conflict: another process is using the session" },

  // -----------------------------------------------------------------------
  // Context / usage
  // -----------------------------------------------------------------------
  "context_usage":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Token usage and context window stats" },
  "context_overflow":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Conversation too long to continue" },

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------
  "auth_required":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Authentication required (e.g. API key needed)" },

  // -----------------------------------------------------------------------
  // Rate limiting / scheduling
  // -----------------------------------------------------------------------
  "rate_limit":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rate limit hit, includes wait time" },
  "rate_limit_usage":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Current rate limit usage stats" },
  "schedule_message":         { direction: "c2s", handler: "lib/project-user-message.js", description: "Schedule a message to be sent at a future time" },
  "send_scheduled_now":       { direction: "c2s", handler: "lib/project-user-message.js", description: "Send the scheduled message immediately" },
  "cancel_scheduled_message": { direction: "c2s", handler: "lib/project-user-message.js", description: "Cancel the pending scheduled message" },
  "scheduled_message_queued": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Scheduled message has been queued" },
  "scheduled_message_sent":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Scheduled message was sent" },
  "scheduled_message_cancelled": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Scheduled message was cancelled" },
  "auto_continue_scheduled":  { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Auto-continue was scheduled after rate limit" },
  "auto_continue_fired":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Auto-continue timer fired" },

  // -----------------------------------------------------------------------
  // Model / config
  // -----------------------------------------------------------------------
  "set_model":                { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the model for the current session" },
  "set_server_default_model": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the server-wide default model" },
  "set_project_default_model": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the project default model" },
  "set_permission_mode":      { direction: "c2s", handler: "lib/project-sessions.js", description: "Set permission mode for the current session" },
  "set_server_default_mode":  { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the server-wide default permission mode" },
  "set_project_default_mode": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the project default permission mode" },
  "set_effort":               { direction: "c2s", handler: "lib/project-sessions.js", description: "Set effort level for the current session" },
  "set_server_default_effort": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the server-wide default effort level" },
  "set_project_default_effort": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the project default effort level" },
  "set_betas":                { direction: "c2s", handler: "lib/project-sessions.js", description: "Set beta feature flags (session-only, not persisted)" },
  "set_server_default_betas": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set and persist the server-wide default beta flags" },
  "set_project_default_betas": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set and persist the project default beta flags" },
  "set_thinking":             { direction: "c2s", handler: "lib/project-sessions.js", description: "Set thinking mode and budget" },
  "model_info":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Current model and available models list" },
  "config_state":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full config state: model, mode, effort, betas, thinking" },
  "slash_commands":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Available slash commands list" },
  "fast_mode_state":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Fast mode toggle state" },
  "client_count":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Number of connected clients" },

  // -----------------------------------------------------------------------
  // Rewind
  // -----------------------------------------------------------------------
  "rewind_preview":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Request a preview of rewinding to a message UUID" },
  "rewind_execute":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Execute the rewind to a message UUID" },
  "rewind_preview_result":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rewind preview data and diffs" },
  "rewind_complete":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rewind executed successfully" },
  "rewind_error":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rewind failed" },

  // -----------------------------------------------------------------------
  // Cursors / presence
  // -----------------------------------------------------------------------
  "cursor_move":              { direction: "both", handler: "lib/project-sessions.js", description: "Cursor position update from a user" },
  "cursor_leave":             { direction: "both", handler: "lib/project-sessions.js", description: "User cursor left the viewport" },
  "text_select":              { direction: "both", handler: "lib/project-sessions.js", description: "Text selection ranges from a user" },

  // -----------------------------------------------------------------------
  // Push notifications
  // -----------------------------------------------------------------------
  "push_subscribe":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Register a push notification subscription" },

  // -----------------------------------------------------------------------
  // Updates
  // -----------------------------------------------------------------------
  "set_update_channel":       { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the update channel (stable/beta)" },
  "check_update":             { direction: "c2s", handler: "lib/project-sessions.js", description: "Check if an update is available" },
  "update_now":               { direction: "c2s", handler: "lib/project-sessions.js", description: "Start the update process" },
  "update_available":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A new version is available" },
  "up_to_date":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Server is already on the latest version" },
  "update_started":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Update download/install has started" },

  // -----------------------------------------------------------------------
  // Process stats
  // -----------------------------------------------------------------------
  "process_stats":            { direction: "both", handler: "lib/project-sessions.js", description: "Request (c2s) or response (s2c) of system process stats" },

  // -----------------------------------------------------------------------
  // Server settings / daemon
  // -----------------------------------------------------------------------
  "get_daemon_config":        { direction: "c2s", handler: "lib/project-sessions.js", description: "Request daemon configuration" },
  "daemon_config":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Daemon configuration payload" },
  "set_pin":                  { direction: "c2s", handler: "lib/project-sessions.js", description: "Set or clear the server access PIN" },
  "set_pin_result":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "PIN set result" },
  "set_keep_awake":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Enable or disable keep-awake" },
  "set_keep_awake_result":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Keep-awake setting result" },
  "keep_awake_changed":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: keep-awake state changed" },
  "set_auto_continue":        { direction: "c2s", handler: "lib/project-sessions.js", description: "Enable or disable auto-continue on rate limit" },
  "set_auto_continue_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Auto-continue setting result" },
  "auto_continue_changed":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: auto-continue state changed" },
  "set_image_retention":      { direction: "c2s", handler: "lib/project-sessions.js", description: "Set image retention period in days" },
  "set_image_retention_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Image retention setting result" },
  "set_mem_available_threshold": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the minimum available memory threshold (MB) for new queries" },
  "set_mem_available_threshold_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "MemAvailable threshold setting result" },
  "mem_available_threshold_changed": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: MemAvailable threshold changed" },
  "set_tokens_per_mb_headroom": { direction: "c2s", handler: "lib/project-sessions.js", description: "Set the context token density per MB of cgroup headroom" },
  "set_tokens_per_mb_headroom_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Tokens per MB headroom setting result" },
  "tokens_per_mb_headroom_changed": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: tokens per MB headroom setting changed" },
  "shutdown_server":          { direction: "c2s", handler: "lib/project-sessions.js", description: "Request server shutdown" },
  "shutdown_server_result":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Shutdown request result" },
  "restart_server":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Request server restart" },
  "restart_server_result":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Restart request result" },
  "toast":                    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Ephemeral toast notification" },

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------
  "browse_dir":               { direction: "c2s", handler: "lib/project-sessions.js", description: "Browse directory entries for project creation" },
  "browse_dir_result":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Directory listing result" },
  "add_project":              { direction: "c2s", handler: "lib/project-sessions.js", description: "Add an existing directory as a project" },
  "add_project_result":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Add project result" },
  "create_project":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Create a new empty project directory" },
  "clone_project":            { direction: "c2s", handler: "lib/project-sessions.js", description: "Clone a git repository as a new project" },
  "clone_project_progress":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Git clone progress indicator" },
  "create_worktree":          { direction: "c2s", handler: "lib/project-sessions.js", description: "Create a git worktree branch as a new project" },
  "create_worktree_result":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Worktree creation result" },
  "remove_project_check":     { direction: "c2s", handler: "lib/project-sessions.js", description: "Check how many schedules a project has before removal" },
  "remove_project_check_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Schedule count for project about to be removed" },
  "remove_project":           { direction: "c2s", handler: "lib/project-sessions.js", description: "Remove a project" },
  "remove_project_result":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Remove project result" },
  "reorder_projects":         { direction: "c2s", handler: "lib/project-sessions.js", description: "Reorder project list by slug array" },
  "reorder_projects_result":  { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Reorder result" },
  "set_project_title":        { direction: "c2s", handler: "lib/project-sessions.js", description: "Rename a project" },
  "set_project_title_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rename project result" },
  "set_project_icon":         { direction: "c2s", handler: "lib/project-sessions.js", description: "Set or clear a project emoji icon" },
  "set_project_icon_result":  { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Set icon result" },
  "set_project_preferred_agent":        { direction: "c2s", handler: "lib/project-sessions.js", description: "Set or clear the preferred agent for a project" },
  "set_project_preferred_agent_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Set preferred agent result" },
  "set_project_folder":       { direction: "c2s", handler: "lib/project-sessions.js", description: "Move a project into a named folder, or clear its folder (null)" },
  "set_project_folder_result":{ direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Set project folder result" },
  "rename_project_folder":    { direction: "c2s", handler: "lib/project-sessions.js", description: "Rename a folder across all projects that share it" },
  "rename_project_folder_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Rename folder result" },
  "set_folder_icon":          { direction: "c2s", handler: "lib/project-sessions.js", description: "Set or clear the emoji icon for a named folder" },
  "set_folder_icon_result":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Set folder icon result" },
  "rename_custom_icon":       { direction: "c2s", handler: "lib/project-sessions.js", description: "Rename a custom-icon upload (oldSlug -> newSlug), rewriting all project/folder references atomically" },
  "rename_custom_icon_result": { direction: "s2c", handler: "lib/public/modules/custom-icons-settings.js", description: "Custom icon rename result" },
  "transfer_project_owner":   { direction: "c2s", handler: "lib/project-sessions.js", description: "Transfer project ownership to another user" },
  "project_owner_changed":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Project ownership was transferred" },
  "message_ack":              { direction: "s2c", handler: "lib/public/aigora/chat-model.js", description: "Stable _mid of the message the sender just posted (comment/pin anchor)" },
  "social_state":             { direction: "s2c", handler: "lib/public/aigora/social.js", description: "Room comments and mention roster for the active session, room pins, accessible notifications and preferences" },
  "comment_event":            { direction: "s2c", handler: "lib/public/aigora/social.js", description: "A comment was added, edited or deleted in a room the user belongs to" },
  "pin_event":                { direction: "s2c", handler: "lib/public/aigora/social.js", description: "A pin was added or removed in a room the user belongs to" },
  "social_notif":             { direction: "s2c", handler: "lib/public/aigora/social.js", description: "A per-user comment/reply or message-mention notification" },
  "notif_state":              { direction: "s2c", handler: "lib/public/aigora/social.js", description: "Unread comment-notification count after mark-read, or the caller's updated preferences" },
  "social_error":             { direction: "s2c", handler: "lib/public/aigora/social.js", description: "A comment/pin request was refused (permission, limit, invalid input); shown as a toast" },
  // Room skills v1 (docs/superpowers/specs/2026-10-03-room-skills-plugins.md); all answer "disabled" while roomSkills.enabled is off.
  "skills_list":             { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora: the catalog with this room's (or the caller's private-channel) enablement; answers skills_state" },
  "skill_detail":            { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora: full read-only text of one catalog skill (any room member)" },
  "skill_toggle":            { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora: turn a catalog skill on/off for the room (owner/admin) or the caller's own private channels; applies from the next turn" },
  "skill_host_list":         { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: names (only) of the host's ~/.claude/skills" },
  "skill_install_zip":       { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: validate an uploaded ZIP into a draft awaiting review" },
  "skill_install_host":      { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: copy one picked host skill through the validator into a draft" },
  "skill_draft_get":         { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: a draft with the full text of every file" },
  "skill_approve":           { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: approve a reviewed draft into the catalog (new version of an existing skill needs a separate switch per scope)" },
  "skill_discard":           { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: discard a draft" },
  "skill_remove":            { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: remove a skill from the catalog and every scope" },
  "skill_git_fetch":         { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: pin a pasted GitHub link to a commit, fetch it (data only), validate every skill found; one valid skill goes to review, several answer skill_git_candidates" },
  "skill_git_pick":          { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: make drafts from the picked skills of a skill_git_candidates answer" },
  "skill_update_check":      { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: latest commit of a git-sourced skill's ref and a diff summary; answers skill_update_info" },
  "skill_update_apply":      { direction: "c2s", handler: "lib/project-skills.js", description: "Aigora admin: turn a checked update into a draft (a new version that still needs approval)" },
  "skill_git_progress":      { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "Aigora: progress step (resolve/fetch/scan) of a running GitHub fetch" },
  "skill_git_candidates":    { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "Aigora admin: the validated skills found in a GitHub link, pinned commit and ignored plugin parts" },
  "skill_git_picked":        { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "Aigora admin: several picked GitHub skills became drafts awaiting review" },
  "skill_update_info":       { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "Aigora admin: update check result for a git-sourced skill (up to date, or new commit with diff)" },
  "skills_state":            { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "Catalog + enablement for one room/scope, the caller's powers (canToggle, isAdmin), pending drafts (admin)" },
  "skills_changed":          { direction: "s2c", handler: "lib/public/aigora/skills.js", description: "The catalog or a room's skills changed: re-request skills_list" },
  "post_share":              { direction: "c2s", handler: "lib/project-shared-posts.js", description: "Owner explicitly publishes selected private-session content to the room as an independent post" },
  "post_shared":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "The caller's explicit shared-post publication was committed" },
  "post_list":               { direction: "both", handler: "lib/public/modules/app-messages.js", serverHandler: "lib/project-shared-posts.js", description: "Request or receive the room's shared posts" },
  "post_event":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A committed shared post was added or deleted in the room" },
  "post_comment_added":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A human-only shared-post comment was accepted" },
  "post_pinned":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A shared-post pin was accepted" },
  "post_error":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A shared-post request was refused or failed" },
  "post_delete":             { direction: "c2s", handler: "lib/project-shared-posts.js", description: "Delete a shared post (author or room administrator)" },
  "post_comment":            { direction: "c2s", handler: "lib/project-shared-posts.js", description: "Human-only comment on a shared post" },
  "post_pin":                { direction: "c2s", handler: "lib/project-shared-posts.js", description: "Pin a shared post" },
  "social_get":               { direction: "c2s", handler: "lib/project-social.js", description: "Request comments, pins and notifications for the active session's room" },
  "comment_add":              { direction: "c2s", handler: "lib/project-social.js", description: "Add a human-only comment under a message or attachment" },
  "comment_edit":             { direction: "c2s", handler: "lib/project-social.js", description: "Edit own comment" },
  "comment_delete":           { direction: "c2s", handler: "lib/project-social.js", description: "Delete own comment (owner: any)" },
  "pin_add":                  { direction: "c2s", handler: "lib/project-social.js", description: "Pin a message, image or file in the room" },
  "pin_remove":               { direction: "c2s", handler: "lib/project-social.js", description: "Unpin (pinner or owner)" },
  "notif_read":               { direction: "c2s", handler: "lib/project-social.js", description: "Mark comment notifications read (ids or all)" },
  "notif_prefs":              { direction: "c2s", handler: "lib/project-social.js", description: "Set comment-notification preferences" },
  "rooms_state":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Club Agora rooms visible to this user (client contract; server emission pending, see docs/roadmaps/planned/CLUB-AGORA.md)" },
  "session_narration":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Observable-work learning timeline entries for a room's root session, derived from orchestration events (lib/orchestration/narration.js); provider trace only when marked provider_visible" },
  "projects_updated":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: project list changed" },
  "schedule_move":            { direction: "c2s", handler: "lib/project-sessions.js", description: "Move a schedule to a different project" },
  "schedule_move_result":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Schedule move result" },

  // -----------------------------------------------------------------------
  // Filesystem
  // -----------------------------------------------------------------------
  "fs_list":                  { direction: "c2s", handler: "lib/project-filesystem.js", description: "List directory contents" },
  "fs_list_result":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Directory listing result" },
  "fs_search":                { direction: "c2s", handler: "lib/project-filesystem.js", description: "Search files by name" },
  "fs_search_result":         { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "File search results" },
  "fs_read":                  { direction: "c2s", handler: "lib/project-filesystem.js", description: "Read file contents" },
  "fs_read_result":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "File content result" },
  "fs_write":                 { direction: "c2s", handler: "lib/project-filesystem.js", description: "Write file contents" },
  "fs_write_result":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "File write result" },
  "fs_delete":                { direction: "c2s", handler: "lib/project-filesystem.js", description: "Delete a file" },
  "fs_rename":                { direction: "c2s", handler: "lib/project-filesystem.js", description: "Rename a file" },
  "fs_mkdir":                 { direction: "c2s", handler: "lib/project-filesystem.js", description: "Create a directory" },
  "fs_upload":                { direction: "c2s", handler: "lib/project-filesystem.js", description: "Upload a file" },
  "fs_watch":                 { direction: "c2s", handler: "lib/project-filesystem.js", description: "Start watching a file for changes" },
  "fs_unwatch":               { direction: "c2s", handler: "lib/project-filesystem.js", description: "Stop watching a file" },
  "fs_file_changed":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Watched file content changed" },
  "fs_dir_changed":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Watched directory contents changed" },
  "fs_file_history":          { direction: "c2s", handler: "lib/project-filesystem.js", description: "Request git history for a file" },
  "fs_file_history_result":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Git file history entries" },
  "fs_git_diff":              { direction: "c2s", handler: "lib/project-filesystem.js", description: "Request a git diff for a commit/file" },
  "fs_git_diff_result":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Git diff result" },
  "fs_file_at":               { direction: "c2s", handler: "lib/project-filesystem.js", description: "Read a file at a specific git commit hash" },
  "fs_file_at_result":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "File content at a specific commit" },

  // -----------------------------------------------------------------------
  // Project env / CLAUDE.md
  // -----------------------------------------------------------------------
  "get_project_env":          { direction: "c2s", handler: "lib/project-filesystem.js", description: "Read the project .envrc" },
  "project_env_result":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Project .envrc content" },
  "set_project_env":          { direction: "c2s", handler: "lib/project-filesystem.js", description: "Write the project .envrc" },
  "set_project_env_result":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Project .envrc write result" },
  "read_global_claude_md":    { direction: "c2s", handler: "lib/project-filesystem.js", description: "Read the global CLAUDE.md" },
  "global_claude_md_result":  { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Global CLAUDE.md content" },
  "write_global_claude_md":   { direction: "c2s", handler: "lib/project-filesystem.js", description: "Write the global CLAUDE.md" },
  "write_global_claude_md_result": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Global CLAUDE.md write result" },
  "get_shared_env":           { direction: "c2s", handler: "lib/project-filesystem.js", description: "Read the shared .envrc" },
  "shared_env_result":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Shared .envrc content" },
  "set_shared_env":           { direction: "c2s", handler: "lib/project-filesystem.js", description: "Write the shared .envrc" },
  "set_shared_env_result":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Shared .envrc write result" },

  // -----------------------------------------------------------------------
  // Context sources
  // -----------------------------------------------------------------------
  "context_sources_save":     { direction: "c2s", handler: "lib/project-user-message.js", description: "Save active context source configuration" },
  "context_sources_state":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Current active context sources list" },

  // -----------------------------------------------------------------------
  // Terminal
  // -----------------------------------------------------------------------
  "term_create":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Create a new terminal session" },
  "term_created":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal was created, includes ID" },
  "term_attach":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Attach to a terminal to receive output" },
  "term_detach":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Detach from a terminal" },
  "term_input":               { direction: "c2s", handler: "lib/project-user-message.js", description: "Send input to a terminal" },
  "term_resize":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Resize a terminal" },
  "term_close":               { direction: "c2s", handler: "lib/project-user-message.js", description: "Close a terminal session" },
  "term_rename":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Rename a terminal tab" },
  "term_output":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal output data" },
  "term_resized":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal was resized" },
  "term_exited":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal process exited" },
  "term_closed":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal session was closed" },
  "term_list":                { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full list of open terminals" },
  "term_error":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Terminal error (e.g. access denied)" },

  // -----------------------------------------------------------------------
  // Sticky notes
  // -----------------------------------------------------------------------
  "note_create":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Create a new sticky note" },
  "note_created":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Sticky note was created" },
  "note_update":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Update a sticky note" },
  "note_updated":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Sticky note was updated" },
  "note_delete":              { direction: "c2s", handler: "lib/project-user-message.js", description: "Delete a sticky note" },
  "note_deleted":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Sticky note was deleted" },
  "note_list_request":        { direction: "c2s", handler: "lib/project-user-message.js", description: "Request the full notes list" },
  "note_bring_front":         { direction: "c2s", handler: "lib/project-user-message.js", description: "Bring a note to front (update z-order)" },
  "notes_list":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full list of sticky notes" },

  // -----------------------------------------------------------------------
  // Browser extension
  // -----------------------------------------------------------------------
  "browser_tab_list":         { direction: "c2s", handler: "lib/project-user-message.js", description: "Provide browser tab list from the extension" },
  "extension_result":         { direction: "c2s", handler: "lib/project-user-message.js", description: "Result from a browser extension command" },
  "extension_command":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Command for the browser extension to execute" },
  "aigora_ext_tab_list":      { direction: "s2c", handler: "lib/public/modules/app-misc.js", description: "Browser tab list from the extension (broadcast)" },
  "aigora_ext_result":        { direction: "s2c", handler: "lib/public/modules/app-misc.js", description: "Browser extension command result (broadcast)" },
  "aigora_ext_command":       { direction: "c2s", handler: "lib/public/modules/app-misc.js", description: "Send a command to the browser extension" },

  // -----------------------------------------------------------------------
  // MCP Bridge (remote MCP servers via Chrome Extension)
  // -----------------------------------------------------------------------
  "mcp_servers_available":    { direction: "c2s", handler: "lib/project-mcp.js", description: "Report available MCP servers from Chrome Extension" },
  "mcp_tool_call":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Forward MCP tool call to extension or HTTP endpoint" },
  "mcp_tool_result":          { direction: "c2s", handler: "lib/project-mcp.js", description: "Return MCP tool result from extension" },
  "mcp_tool_error":           { direction: "c2s", handler: "lib/project-mcp.js", description: "Return MCP tool error from extension" },
  "mcp_toggle_server":        { direction: "c2s", handler: "lib/project-mcp.js", description: "Toggle MCP server enabled state for this project" },
  "mcp_servers_state":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast MCP server list and enabled state to clients" },

  // -----------------------------------------------------------------------
  // Skills
  // -----------------------------------------------------------------------
  "skill_installed":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Skill was installed" },
  "skill_uninstalled":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Skill was uninstalled" },

  // -----------------------------------------------------------------------
  // DMs (direct messages — human-to-human in multi-user mode)
  // -----------------------------------------------------------------------
  "dm_list":                  { direction: "both", handler: "lib/server-dm.js", description: "Request (c2s) or receive (s2c) DM conversation list" },
  "dm_open":                  { direction: "c2s", handler: "lib/server-dm.js", description: "Open a DM conversation with a user" },
  "dm_history":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "DM conversation history" },
  "dm_send":                  { direction: "c2s", handler: "lib/server-dm.js", description: "Send a DM message" },
  "dm_message":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Incoming DM message" },
  "dm_typing":                { direction: "both", handler: "lib/server-dm.js", description: "DM typing indicator" },
  "dm_add_favorite":          { direction: "c2s", handler: "lib/server-dm.js", description: "Add a user to DM favorites" },
  "dm_remove_favorite":       { direction: "c2s", handler: "lib/server-dm.js", description: "Remove a user from DM favorites" },
  "dm_favorites_updated":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "DM favorites list updated" },

  // -----------------------------------------------------------------------
  // Knowledge (project knowledge files)
  // -----------------------------------------------------------------------
  "knowledge_list":           { direction: "both", handler: "lib/project-knowledge.js", description: "Request (c2s) or receive (s2c) knowledge file list" },
  "knowledge_read":           { direction: "c2s", handler: "lib/project-knowledge.js", description: "Read a knowledge file" },
  "knowledge_content":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Knowledge file content" },
  "knowledge_save":           { direction: "c2s", handler: "lib/project-knowledge.js", description: "Save a knowledge file" },
  "knowledge_saved":          { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Knowledge file was saved" },
  "knowledge_delete":         { direction: "c2s", handler: "lib/project-knowledge.js", description: "Delete a knowledge file" },
  "knowledge_deleted":        { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Knowledge file was deleted" },

  // -----------------------------------------------------------------------
  // Loop (automated task runner)
  // -----------------------------------------------------------------------
  "loop_start":               { direction: "c2s", handler: "lib/project-loop.js", description: "Start the loop runner" },
  "loop_stop":                { direction: "c2s", handler: "lib/project-loop.js", description: "Stop the running loop" },
  "loop_available":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop configuration is available" },
  "loop_started":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop has started running" },
  "loop_iteration":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop iteration progress update" },
  "loop_judging":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop is running the judge step" },
  "loop_verdict":             { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Judge verdict for a loop iteration" },
  "loop_stopping":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop is in the process of stopping" },
  "loop_finished":            { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop has finished" },
  "loop_error":               { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop error" },
  "loop_scheduled":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop was scheduled via cron" },
  "loop_rerun_started":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A loop registry entry re-run has started" },
  "loop_message":             { direction: "c2s", handler: "lib/project-loop.js", description: "Queue a human message for delivery at the next loop iteration boundary" },
  "loop_message_error":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop message could not be queued (e.g. no loop running)" },
  "loop_pending_messages":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Current list of human messages queued for the next loop iteration" },

  // -----------------------------------------------------------------------
  // Loop registry (task schedule management)
  // -----------------------------------------------------------------------
  "loop_registry_list":       { direction: "c2s", handler: "lib/project-loop.js", description: "Request the loop registry list" },
  "loop_registry_update":     { direction: "c2s", handler: "lib/project-loop.js", description: "Update a loop registry entry" },
  "loop_registry_rename":     { direction: "c2s", handler: "lib/project-loop.js", description: "Rename a loop registry entry" },
  "loop_registry_remove":     { direction: "c2s", handler: "lib/project-loop.js", description: "Remove a loop registry entry" },
  "loop_registry_convert":    { direction: "c2s", handler: "lib/project-loop.js", description: "Convert a loop registry entry type" },
  "loop_registry_toggle":     { direction: "c2s", handler: "lib/project-loop.js", description: "Toggle a loop registry entry on/off" },
  "loop_registry_rerun":      { direction: "c2s", handler: "lib/project-loop.js", description: "Re-run a loop registry entry" },
  "loop_registry_files":      { direction: "c2s", handler: "lib/project-loop.js", description: "Request loop registry file contents (PROMPT.md / JUDGE.md)" },
  "loop_registry_files_content": { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop registry file contents" },
  "loop_registry_updated":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Broadcast: loop registry was updated" },
  "loop_registry_error":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop registry operation error" },
  "delete_loop_group":        { direction: "c2s", handler: "lib/project-loop.js", description: "Delete all sessions for a loop group" },

  // -----------------------------------------------------------------------
  // Schedules (hub-level)
  // -----------------------------------------------------------------------
  "schedule_create":          { direction: "c2s", handler: "lib/project-loop.js", description: "Create a new schedule" },
  "hub_schedules_list":            { direction: "c2s", handler: "lib/project-loop.js", description: "Request the hub schedules list" },
  "hub_schedules":                 { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Hub schedules list" },
  "hub_recent_sessions_list":      { direction: "c2s", handler: "lib/project-loop.js", description: "Request cross-project recent sessions for hub" },
  // lr-66c118: each session item now also carries ownerId (added alongside
  // isProcessing/unread) so the Home Hub Recent Sessions dot can render the
  // multi-user 'other' tone via activity-state.js, same as session_list.
  "hub_recent_sessions":           { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Cross-project recent sessions list for hub" },
  "schedule_run_started":     { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A scheduled run has started" },
  "schedule_run_finished":    { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "A scheduled run has finished" },

  // -----------------------------------------------------------------------
  // Ralph (loop wizard / crafting)
  // -----------------------------------------------------------------------
  "ralph_wizard_complete":    { direction: "c2s", handler: "lib/project-loop.js", description: "Submit completed wizard data" },
  "ralph_wizard_cancel":      { direction: "c2s", handler: "lib/project-loop.js", description: "Cancel the wizard" },
  "ralph_preview_files":      { direction: "c2s", handler: "lib/project-loop.js", description: "Request preview of loop files" },
  "ralph_cancel_crafting":    { direction: "c2s", handler: "lib/project-loop.js", description: "Cancel file crafting in progress" },
  "ralph_phase":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Current ralph wizard phase" },
  "ralph_crafting_started":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "File crafting session started" },
  "ralph_files_status":       { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Prompt/judge file readiness status" },
  "ralph_files_content":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Loop file contents (prompt and judge)" },

  // -----------------------------------------------------------------------
  // Agents (SDK catalog + project-local)
  // -----------------------------------------------------------------------
  "list_agents":              { direction: "c2s", handler: "lib/project-sessions.js", description: "Request SDK agent catalog with favorites and recents" },
  "agents_list":              { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Full agent catalog with favorites and recents" },
  "toggle_agent_favorite":    { direction: "c2s", handler: "lib/project-sessions.js", description: "Toggle an agent in/out of favorites" },
  "agent_favorite_toggled":   { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Favorite toggle confirmation" },
  "get_agents":               { direction: "c2s", handler: "lib/project-sessions.js", description: "Request project-local agents from .claude/agents/ (lr-c1a2)" },
  "project_agents_list":      { direction: "s2c", handler: "lib/public/modules/app-messages.js", description: "Project-local agent list for @ mention dropdown (lr-c1a2)" }
};

module.exports = { schema: schema };
