import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

function setCorsHeaders(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  try {
    // Karena menggunakan application/json dari fetch frontend
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const { full_name, email, q1_score, q2_score, q3_score } = body;

    if (!full_name || !email || !q1_score || !q2_score || !q3_score) {
      return res.status(400).json({ error: "Please fill in all required fields and scores." });
    }

    // Simpan ke tabel feedback_submissions di Neon DB
    await sql`
      INSERT INTO feedback_submissions
        (full_name, email, q1_score, q2_score, q3_score, created_at)
      VALUES
        (${full_name.trim()}, ${email.trim()}, ${parseInt(q1_score)}, ${parseInt(q2_score)}, ${parseInt(q3_score)}, NOW())
    `;

    return res.status(200).json({ success: true, message: "Feedback submitted successfully." });
  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
