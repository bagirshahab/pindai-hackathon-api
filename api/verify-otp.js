import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const MAX_ATTEMPTS = 5; // batas percobaan salah per kode

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
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    if (!body) body = {};

    const email = (body.email || "").trim().toLowerCase();
    const otpCode = (body.otp_code || "").trim();

    if (!email || !otpCode) {
      return res.status(400).json({ error: "Email and verification code are required." });
    }

    // Ambil OTP terbaru untuk email ini
    const rows = await sql`
      SELECT id, otp_code, expires_at, verified, attempts
      FROM email_otps
      WHERE email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const record = rows[0];

    if (!record) {
      return res.status(400).json({ error: "No verification code found. Please request a new code." });
    }

    if (record.verified) {
      return res.status(200).json({ success: true, message: "Email already verified." });
    }

    if (new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "The code has expired. Please request a new one." });
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts. Please request a new code." });
    }

    if (record.otp_code !== otpCode) {
      await sql`
        UPDATE email_otps SET attempts = attempts + 1 WHERE id = ${record.id}
      `;
      return res.status(400).json({ error: "Incorrect verification code." });
    }

    // Kode benar → tandai terverifikasi
    await sql`
      UPDATE email_otps SET verified = true WHERE id = ${record.id}
    `;

    return res.status(200).json({ success: true, message: "Email verified successfully." });
  } catch (err) {
    console.error("verify-otp error:", err);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}
