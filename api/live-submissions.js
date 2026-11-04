import { neon } from "@neondatabase/serverless";
import crypto from "crypto";

const sql = neon(process.env.DATABASE_URL);

// Batas jumlah baris agar respons tetap ringan.
const MAX_ROWS = 5000;

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-key");
}

// Perbandingan key yang aman dari timing attack.
function keyMatches(provided, expected) {
  const a = crypto.createHash("sha256").update(String(provided || "")).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });

  // Endpoint ini menampilkan data pribadi peserta (nama, email), jadi wajib dilindungi.
  // Jika DASHBOARD_KEY belum diset di Vercel, endpoint menolak semua request (fail closed).
  const expectedKey = process.env.DASHBOARD_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: "Dashboard is not configured." });
  }

  if (!keyMatches(req.headers["x-dashboard-key"], expectedKey)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    // READ-ONLY: hanya SELECT. ID asli tidak dikirim; diganti nomor urut (no).
    const rows = await sql`
      SELECT
        ROW_NUMBER() OVER (ORDER BY id ASC)::int AS no,
        full_name,
        email,
        project_title,
        project_theme,
        team_members,
        description,
        created_at
      FROM submissions
      ORDER BY id ASC
      LIMIT ${MAX_ROWS}
    `;

    return res.status(200).json({
      total: rows.length,
      submissions: rows,
    });
  } catch (err) {
    console.error("live-submissions error:", err);
    return res.status(500).json({ error: "Server error." });
  }
}
