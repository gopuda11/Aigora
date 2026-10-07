// --- Per-user RBAC permissions (default values for regular users) ---
var DEFAULT_PERMISSIONS = {
  terminal: false,
  fileBrowser: false,
  createProject: false,
  deleteProject: false,
  skills: true,
  sessionDelete: false,
  scheduledTasks: false,
  projectSettings: false,
};

var ALL_PERMISSIONS = {
  terminal: true,
  fileBrowser: true,
  createProject: true,
  deleteProject: true,
  skills: true,
  sessionDelete: true,
  scheduledTasks: true,
  projectSettings: true,
};

function attachPermissions(deps) {
  var loadUsers = deps.loadUsers;
  var saveUsers = deps.saveUsers;
  var findUserById = deps.findUserById;
  var canAccessRoom = deps.canAccessRoom;
  var getRoomRole = deps.getRoomRole;

  function getEffectivePermissions(user, osUsersMode) {
    // OS-mode users with linuxUser are exempt from RBAC (OS handles isolation)
    if (osUsersMode && user && user.linuxUser) return ALL_PERMISSIONS;
    // Admin always has full permissions
    if (user && user.role === "admin") return ALL_PERMISSIONS;
    // Merge stored permissions with defaults (handles missing keys for forward-compat)
    var stored = (user && user.permissions) || {};
    var result = {};
    var keys = Object.keys(DEFAULT_PERMISSIONS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      result[k] = stored[k] !== undefined ? stored[k] : DEFAULT_PERMISSIONS[k];
    }
    return result;
  }

  function updateUserPermissions(userId, permissions) {
    var data = loadUsers();
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].id === userId) {
        // Validate: only allow known permission keys with boolean values
        var clean = {};
        var keys = Object.keys(DEFAULT_PERMISSIONS);
        for (var j = 0; j < keys.length; j++) {
          var k = keys[j];
          clean[k] = permissions[k] === true;
        }
        data.users[i].permissions = clean;
        saveUsers(data);
        return { ok: true, permissions: clean };
      }
    }
    return { error: "User not found" };
  }

  // --- Project access helpers ---

  function canAccessProject(userId, project) {
    if (!project) return false;
    // Public projects are accessible to all authenticated users
    if (!project.visibility || project.visibility === "public") return true;
    // Admin always has access
    var user = findUserById(userId);
    if (user && user.role === "admin") return true;
    // Owner always has access to their own project
    if (project.ownerId && project.ownerId === userId) return true;
    // Private project -- check allowedUsers
    var allowed = project.allowedUsers || [];
    return allowed.indexOf(userId) >= 0;
  }

  function getAccessibleProjects(userId, projects) {
    if (!projects) return [];
    return projects.filter(function (p) {
      return canAccessProject(userId, p);
    });
  }

  // --- Session visibility helpers ---

  // A session is channel-bound when it carries a channelId of any type; a
  // malformed value is still channel-bound (and therefore fails closed).
  function isChannelBound(session) {
    return !!session && Object.prototype.hasOwnProperty.call(session, "channelId") &&
      session.channelId !== undefined && session.channelId !== null;
  }

  function nonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
  }

  // Shared gate for the personal-session predicates. Returns true only when
  // the project is accessible, the metadata is complete and consistent, and
  // the actor currently has access to the session's room. Owner/admin checks
  // run after this.
  function personalSessionBaseline(userId, session, project) {
    if (!nonEmptyString(userId)) return false;
    try {
      var currentUser = findUserById(userId);
      if (!currentUser || currentUser.disabled === true) return false;
    } catch (_) { return false; }
    if (!session || typeof session !== "object") return false;
    if (!canAccessProject(userId, project)) return false;
    if (!nonEmptyString(session.channelId) || !nonEmptyString(session.ownerId) ||
        !nonEmptyString(session.roomId) || session.sessionVisibility !== "private") return false;
    if (typeof canAccessRoom !== "function" || typeof getRoomRole !== "function") return false;
    try {
      return canAccessRoom(userId, session.roomId) === true && !!getRoomRole(userId, session.roomId);
    } catch (e) { return false; }
  }

  // Owner, or the current room administrator (server getRoomRole === "owner").
  function canReadPersonalSession(userId, session, project) {
    if (!personalSessionBaseline(userId, session, project)) return false;
    if (session.ownerId === userId) return true;
    try { return getRoomRole(userId, session.roomId) === "owner"; } catch (e) { return false; }
  }

  // Owner only; administrators get no mutation right on another member's session.
  function canMutatePersonalSession(userId, session, project) {
    if (!personalSessionBaseline(userId, session, project)) return false;
    return session.ownerId === userId;
  }

  function canAccessSession(userId, session, project) {
    // Channel-bound sessions never widen through the legacy path: only the
    // owner of a complete, consistent personal session passes here. Admin
    // reads must go through canReadPersonalSession.
    if (isChannelBound(session)) {
      return canMutatePersonalSession(userId, session, project);
    }
    // Must have project access first
    if (!canAccessProject(userId, project)) return false;
    var roomUser = findUserById(userId);
    // A room-bound session is never visible outside that room, even when it
    // is marked shared. Legacy unbound sessions remain admin/owner-only for
    // accountless guests so a new invitation cannot expose old workspace data.
    if (session.roomId) {
      if (!canAccessRoom || !canAccessRoom(userId, session.roomId)) return false;
    } else if (roomUser && roomUser.accountType === "invite_guest") {
      return session.ownerId === userId;
    }
    // Sessions without ownerId are legacy -- only admin can see them
    if (!session.ownerId) {
      var user = findUserById(userId);
      return !!(user && user.role === "admin");
    }
    // Owner can always see their own sessions
    if (session.ownerId === userId) return true;
    // Shared sessions are visible to all project members (default)
    if (!session.sessionVisibility || session.sessionVisibility === "shared") return true;
    // Private sessions are only visible to the owner
    return false;
  }

  return {
    getEffectivePermissions: getEffectivePermissions,
    updateUserPermissions: updateUserPermissions,
    canAccessProject: canAccessProject,
    getAccessibleProjects: getAccessibleProjects,
    canAccessSession: canAccessSession,
    canReadPersonalSession: canReadPersonalSession,
    canMutatePersonalSession: canMutatePersonalSession,
  };
}

module.exports = {
  DEFAULT_PERMISSIONS: DEFAULT_PERMISSIONS,
  ALL_PERMISSIONS: ALL_PERMISSIONS,
  attachPermissions: attachPermissions,
};
