const mysql = require("mysql2/promise");

const pool = mysql.createPool(process.env.MYSQL_PUBLIC_URL);

// const pool = mysql.createPool({
//   host: process.env.DB_HOST,
//   port: Number(process.env.DB_PORT || 3306),
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,

//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
// });

// Test connection once at startup
(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log("Connected to DB");
  } catch (err) {
    console.error("DB connection failed:", err.message);
  }
})();

module.exports = pool;
