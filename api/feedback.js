import { neon } from "@neondatabase/serverless";
import { Resend } from "resend";

const sql = neon(process.env.DATABASE_URL);
const resend = new Resend(process.env.RESEND_API_KEY);

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

    // 1. Simpan ke tabel feedback_submissions di Neon DB
    await sql`
      INSERT INTO feedback_submissions
        (full_name, email, q1_score, q2_score, q3_score, created_at)
      VALUES
        (${full_name.trim()}, ${email.trim()}, ${parseInt(q1_score)}, ${parseInt(q2_score)}, ${parseInt(q3_score)}, NOW())
    `;

    // 2. Kirim Email Konfirmasi/Terima Kasih via Resend
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || "AI For All Hackathon <no-reply@pindai.io>",
        to: email,
        subject: "Thank You for Your Feedback — AI For All Hackathon 2026",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; color: #111; border: 1px solid #1E293B; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #E60000; padding: 20px; text-align: center; color: #FFF;">
              <h2 style="margin: 0; letter-spacing: 1px;">AI FOR ALL HACKATHON</h2>
            </div>
            <div style="padding: 24px; background-color: #0A0E17; color: #F8FAFC;">
              <p>Hello <strong>${full_name}</strong>,</p>
              <p>Thank you for submitting your feedback for the AI For All Hackathon 2026 training session.</p>
              <p>We truly appreciate your insights and ratings, as they help us improve future programs and build a stronger AI community in Thailand.</p>
              <p style="margin-top: 24px; border-top: 1px solid #1E293B; padding-top: 16px;">Best regards,<br/><strong>AI For All Hackathon Committee</strong></p>
            </div>
          </div>
        `
      });
    } catch (emailErr) {
      console.error("Gagal mengirim email feedback:", emailErr);
    }

    return res.status(200).json({ success: true, message: "Feedback submitted successfully." });
  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
