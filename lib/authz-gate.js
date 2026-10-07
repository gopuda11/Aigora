// Shared authorization gate for WebSocket messages that change server-wide,
// project-wide or host-level state (or read env / CLAUDE.md). One table, one
// helper, called at the top of every message handler that owns such a type.
//
// Single-user / no-auth mode (no ws._aigoraUser) is never restricted.

var ADMIN_ONLY = {};
("set_server_default_model set_server_default_effort set_server_default_mode set_server_default_betas " +
 "set_project_default_model set_project_default_effort set_project_default_mode set_project_default_betas " +
 "set_betas set_thinking set_codex_approval set_codex_sandbox set_codex_websearch " +
 "set_update_channel check_update update_now restart_server shutdown_server restart_for_build_update " +
 "set_keep_awake set_image_retention set_mem_available_threshold set_tokens_per_mb_headroom set_pin " +
 "set_auto_continue set_lite_auto_enroll lite_enroll_project lite_unenroll_project get_daemon_config kill_process " +
 "create_worktree set_project_title set_project_icon set_project_folder set_project_preferred_agent " +
 "set_folder_icon rename_custom_icon rename_project_folder reorder_projects transfer_project_owner " +
 "get_project_env set_project_env get_shared_env set_shared_env read_global_claude_md write_global_claude_md " +
 "mcp_toggle_server mcp_servers_available mcp_tool_result mcp_tool_error " +
 "skill_host_list skill_install_host skill_update_check skill_update_apply").split(" ").forEach(function (t) { ADMIN_ONLY[t] = true; });

// Host filesystem / project creation: need the createProject permission (admin always has it).
var NEEDS_CREATE_PROJECT = { add_project: 1, browse_dir: 1, clone_project: 1, create_project: 1 };

// File browser: need the fileBrowser permission.
var NEEDS_FILE_BROWSER = {};
"fs_list fs_read fs_write fs_delete fs_rename fs_mkdir fs_upload fs_search fs_file_at fs_git_diff fs_watch fs_unwatch fs_file_history"
  .split(" ").forEach(function (t) { NEEDS_FILE_BROWSER[t] = true; });

// Modes a non-admin may pick for a session. acceptEdits / bypassPermissions auto-allow tools.
var MEMBER_MODES = { "default": true, "plan": true };

function isAdmin(ws) { return !!ws._aigoraUser && ws._aigoraUser.role === "admin"; }

// Returns null when allowed, else { text, replyType } describing the refusal.
function checkMessage(ws, msg, usersModule, osUsers) {
  var user = ws && ws._aigoraUser;
  if (!user) return null;
  var type = msg && msg.type;
  if (ADMIN_ONLY[type] && user.role !== "admin") return { text: "Admin access required", replyType: "error" };
  var perm = NEEDS_CREATE_PROJECT[type] ? "createProject" : NEEDS_FILE_BROWSER[type] ? "fileBrowser" : null;
  if (perm) {
    var perms = usersModule.getEffectivePermissions(user, osUsers);
    if (!perms[perm]) {
      return perm === "createProject"
        ? { text: "You do not have permission to create projects", replyType: type === "browse_dir" ? "browse_dir_result" : "add_project_result" }
        : { text: "File browser access is not permitted", replyType: type + "_result" };
    }
  }
  return null;
}

// Gate + reply. Returns true when the message was refused (caller must stop and return true).
function deny(ws, msg, sendTo, usersModule, osUsers) {
  var refusal = checkMessage(ws, msg, usersModule, osUsers);
  if (!refusal) return false;
  if (refusal.replyType === "error") sendTo(ws, { type: "error", text: refusal.text });
  else if (refusal.replyType === "browse_dir_result") sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: refusal.text });
  else if (refusal.replyType === "add_project_result") sendTo(ws, { type: "add_project_result", ok: false, error: refusal.text });
  else sendTo(ws, { type: refusal.replyType, error: refusal.text });
  return true;
}

// Non-admins in multi-user mode may only choose default or plan.
function modeAllowed(ws, mode) {
  return !ws._aigoraUser || isAdmin(ws) || !!MEMBER_MODES[mode];
}

// Strip a permissionMode a non-admin may not choose from loop settings.
function sanitizeLoopSettings(ws, settings) {
  if (!settings || typeof settings !== "object" || settings.permissionMode === undefined || modeAllowed(ws, settings.permissionMode)) return settings;
  var clean = Object.assign({}, settings);
  delete clean.permissionMode;
  return clean;
}

module.exports = { ADMIN_ONLY: ADMIN_ONLY, NEEDS_CREATE_PROJECT: NEEDS_CREATE_PROJECT, NEEDS_FILE_BROWSER: NEEDS_FILE_BROWSER,
  checkMessage: checkMessage, deny: deny, modeAllowed: modeAllowed, sanitizeLoopSettings: sanitizeLoopSettings };
