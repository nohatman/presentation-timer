// Shared control/display link format - used by server.js (which knows the
// request's own host) and the CLI scripts (which use PUBLIC_URL instead).

function buildRoomLinks(baseUrl, room) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    controlUrl: `${base}/control?token=${room.control_token}`,
    displayUrl: `${base}/display?token=${room.display_token}`,
    // View: the control page, watch-only (older callers' rows may not have one)
    ...(room.view_token ? { viewUrl: `${base}/control?token=${room.view_token}` } : {})
  };
}

module.exports = { buildRoomLinks };
