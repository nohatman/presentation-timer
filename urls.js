// Shared control/display link format - used by server.js (which knows the
// request's own host) and the CLI scripts (which use PUBLIC_URL instead).

function buildRoomLinks(baseUrl, room) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    controlUrl: `${base}/control?token=${room.control_token}`,
    displayUrl: `${base}/display?token=${room.display_token}`
  };
}

module.exports = { buildRoomLinks };
