// private-message-classes.js - how every client message type treats a
// channel-bound session. Only the owner may run an "active" or "byid" type
// against one; the current room administrator may read it but never drive it.
//   active   acts on / executes in / controls the sender's active session
//   byid     acts on the session(s) named in msg fields (see BY_ID)
//   guarded  has its own per-target guard (loops, social, delete, resume); permission_response authorizes by
//            requestId in its handler (an admin decides for a private session, never its owner)
//   read     only reads or navigates (already filtered per recipient)
//   global   not derived from a session (project, user or server level)
// test/private-mutation-guard.test.js fails when a handler type is missing here.

var DENIED_TEXT = "Only the owner can change a private session";

var BY_ID = {
  rename_session: ["id"], delete_session: ["id"], set_session_agent: ["sessionId"],
  set_session_visibility: ["sessionId"], set_session_bookmark: ["sessionId"],
  reorder_session_bookmarks: ["sourceId", "targetId"],
};

var CLASSES = {};
function put(cls, names) { names.split(/\s+/).forEach(function (n) { if (n) CLASSES[n] = cls; }); }
put("active", "message member_message stop stop_task set_model set_vendor set_permission_mode set_effort rewind_preview rewind_execute fork_session " +
  "ask_user_response elicitation_response user_mention context_sources_save schedule_message " +
  "cancel_scheduled_message send_scheduled_now input_sync");
put("byid", Object.keys(BY_ID).join(" "));
put("guarded", "bulk_delete_sessions resume_session loop_start loop_stop schedule_create schedule_move loop_registry_convert " +
  "loop_registry_files loop_registry_list loop_registry_remove loop_registry_rename loop_registry_rerun loop_registry_save_files " +
  "loop_registry_toggle loop_registry_update loop_message loop_message_remove delete_loop_group ralph_cancel_crafting " +
  "ralph_preview_files ralph_wizard_cancel ralph_wizard_complete comment_add comment_delete comment_edit notif_prefs pin_add " +
  "pin_remove social_get run_feedback permission_response");
put("read", "switch_session load_more_history cursor_move cursor_leave text_select search_sessions search_session_content " +
  "list_cli_sessions fs_file_history process_stats");
put("global", "add_project browse_dir check_update clone_project create_project create_worktree get_agents get_daemon_config " +
  "get_lite_project_status kill_process lite_enroll_project lite_unenroll_project list_agents refresh_agents remove_project " +
  "remove_project_check rename_custom_icon rename_project_folder reorder_projects restart_for_build_update restart_server " +
  "shutdown_server set_auto_continue set_folder_icon set_image_retention set_keep_awake set_lite_auto_enroll " +
  "set_mem_available_threshold set_pin set_project_default_betas set_project_default_effort set_project_default_mode " +
  "set_project_default_model set_project_folder set_project_icon set_project_preferred_agent set_project_title " +
  "set_server_default_betas set_server_default_effort set_server_default_mode set_server_default_model " +
  "set_tokens_per_mb_headroom set_update_channel set_betas set_thinking set_codex_approval set_codex_sandbox set_codex_websearch " +
  "toggle_agent_favorite transfer_project_owner push_subscribe mark_cross_project_read new_session open_room_main " +
  "browser_tab_list extension_result note_bring_front note_create note_delete note_list_request note_update " +
  "term_attach term_close term_create term_detach term_input term_rename term_resize " +
  "fs_delete fs_file_at fs_git_diff fs_list fs_mkdir fs_read fs_rename fs_search fs_unwatch fs_upload fs_watch fs_write " +
  "update_now get_project_env get_shared_env read_global_claude_md set_project_env set_shared_env write_global_claude_md " +
  "hub_recent_sessions_list hub_schedules_list mcp_servers_available mcp_toggle_server mcp_tool_error mcp_tool_result " +
  "knowledge_delete knowledge_list knowledge_read knowledge_save team_request_state notification_dismiss notification_dismiss_all " +
  "post_comment post_delete post_list post_share skills_list skill_detail skill_toggle skill_host_list skill_install_zip skill_install_host skill_draft_get skill_approve skill_discard skill_remove skill_git_fetch skill_git_pick skill_update_check skill_update_apply coaching_list coaching_share coaching_complete dm_add_favorite dm_list dm_open dm_remove_favorite dm_send dm_typing get_vendor_models");

// Sessions a message would act on: the active one, or those named by id.
function targetsOf(msg, active, sessions) {
  var cls = CLASSES[msg && msg.type];
  if (cls === "active") return active ? [active] : [];
  if (cls !== "byid") return [];
  return BY_ID[msg.type].map(function (f) { return sessions.get(msg[f]); }).filter(Boolean);
}

module.exports = { CLASSES: CLASSES, DENIED_TEXT: DENIED_TEXT, targetsOf: targetsOf };
