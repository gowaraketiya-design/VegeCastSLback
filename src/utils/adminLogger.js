const db = require("../db");

async function logAdminAction({ req, admin_username, action, status, details }) {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const userAgent = req.headers["user-agent"] || null;

    await db.query(
      `INSERT INTO admin_logs (admin_username, action, details, status, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [admin_username, action, details || null, status, ip, userAgent]
    );
  } catch (err) {
    console.error("Failed to write admin log:", err);
    // Don't break the main request if logging fails
  }
}

module.exports = { logAdminAction };
